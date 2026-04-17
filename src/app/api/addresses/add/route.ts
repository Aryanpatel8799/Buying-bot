import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import SavedAddress from "@/lib/db/models/SavedAddress";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { spawnTsx } from "@/lib/jobs/spawnTsx";
import { z } from "zod";

const addressAddSchema = z.object({
  chromeProfileId: z.string().min(1, "Chrome profile is required"),
  addressId: z.string().min(1, "Address ID is required"),
});

// POST /api/addresses/add — launch address automation
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;

  if (!checkRateLimit(`addresses-add:${userId}`, 5, 5 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = addressAddSchema.parse(body);

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

    // Validate address belongs to user
    const address = await SavedAddress.findOne({
      _id: data.addressId,
      userId,
    });
    if (!address) {
      return NextResponse.json(
        { error: "Address not found or doesn't belong to you" },
        { status: 400 }
      );
    }

    const chromeProfileDir = getProfileDir(profile.directoryName);

    const config = {
      chromeProfileDir,
      address: {
        name: address.name,
        mobile: address.mobile,
        pincode: address.pincode,
        locality: address.locality,
        addressLine1: address.addressLine1,
        city: address.city,
        state: address.state,
        addressType: address.addressType,
        gstNumber: address.gstNumber,
        companyName: address.companyName,
      },
      addressId: data.addressId,
    };

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    const child = spawnTsx("automation/features/addressRunner.ts", [configB64], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const logs: string[] = [];
    let completed = 0;
    let failed = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            logs.push(`[${msg.level.toUpperCase()}] ${msg.message}`);
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
      console.error("[AddressRunner stderr]", chunk.toString());
    });

    const result = await new Promise<{ completed: number; failed: number; logs: string[] }>(
      (resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({
            completed,
            failed,
            logs: [...logs, "[ERROR] Process timed out (5 min)"],
          });
        }, 300000);

        child.on("exit", () => {
          clearTimeout(timeout);
          resolve({ completed, failed, logs });
        });
      }
    );

    return NextResponse.json({
      success: true,
      completed: result.completed,
      failed: result.failed,
      logs: result.logs,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Address add error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
