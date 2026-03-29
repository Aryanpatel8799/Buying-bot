import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardHistory from "@/lib/db/models/GiftCardHistory";

// GET /api/giftcards/history — list gift card addition history
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const history = await GiftCardHistory.find({ userId })
    .sort({ addedAt: -1 })
    .limit(200)
    .lean();

  // Mask card numbers for security
  const masked = history.map((h) => ({
    ...h,
    cardNumber: maskCardNumber(h.cardNumber),
    pin: "****",
  }));

  return NextResponse.json(masked);
}

function maskCardNumber(num: string): string {
  if (num.length <= 8) return num.slice(0, 2) + "****" + num.slice(-2);
  return num.slice(0, 4) + "****" + num.slice(-4);
}
