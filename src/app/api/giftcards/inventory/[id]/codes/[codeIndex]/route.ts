import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";

interface Params {
  params: Promise<{ id: string; codeIndex: string }>;
}

// DELETE /api/giftcards/inventory/[id]/codes/[codeIndex] — delete a single code by index
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, codeIndex: indexStr } = await params;
  const userId = (session.user as { id: string }).id;
  await dbConnect();

  const inventory = await GiftCardInventory.findOne({ _id: id, userId });
  if (!inventory) {
    return NextResponse.json({ error: "Inventory not found" }, { status: 404 });
  }

  const idx = parseInt(indexStr, 10);
  if (isNaN(idx) || idx < 0 || idx >= inventory.codes.length) {
    return NextResponse.json({ error: "Invalid code index" }, { status: 400 });
  }

  inventory.codes.splice(idx, 1);
  await inventory.save();

  return NextResponse.json({ success: true, totalCodes: inventory.codes.length });
}
