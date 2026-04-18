import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import GiftCardJob from "@/lib/db/models/GiftCardJob";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { spawnTsx } from "@/lib/jobs/spawnTsx";
import { cleanupStaleJobs } from "@/lib/jobs/startupCleanup";
import { z } from "zod";

const checkBalanceSchema = z.object({
  chromeProfileId: z.string(),
  phoneNumber: z
    .string()
    .min(10, "Phone number must be at least 10 digits")
    .transform((v) => v.replace(/[\s-]/g, "")),
  giftCards: z
    .array(
      z.object({
        cardNumber: z
          .string()
          .min(1, "Card number is required")
          .transform((v) => v.replace(/[\s-]/g, "")),
        pin: z
          .string()
          .min(1, "PIN is required"),
      })
    )
    .min(1, "At least one gift card is required")
    .max(5000, "Maximum 5000 gift cards per submission"),
});

// POST /api/giftcards/check-balance — queues a verify job, returns jobId.
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;

  // Rate limit: 20 requests per minute (each can carry up to 5000 cards)
  if (!checkRateLimit(`giftcards-balance:${userId}`, 20, 20 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = checkBalanceSchema.parse(body);

    await dbConnect();
    await cleanupStaleJobs();

    const profile = await ChromeProfile.findOne({
      _id: data.chromeProfileId,
      userId,
    });
    if (!profile) {
      return NextResponse.json(
        { error: "Chrome profile not found or doesn't belong to you" },
        { status: 400 }
      );
    }

    const chromeProfileDir = getProfileDir(profile.directoryName);

    // Create the GiftCardJob tracking record
    const job = await GiftCardJob.create({
      userId,
      kind: "verify",
      platform: "flipkart",
      status: "pending",
      total: data.giftCards.length,
    });

    const config = {
      jobId: String(job._id),
      chromeProfileDir,
      phoneNumber: data.phoneNumber,
      giftCards: data.giftCards,
    };

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    const child = spawnTsx("automation/features/giftCardBalanceChecker.ts", [configB64], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", async (err) => {
      console.error(`[GiftCardJob ${job._id}] failed to spawn balance checker:`, err);
      try {
        await GiftCardJob.updateOne(
          { _id: job._id },
          {
            status: "failed",
            errorMessage: `Failed to start runner: ${err.message}`,
            completedAt: new Date(),
          }
        );
      } catch { /* ignore */ }
    });
    child.unref();

    await GiftCardJob.updateOne(
      { _id: job._id },
      { pid: child.pid ?? null, startedAt: new Date() }
    );

    return NextResponse.json({
      success: true,
      jobId: String(job._id),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Gift card balance check error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
