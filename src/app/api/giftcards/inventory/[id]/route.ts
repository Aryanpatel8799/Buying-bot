import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";
import { z } from "zod";

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/giftcards/inventory/[id] — get single inventory with codes
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;
  await dbConnect();

  const inventory = await GiftCardInventory.findOne({ _id: id, userId }).lean();
  if (!inventory) {
    return NextResponse.json({ error: "Inventory not found" }, { status: 404 });
  }

  const available = inventory.codes.filter((c) => c.status === "available").length;
  const used = inventory.codes.filter((c) => c.status === "used").length;
  const failed = inventory.codes.filter((c) => c.status === "failed").length;

  return NextResponse.json({
    _id: inventory._id,
    name: inventory.name,
    platform: inventory.platform,
    codes: inventory.codes,
    totalCodes: inventory.codes.length,
    available,
    used,
    failed,
    createdAt: inventory.createdAt,
    updatedAt: inventory.updatedAt,
  });
}

// DELETE /api/giftcards/inventory/[id] — delete entire inventory
export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;
  await dbConnect();

  const result = await GiftCardInventory.deleteOne({ _id: id, userId });
  if (result.deletedCount === 0) {
    return NextResponse.json({ error: "Inventory not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

const addCodeSchema = z.object({
  code: z.string().min(1),
  pin: z.string().default(""),
});

// POST /api/giftcards/inventory/[id]/codes — add a single code
export async function POST(req: NextRequest, { params }: Params) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;
  await dbConnect();

  // Check ownership
  const inventory = await GiftCardInventory.findOne({ _id: id, userId });
  if (!inventory) {
    return NextResponse.json({ error: "Inventory not found" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const data = addCodeSchema.parse(body);

    inventory.codes.push({
      code: data.code,
      pin: data.pin,
      status: "available",
      addedAt: new Date(),
    });
    await inventory.save();

    return NextResponse.json({ success: true, totalCodes: inventory.codes.length }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", details: error.issues }, { status: 400 });
    }
    console.error("Add code error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
