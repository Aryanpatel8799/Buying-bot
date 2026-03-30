import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { decrypt } from "@/lib/encryption";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/instaddr/[id]/export — download CSV
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;

  await dbConnect();
  const group = await InstaDdrAccount.findOne({ _id: id, userId }).lean();

  if (!group) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = ["instaDdrId,instaDdrPassword,email"];
  for (const a of group.accounts as any[]) {
    const instaDdrId = a.instaDdrId;
    let password = "****";
    try { password = decrypt(a.instaDdrPassword); } catch { /* keep masked */ }
    let email = "****";
    try { email = decrypt(a.email); } catch { /* keep masked */ }
    rows.push(`${instaDdrId},${password},${email}`);
  }

  const csv = rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });

  return new NextResponse(blob, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${group.label.replace(/[^a-zA-Z0-9_-]/g, "_")}_instaddr_accounts.csv"`,
    },
  });
}
