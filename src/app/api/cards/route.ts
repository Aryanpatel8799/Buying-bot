import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import SavedCard from "@/lib/db/models/SavedCard";
import { encrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { z } from "zod";

const addCardSchema = z.object({
  cardNumber: z.string().min(13).max(19),
  expiryMonth: z.string().min(1).max(2),
  expiryYear: z.string().min(4).max(4),
  cvv: z.string().min(3).max(4),
  label: z.string().min(1).max(100),
});

// GET /api/cards — list user's saved cards (labels only, no card details)
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const cards = await SavedCard.find({ userId })
    .select("_id label createdAt")
    .sort({ createdAt: -1 })
    .lean();

  return NextResponse.json(cards);
}

// POST /api/cards — add a single card
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`cards:${userId}`, 20, 20 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = addCardSchema.parse(body);

    await dbConnect();
    const userId = (session.user as { id: string }).id;

    const expiry = `${data.expiryMonth.padStart(2, "0")}/${data.expiryYear}`;
    const cardNumber = data.cardNumber.replace(/\s/g, "");

    const encryptedDetails = encrypt(
      JSON.stringify({
        cardNumber,
        expiry,
        cvv: data.cvv,
      })
    );

    const card = await SavedCard.create({
      userId,
      label: data.label,
      encryptedDetails,
    });

    return NextResponse.json(
      { _id: card._id, label: card.label },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Add card error:", error);
    return NextResponse.json(
      { error: "Failed to add card" },
      { status: 500 }
    );
  }
}
