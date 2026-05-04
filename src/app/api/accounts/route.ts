import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import FlipkartAccount from "@/lib/db/models/FlipkartAccount";
import { encrypt, decrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { z } from "zod";

const addAccountSchema = z.object({
  email: z.string().email("Invalid email format"),
  label: z.string().min(1).max(100),
});

// GET /api/accounts — list user's Flipkart accounts (masked emails)
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const accounts = await FlipkartAccount.find({ userId })
    .select("_id label encryptedEmail createdAt")
    .sort({ createdAt: -1 })
    .lean();

  // Return BOTH the full email (for the dashboard list — masking made the
  // page hard to use) and the masked version (kept for any callers that
  // still depend on it).
  const masked = accounts.map((acc) => {
    let email = "";
    let maskedEmail = "***";
    try {
      email = decrypt(acc.encryptedEmail);
      const [user, domain] = email.split("@");
      maskedEmail = `${user[0]}${"*".repeat(Math.max(user.length - 2, 1))}${user.length > 1 ? user[user.length - 1] : ""}@${domain}`;
    } catch {
      // If decryption fails, leave defaults
    }
    return {
      _id: acc._id,
      label: acc.label,
      email,
      maskedEmail,
      createdAt: acc.createdAt,
    };
  });

  return NextResponse.json(masked);
}

// POST /api/accounts — add a single Flipkart account
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`accounts:${userId}`, 20, 20 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = addAccountSchema.parse(body);

    await dbConnect();
    const userId = (session.user as { id: string }).id;

    const encryptedEmail = encrypt(data.email);

    const account = await FlipkartAccount.create({
      userId,
      label: data.label,
      encryptedEmail,
    });

    return NextResponse.json(
      { _id: account._id, label: account.label },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Add account error:", error);
    return NextResponse.json(
      { error: "Failed to add account" },
      { status: 500 }
    );
  }
}
