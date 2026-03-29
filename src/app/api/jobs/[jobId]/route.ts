import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";

// GET /api/jobs/[jobId]
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const { jobId } = await params;
  const userId = (session.user as { id: string }).id;

  const job = await Job.findOne({ _id: jobId, userId })
    .populate("chromeProfileId", "name platform")
    .lean();

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json(job);
}

// DELETE /api/jobs/[jobId]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const { jobId } = await params;
  const userId = (session.user as { id: string }).id;

  const job = await Job.findOne({ _id: jobId, userId });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status === "running") {
    return NextResponse.json(
      { error: "Cannot delete a running job. Stop it first." },
      { status: 400 }
    );
  }

  await Job.deleteOne({ _id: jobId });
  return NextResponse.json({ message: "Job deleted" });
}
