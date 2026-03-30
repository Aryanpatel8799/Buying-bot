import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/giftcards/inventory/[id]/export — download CSV with status column
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

  // Build CSV: code,pin,status,errorMessage,addedAt,usedAt
  const lines: string[] = ["code,pin,status,errorMessage,addedAt,usedAt"];

  for (const entry of inventory.codes) {
    const escape = (s: string | undefined) => {
      const str = String(s ?? "");
      // Escape quotes and wrap in quotes if needed
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    lines.push(
      [
        escape(entry.code),
        escape(entry.pin),
        entry.status,
        escape(entry.errorMessage),
        entry.addedAt ? entry.addedAt.toISOString() : "",
        entry.usedAt ? entry.usedAt.toISOString() : "",
      ].join(",")
    );
  }

  const csvText = lines.join("\n");
  const filename = `${inventory.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${inventory.platform}_${Date.now()}.csv`;

  return new NextResponse(csvText, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
