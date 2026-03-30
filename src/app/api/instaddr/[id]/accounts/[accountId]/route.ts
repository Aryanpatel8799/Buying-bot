import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";

interface RouteParams {
  params: Promise<{ id: string; accountId: string }>;
}

// DELETE /api/instaddr/[id]/accounts/[accountId]
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, accountId } = await params;
  const userId = (session.user as { id: string }).id;

  await dbConnect();
  const group = await InstaDdrAccount.findOne({ _id: id, userId });

  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const accountIdx = group.accounts.findIndex(
    (a: any) => a._id.toString() === accountId
  );

  if (accountIdx === -1) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  group.accounts.splice(accountIdx, 1);
  await group.save();

  return NextResponse.json({ success: true });
}
