import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import { enqueueJob } from "@/lib/jobs/JobQueue";
import { getExecutor } from "@/lib/jobs/jobRegistry";
import { cleanupStaleJobs } from "@/lib/jobs/startupCleanup";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;

  // Rate limit: 10 starts per minute
  if (!checkRateLimit(`jobs-start:${userId}`, 10, 10 / 60)) {
    return rateLimitResponse();
  }

  await dbConnect();
  await cleanupStaleJobs(); // Reset any jobs stuck in "running" from a previous crash
  const { jobId } = await params;

  // Atomic status update — prevents race condition where two requests
  // both read "pending" and both start the job
  const job = await Job.findOneAndUpdate(
    { _id: jobId, userId, status: { $in: ["pending", "failed", "cancelled"] } },
    { $set: { status: "running" } },
    { new: true }
  );

  if (!job) {
    // Could be not found, wrong user, or already running
    const existing = await Job.findOne({ _id: jobId, userId });
    if (!existing) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Job is already running or in a non-startable state" },
      { status: 400 }
    );
  }

  // Double-check executor registry — if already present, reject
  if (getExecutor(jobId)) {
    // Revert status since executor is already running
    await Job.updateOne({ _id: jobId }, { status: "running" });
    return NextResponse.json(
      { error: "Job is already running" },
      { status: 400 }
    );
  }

  try {
    await enqueueJob(jobId);
    return NextResponse.json({ message: "Job started" });
  } catch (error) {
    // Revert status on failure
    await Job.updateOne({ _id: jobId }, { status: "failed" });
    console.error("Start job error:", error);
    return NextResponse.json(
      { error: "Failed to start job" },
      { status: 500 }
    );
  }
}
