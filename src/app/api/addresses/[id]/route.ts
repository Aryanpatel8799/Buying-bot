import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import SavedAddress from "@/lib/db/models/SavedAddress";

type RouteContext = { params: Promise<{ id: string }> };

// DELETE /api/addresses/[id] — delete a saved address
export async function DELETE(_req: NextRequest, context: RouteContext) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const userId = (session.user as { id: string }).id;

  await dbConnect();

  const result = await SavedAddress.findOneAndDelete({ _id: id, userId });

  if (!result) {
    return NextResponse.json(
      { error: "Address not found or doesn't belong to you" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
