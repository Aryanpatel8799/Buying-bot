import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { spawnTsx } from "@/lib/jobs/spawnTsx";
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

// POST /api/giftcards/check-balance — launch gift card balance checker
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

    const config = {
      chromeProfileDir,
      phoneNumber: data.phoneNumber,
      giftCards: data.giftCards,
    };

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    const child = spawnTsx("automation/features/giftCardBalanceChecker.ts", [configB64], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const logs: string[] = [];
    let completed = 0;
    let failed = 0;
    const balanceResults: { cardNumber: string; pin: string; balance: string; status: string }[] = [];
    let otpRequired = false;
    let loggedIn = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            logs.push(`[${msg.level.toUpperCase()}] ${msg.message}`);
          } else if (msg.type === "otp_required") {
            otpRequired = true;
          } else if (msg.type === "logged_in") {
            loggedIn = true;
          } else if (msg.type === "balance_result") {
            balanceResults.push({
              cardNumber: msg.cardNumber,
              pin: msg.pin,
              balance: msg.balance,
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
      console.error("[BalanceChecker stderr]", chunk.toString());
    });

    const result = await new Promise<{
      completed: number;
      failed: number;
      logs: string[];
      balanceResults: typeof balanceResults;
    }>((resolve) => {
      // Timeout sized for large batches (up to 5000 cards):
      //   base 10 min + 20s per card + 10 min headroom (includes OTP wait).
      // A 5000-card run ≈ 10min + 27.7h + 10min ≈ 28h. Relies on the Nginx
      // proxy_read_timeout being set high enough (see nginx conf).
      const timeoutMs = Math.max(600000, data.giftCards.length * 20000 + 600000);
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({
          completed,
          failed,
          logs: [...logs, `[ERROR] Process timed out (${Math.round(timeoutMs / 1000)}s)`],
          balanceResults,
        });
      }, timeoutMs);

      child.on("exit", () => {
        clearTimeout(timeout);
        resolve({ completed, failed, logs, balanceResults });
      });
    });

    return NextResponse.json({
      success: true,
      completed: result.completed,
      failed: result.failed,
      total: data.giftCards.length,
      logs: result.logs,
      balanceResults: result.balanceResults,
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
