import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardJob from "@/lib/db/models/GiftCardJob";

// GET /api/giftcards/jobs/[id] — current snapshot of a gift-card job
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  const { id } = await params;

  await dbConnect();
  const job = await GiftCardJob.findOne({ _id: id, userId }).lean();
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({
    jobId: String(job._id),
    kind: job.kind,
    platform: job.platform,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    cardStatuses: job.cardStatuses,
    logs: job.logs,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
}
