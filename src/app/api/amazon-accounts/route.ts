import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import AmazonAccount from "@/lib/db/models/AmazonAccount";
import { encrypt, decrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { z } from "zod";

const addAccountSchema = z.object({
  email: z
    .string()
    .min(1, "Email or phone is required")
    .max(200, "Too long"),
  password: z.string().min(1, "Password is required").max(500, "Password is too long"),
  label: z.string().min(1).max(100),
});

// GET /api/amazon-accounts — list (masked email; password never returned)
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const accounts = await AmazonAccount.find({ userId })
    .select("_id label encryptedEmail createdAt")
    .sort({ createdAt: -1 })
    .lean();

  // Return BOTH the full email/phone (for the dashboard) and the masked
  // version. UI now defaults to showing the full value because the masking
  // made the list unsearchable / unreadable.
  const masked = accounts.map((acc) => {
    let email = "";
    let maskedEmail = "***";
    try {
      email = decrypt(acc.encryptedEmail);
      if (email.includes("@")) {
        const [user, domain] = email.split("@");
        maskedEmail = `${user[0]}${"*".repeat(Math.max(user.length - 2, 1))}${user.length > 1 ? user[user.length - 1] : ""}@${domain}`;
      } else {
        const last4 = email.slice(-4);
        maskedEmail = `${"*".repeat(Math.max(email.length - 4, 1))}${last4}`;
      }
    } catch { /* keep defaults */ }
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

// POST /api/amazon-accounts — add a single Amazon account
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`amazon-accounts:${userId}`, 20, 20 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = addAccountSchema.parse(body);

    await dbConnect();

    const account = await AmazonAccount.create({
      userId,
      label: data.label.trim(),
      encryptedEmail: encrypt(data.email.trim()),
      encryptedPassword: encrypt(data.password),
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
    console.error("Add Amazon account error:", error);
    return NextResponse.json(
      { error: "Failed to add account" },
      { status: 500 }
    );
  }
}
