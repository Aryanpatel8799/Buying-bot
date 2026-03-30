import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";
import { z } from "zod";

interface Params {
  params: Promise<{ id: string; codeIndex: string }>;
}

const updateCodeSchema = z.object({
  status: z.enum(["available", "used", "failed"]),
  errorMessage: z.string().optional(),
  balance: z.number().optional(),
});

// PATCH /api/giftcards/inventory/[id]/codes/[codeIndex]/status — update code status
export async function PATCH(req: NextRequest, { params }: Params) {
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

  try {
    const body = await req.json();
    const data = updateCodeSchema.parse(body);

    const code = inventory.codes[idx];
    code.status = data.status;
    if (data.errorMessage !== undefined) code.errorMessage = data.errorMessage;
    if (data.balance !== undefined) code.balance = data.balance;
    if (data.status === "used" && !code.usedAt) code.usedAt = new Date();

    await inventory.save();

    return NextResponse.json({ success: true, code });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", details: error.issues }, { status: 400 });
    }
    console.error("Update code status error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
