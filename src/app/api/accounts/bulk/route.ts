import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import FlipkartAccount from "@/lib/db/models/FlipkartAccount";
import { encrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

// POST /api/accounts/bulk — upload multiple accounts from CSV
// CSV format: email or email,label (one per line)
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`accounts-bulk:${userId}`, 5, 5 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const csvText = body.csv as string;

    if (!csvText || typeof csvText !== "string") {
      return NextResponse.json(
        { error: "Missing csv field" },
        { status: 400 }
      );
    }

    await dbConnect();
    const userId = (session.user as { id: string }).id;

    const lines = csvText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.toLowerCase().startsWith("email"));

    const accounts: Array<{
      userId: typeof userId;
      label: string;
      encryptedEmail: string;
    }> = [];
    const errors: string[] = [];

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.trim());
      const email = parts[0];
      const label = parts[1] || email;

      if (!emailRegex.test(email)) {
        errors.push(`Row ${i + 1}: Invalid email format "${email}"`);
        continue;
      }

      accounts.push({
        userId,
        label,
        encryptedEmail: encrypt(email),
      });
    }

    let inserted = 0;
    if (accounts.length > 0) {
      const result = await FlipkartAccount.insertMany(accounts);
      inserted = result.length;
    }

    return NextResponse.json({
      inserted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Bulk account upload error:", error);
    return NextResponse.json(
      { error: "Failed to process CSV" },
      { status: 500 }
    );
  }
}
