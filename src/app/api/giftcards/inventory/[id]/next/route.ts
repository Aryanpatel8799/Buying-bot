import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/giftcards/inventory/[id]/next — get the next available code and mark it as used
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;
  await dbConnect();

  const inventory = await GiftCardInventory.findOne({ _id: id, userId });
  if (!inventory) {
    return NextResponse.json({ error: "Inventory not found" }, { status: 404 });
  }

  // Find first available code
  const availableIdx = inventory.codes.findIndex((c) => c.status === "available");
  if (availableIdx === -1) {
    return NextResponse.json({ error: "No available codes in this inventory" }, { status: 404 });
  }

  const code = inventory.codes[availableIdx];

  return NextResponse.json({
    codeIndex: availableIdx,
    code: code.code,
    pin: code.pin,
    balance: code.balance,
    status: code.status,
  });
}
