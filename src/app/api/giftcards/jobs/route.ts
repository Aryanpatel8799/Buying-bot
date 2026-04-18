import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardJob from "@/lib/db/models/GiftCardJob";

// GET /api/giftcards/jobs?kind=verify|add&limit=50
// Lists the current user's gift-card jobs (newest first) with summary counts.
// Logs and per-card results are NOT included — call /api/giftcards/jobs/[id]
// for the full record.
export async function GET(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

  await dbConnect();

  const filter: Record<string, unknown> = { userId };
  if (kind === "verify" || kind === "add") filter.kind = kind;

  const jobs = await GiftCardJob.find(filter)
    .select("_id kind platform status total completed failed skipped startedAt completedAt createdAt errorMessage")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return NextResponse.json(
    jobs.map((j) => ({
      jobId: String(j._id),
      kind: j.kind,
      platform: j.platform,
      status: j.status,
      total: j.total,
      completed: j.completed,
      failed: j.failed,
      skipped: j.skipped,
      errorMessage: j.errorMessage ?? null,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      createdAt: j.createdAt,
    }))
  );
}
