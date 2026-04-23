import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import GiftCardHistory from "@/lib/db/models/GiftCardHistory";
import FlipkartAccount from "@/lib/db/models/FlipkartAccount";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import GiftCardJob from "@/lib/db/models/GiftCardJob";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { encrypt, decrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { spawnTsx } from "@/lib/jobs/spawnTsx";
import { cleanupStaleJobs } from "@/lib/jobs/startupCleanup";
import { z } from "zod";

const giftCardSchema = z.object({
  chromeProfileId: z.string(),
  platform: z.enum(["flipkart", "amazon"]).default("flipkart"),
  accountId: z.string().optional(),
  instaDdrAccountId: z.string().optional(),
  giftCards: z
    .array(
      z.object({
        cardNumber: z
          .string()
          .min(1, "Card number is required")
          .transform((v) => v.replace(/[\s-]/g, "")),
        pin: z
          .string()
          .default(""),
      })
    )
    .min(1, "At least one gift card is required")
    .max(5000, "Maximum 5000 gift cards per submission"),
});

// POST /api/giftcards/add — queues a gift-card-add job and returns a jobId.
// The client polls/streams /api/giftcards/jobs/[id]/stream for progress.
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;

  // Rate limit: 20 requests per minute (each can carry up to 5000 cards)
  if (!checkRateLimit(`giftcards-add:${userId}`, 20, 20 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = giftCardSchema.parse(body);

    await dbConnect();
    await cleanupStaleJobs();

    // Validate chrome profile
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

    // Check for duplicates — find cards already successfully added
    const existingCards = await GiftCardHistory.find({
      userId,
      cardNumber: { $in: data.giftCards.map((gc) => gc.cardNumber) },
      status: "success",
    }).select("cardNumber");

    const alreadyAdded = new Set(existingCards.map((c) => c.cardNumber));
    const skipped: string[] = [];
    const toAdd = data.giftCards.filter((gc) => {
      if (alreadyAdded.has(gc.cardNumber)) {
        skipped.push(gc.cardNumber);
        return false;
      }
      return true;
    });

    // Seed the job record with statuses for already-added cards + initial logs
    const seedCardStatuses = Array.from(alreadyAdded).map((cn) => ({
      cardNumber: cn,
      status: "added" as const,
    }));
    const seedLogs = skipped.map((cn) => ({
      level: "info" as const,
      message: `Skipped ${cn.slice(0, 4)}****${cn.slice(-4)} — already added successfully`,
      at: new Date(),
    }));

    if (toAdd.length === 0) {
      // Nothing to process — create a completed job for consistent client UX
      const job = await GiftCardJob.create({
        userId,
        kind: "add",
        platform: data.platform,
        status: "completed",
        total: data.giftCards.length,
        completed: 0,
        failed: 0,
        skipped: skipped.length,
        cardStatuses: seedCardStatuses,
        logs: seedLogs,
        startedAt: new Date(),
        completedAt: new Date(),
      });
      return NextResponse.json({
        success: true,
        jobId: String(job._id),
        message: "All gift cards have already been added",
      });
    }

    // Create pending history entries with encrypted PINs (for duplicate detection later)
    const historyEntries = await GiftCardHistory.insertMany(
      toAdd.map((gc) => ({
        userId,
        cardNumber: gc.cardNumber,
        encryptedPin: encrypt(gc.pin || ""),
        status: "pending",
        chromeProfileId: data.chromeProfileId,
        platform: data.platform,
      }))
    );

    const chromeProfileDir = getProfileDir(profile.directoryName);

    // Optional: decrypt the chosen Flipkart account email for login
    let accountEmail: string | undefined;
    if (data.accountId && data.platform === "flipkart") {
      const account = await FlipkartAccount.findOne({ _id: data.accountId, userId });
      if (!account) {
        return NextResponse.json(
          { error: "Selected Flipkart account not found or doesn't belong to you" },
          { status: 400 }
        );
      }
      try {
        accountEmail = decrypt(account.encryptedEmail);
      } catch {
        return NextResponse.json(
          { error: "Selected account is corrupt and could not be decrypted" },
          { status: 400 }
        );
      }
    }

    // Optional: decrypt InstaDDR group accounts for OTP automation
    let instaDdrAccounts:
      | { instaDdrId: string; instaDdrPassword: string; email: string }[]
      | undefined;
    if (data.instaDdrAccountId && data.platform === "flipkart") {
      const group = await InstaDdrAccount.findOne({ _id: data.instaDdrAccountId, userId }).lean();
      if (!group) {
        return NextResponse.json(
          { error: "Selected InstaDDR group not found or doesn't belong to you" },
          { status: 400 }
        );
      }
      const decoded: { instaDdrId: string; instaDdrPassword: string; email: string }[] = [];
      for (const a of ((group as { accounts?: unknown[] }).accounts ?? []) as Array<{
        instaDdrId: string;
        instaDdrPassword: string;
        email: string;
      }>) {
        try {
          decoded.push({
            instaDdrId: a.instaDdrId,
            instaDdrPassword: decrypt(a.instaDdrPassword),
            email: decrypt(a.email),
          });
        } catch {
          /* skip corrupt */
        }
      }
      if (decoded.length > 0) instaDdrAccounts = decoded;
    }

    // Create the GiftCardJob tracking record
    const job = await GiftCardJob.create({
      userId,
      kind: "add",
      platform: data.platform,
      status: "pending",
      total: data.giftCards.length,
      completed: 0,
      failed: 0,
      skipped: skipped.length,
      cardStatuses: seedCardStatuses,
      logs: seedLogs,
      historyIds: historyEntries.map((h) => h._id.toString()),
    });

    const config = {
      jobId: String(job._id),
      chromeProfileDir,
      platform: data.platform,
      giftCards: toAdd,
      historyIds: historyEntries.map((h) => h._id.toString()),
      batchSize: 100,
      maxRetries: 3,
      cardTimeoutMs: 45000,
      ...(accountEmail ? { account: accountEmail } : {}),
      ...(instaDdrAccounts && instaDdrAccounts.length > 0 ? { instaDdrAccounts } : {}),
      ...(profile.gmailAddress ? { gmailAddress: profile.gmailAddress } : {}),
    };

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    // Spawn the runner detached — it writes progress to the DB itself.
    // Parent won't wait for it; closing the browser tab or restarting Next.js
    // does NOT abort the run.
    const child = spawnTsx("automation/features/giftCardRunner.ts", [configB64], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", async (err) => {
      console.error(`[GiftCardJob ${job._id}] failed to spawn runner:`, err);
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
    console.error("Gift card add error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
