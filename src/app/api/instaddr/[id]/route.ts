import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { encrypt, decrypt } from "@/lib/encryption";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// instaDdrId / instaDdrPassword are now ignored at the UI layer — emails are
// the only thing the bot uses (it logs into Gmail via the Chrome profile to
// fetch OTPs, not into InstaDDR directly). Keep them optional in the schema
// so old clients still work; default to "".
const addAccountSchema = z.object({
  instaDdrId: z.string().optional().default(""),
  instaDdrPassword: z.string().optional().default(""),
  email: z.string().email(),
});

// GET /api/instaddr/[id] — get single group with all accounts (masked)
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;

  await dbConnect();
  const group = await InstaDdrAccount.findOne({ _id: id, userId }).lean();

  if (!group) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Return the FULL email — masking made the dashboard list unreadable.
  // instaDdrId / instaDdrPassword are still in the schema but no longer
  // shown in the UI; we omit them from the response to keep payloads small.
  const accounts = group.accounts.map((a: { _id: { toString: () => string }; email: string; createdAt: Date }) => {
    let email = "";
    try { email = decrypt(a.email); } catch { email = "(decrypt error)"; }
    return {
      _id: a._id.toString(),
      email,
      createdAt: a.createdAt,
    };
  });

  return NextResponse.json({
    _id: group._id.toString(),
    label: group.label,
    platform: group.platform,
    accounts,
    totalAccounts: accounts.length,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  });
}

// DELETE /api/instaddr/[id] — delete entire group
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;

  await dbConnect();
  const deleted = await InstaDdrAccount.findOneAndDelete({ _id: id, userId });

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

// POST /api/instaddr/[id] — add a single account to the group
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;

  try {
    const body = await req.json();
    const data = addAccountSchema.parse(body);

    await dbConnect();

    // Verify group belongs to user
    const group = await InstaDdrAccount.findOne({ _id: id, userId });
    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }

    // Check for duplicate email
    const duplicate = group.accounts.find((a: any) => {
      try {
        const storedEmail = decrypt(a.email);
        return storedEmail.toLowerCase() === data.email.toLowerCase();
      } catch {
        return false;
      }
    });
    if (duplicate) {
      return NextResponse.json({ error: "Email already exists in this group" }, { status: 400 });
    }

    const newAccount = {
      _id: new (require("mongoose").Types.ObjectId)(),
      instaDdrId: data.instaDdrId,
      instaDdrPassword: encrypt(data.instaDdrPassword),
      email: encrypt(data.email.toLowerCase()),
      createdAt: new Date(),
    };

    group.accounts.push(newAccount as any);
    await group.save();

    return NextResponse.json(
      {
        _id: (newAccount._id as any).toString(),
        email: data.email,
        createdAt: newAccount.createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Add InstaDDR account error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
