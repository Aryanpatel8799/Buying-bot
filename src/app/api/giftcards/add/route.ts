import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import GiftCardHistory from "@/lib/db/models/GiftCardHistory";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { encrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { spawn } from "child_process";
import { z } from "zod";

const giftCardSchema = z.object({
  chromeProfileId: z.string(),
  platform: z.enum(["flipkart", "amazon"]).default("flipkart"),
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
    .min(1, "At least one gift card is required"),
});

// POST /api/giftcards/add — launch gift card adder automation
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;

  // Rate limit: 5 requests per minute
  if (!checkRateLimit(`giftcards-add:${userId}`, 5, 5 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = giftCardSchema.parse(body);

    await dbConnect();

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
        skipped.push(gc.cardNumber.slice(0, 4) + "****" + gc.cardNumber.slice(-4));
        return false;
      }
      return true;
    });

    if (toAdd.length === 0) {
      return NextResponse.json({
        success: true,
        completed: 0,
        failed: 0,
        skipped: skipped.length,
        total: data.giftCards.length,
        logs: skipped.map((c) => `[INFO] Skipped ${c} — already added successfully`),
        cardStatuses: [],
        message: "All gift cards have already been added to your account",
      });
    }

    // Create pending history entries with encrypted PINs
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

    const config = {
      chromeProfileDir,
      platform: data.platform,
      giftCards: toAdd,
      historyIds: historyEntries.map((h) => h._id.toString()),
    };

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    // Spawn the gift card runner
    const child = spawn("npx", ["tsx", "automation/features/giftCardRunner.ts", configB64], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      detached: true,
    });

    // Collect output
    const logs: string[] = skipped.map(
      (c) => `[INFO] Skipped ${c} — already added successfully`
    );
    let completed = 0;
    let failed = 0;
    const progressResults: { index: number; status: "success" | "failed"; error?: string }[] = [];
    const cardStatuses: { cardNumber: string; status: "added" | "not added" }[] = [];

    // Add skipped card statuses
    for (const gc of data.giftCards) {
      if (alreadyAdded.has(gc.cardNumber)) {
        cardStatuses.push({ cardNumber: gc.cardNumber, status: "added" });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            logs.push(`[${msg.level.toUpperCase()}] ${msg.message}`);
          } else if (msg.type === "progress") {
            progressResults.push({
              index: msg.iteration - 1,
              status: msg.status === "success" ? "success" : "failed",
              error: msg.error,
            });
          } else if (msg.type === "card_status") {
            cardStatuses.push({
              cardNumber: msg.cardNumber,
              status: msg.status,
            });
          } else if (msg.type === "done") {
            completed = msg.completed;
            failed = msg.failed;
          }
        } catch {
          logs.push(line);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error("[GiftCardRunner stderr]", chunk.toString());
    });

    // Wait for process to finish
    const result = await new Promise<{
      completed: number;
      failed: number;
      logs: string[];
    }>((resolve) => {
      // Timeout: 5 min base + 3s per card (for large batches)
      const timeoutMs = Math.max(300000, toAdd.length * 3000 + 60000);
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({
          completed,
          failed,
          logs: [...logs, `[ERROR] Process timed out (${Math.round(timeoutMs / 1000)}s)`],
        });
      }, timeoutMs);

      child.on("exit", () => {
        clearTimeout(timeout);
        resolve({ completed, failed, logs });
      });
    });

    // Update history entries with results
    for (const pr of progressResults) {
      if (pr.index < historyEntries.length) {
        await GiftCardHistory.updateOne(
          { _id: historyEntries[pr.index]._id },
          {
            status: pr.status,
            errorMessage: pr.error || "",
            addedAt: new Date(),
          }
        );
      }
    }

    // Mark any remaining pending entries as failed
    await GiftCardHistory.updateMany(
      {
        _id: { $in: historyEntries.map((h) => h._id) },
        status: "pending",
      },
      { status: "failed", errorMessage: "Process ended before card was processed" }
    );

    return NextResponse.json({
      success: true,
      completed: result.completed,
      failed: result.failed,
      skipped: skipped.length,
      total: data.giftCards.length,
      logs: result.logs,
      cardStatuses,
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
