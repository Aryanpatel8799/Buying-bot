import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import { getExecutor } from "@/lib/jobs/jobRegistry";
import { removeFromQueue } from "@/lib/jobs/JobQueue";

export async function POST(
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

  // Try to remove from queue first
  if (removeFromQueue(jobId)) {
    await Job.updateOne({ _id: jobId }, { status: "cancelled" });
    return NextResponse.json({ message: "Job removed from queue" });
  }

  // Stop running executor
  const executor = getExecutor(jobId);
  if (executor) {
    await executor.stop();
    return NextResponse.json({ message: "Job stopped" });
  }

  return NextResponse.json(
    { error: "Job is not running or queued" },
    { status: 400 }
  );
}
