import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import SavedCard from "@/lib/db/models/SavedCard";
import { encrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

// POST /api/cards/bulk — upload multiple cards from CSV
// CSV format: cardNumber,MM/YYYY,cvv,label
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 5 requests per minute
  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`cards-bulk:${userId}`, 5, 5 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const csvText = body.csv as string;

    if (!csvText || typeof csvText !== "string") {
      return NextResponse.json(
        { error: "Missing csv field" },
        { status: 400 }
      );
    }

    await dbConnect();
    const userId = (session.user as { id: string }).id;

    const lines = csvText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.toLowerCase().startsWith("cardnumber"));

    const cards: Array<{
      userId: typeof userId;
      label: string;
      encryptedDetails: string;
    }> = [];
    const errors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.trim());
      if (parts.length < 4) {
        errors.push(`Row ${i + 1}: Expected 4 columns (cardNumber,expiry,cvv,label)`);
        continue;
      }

      const [cardNumber, expiry, cvv, ...labelParts] = parts;
      const label = labelParts.join(","); // In case label contains commas

      // Basic validation
      const cleanCard = cardNumber.replace(/\s/g, "");
      if (cleanCard.length < 13 || cleanCard.length > 19) {
        errors.push(`Row ${i + 1}: Invalid card number length`);
        continue;
      }
      if (!/^\d{2}\/\d{4}$/.test(expiry)) {
        errors.push(`Row ${i + 1}: Invalid expiry format (expected MM/YYYY)`);
        continue;
      }
      if (cvv.length < 3 || cvv.length > 4) {
        errors.push(`Row ${i + 1}: Invalid CVV`);
        continue;
      }

      cards.push({
        userId,
        label: label || `Card ending ${cleanCard.slice(-4)}`,
        encryptedDetails: encrypt(
          JSON.stringify({ cardNumber: cleanCard, expiry, cvv })
        ),
      });
    }

    let inserted = 0;
    if (cards.length > 0) {
      const result = await SavedCard.insertMany(cards);
      inserted = result.length;
    }

    return NextResponse.json({
      inserted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Bulk card upload error:", error);
    return NextResponse.json(
      { error: "Failed to process CSV" },
      { status: 500 }
    );
  }
}
