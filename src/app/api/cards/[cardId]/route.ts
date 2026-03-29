import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import SavedCard from "@/lib/db/models/SavedCard";

// DELETE /api/cards/[cardId]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const { cardId } = await params;
  const userId = (session.user as { id: string }).id;

  const deleted = await SavedCard.findOneAndDelete({ _id: cardId, userId });
  if (!deleted) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }

  return NextResponse.json({ message: "Card deleted" });
}
