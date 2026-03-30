import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { encrypt, decrypt } from "@/lib/encryption";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const addAccountSchema = z.object({
  instaDdrId: z.string().min(1),
  instaDdrPassword: z.string().min(1),
  email: z.string().email(),
});

function mask(str: string, showChars = 2): string {
  if (str.length <= showChars * 2 + 3) return str[0] + "****" + str.slice(-showChars);
  return str.slice(0, showChars) + "****" + str.slice(-showChars);
}

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

  const accounts = group.accounts.map((a: any) => {
    let email = "";
    try { email = decrypt(a.email); } catch { email = "(decrypt error)"; }
    return {
      _id: a._id.toString(),
      instaDdrId: mask(a.instaDdrId, 2),
      instaDdrPassword: "****",
      email: email ? mask(email, 2) : "****",
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
        instaDdrId: mask(data.instaDdrId, 2),
        instaDdrPassword: "****",
        email: mask(data.email, 2),
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
