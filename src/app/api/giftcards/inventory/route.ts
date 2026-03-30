import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";
import { z } from "zod";

const createInventorySchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(["flipkart", "amazon"]),
});

// GET /api/giftcards/inventory — list all user inventories
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  await dbConnect();

  const inventories = await GiftCardInventory.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  // Return summary with code counts per status
  const summary = inventories.map((inv) => {
    const available = inv.codes.filter((c) => c.status === "available").length;
    const used = inv.codes.filter((c) => c.status === "used").length;
    const failed = inv.codes.filter((c) => c.status === "failed").length;
    return {
      _id: inv._id,
      name: inv.name,
      platform: inv.platform,
      totalCodes: inv.codes.length,
      available,
      used,
      failed,
      createdAt: inv.createdAt,
      updatedAt: inv.updatedAt,
    };
  });

  return NextResponse.json(summary);
}

// POST /api/giftcards/inventory — create a new inventory list
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createInventorySchema.parse(body);

    const userId = (session.user as { id: string }).id;
    await dbConnect();

    const inventory = await GiftCardInventory.create({
      userId,
      name: data.name,
      platform: data.platform,
      codes: [],
    });

    return NextResponse.json(
      {
        _id: inventory._id,
        name: inventory.name,
        platform: inventory.platform,
        totalCodes: 0,
        available: 0,
        used: 0,
        failed: 0,
        createdAt: inventory.createdAt,
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
    console.error("Create inventory error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
