import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";

let cleaned = false;

/**
 * Reset any jobs stuck in "running" state (e.g., after server crash/restart).
 * Kills orphaned child processes by PID before resetting status.
 * Safe to call multiple times — only runs once.
 */
export async function cleanupStaleJobs(): Promise<void> {
  if (cleaned) return;
  cleaned = true;

  try {
    await dbConnect();

    // Find stale running jobs and kill their child processes
    const staleJobs = await Job.find({ status: "running" }).select("pid");
    for (const job of staleJobs) {
      if (job.pid) {
        try {
          process.kill(job.pid, "SIGKILL");
          console.log(`[Startup] Killed orphaned process PID ${job.pid} for job ${job._id}`);
        } catch {
          // Process already dead — that's fine
        }
      }
    }

    const result = await Job.updateMany(
      { status: "running" },
      {
        $set: {
          status: "failed",
          pid: null,
          completedAt: new Date(),
        },
      }
    );
    if (result.modifiedCount > 0) {
      console.log(
        `[Startup] Reset ${result.modifiedCount} stale running job(s) to failed`
      );
    }
  } catch (err) {
    console.error("[Startup] Failed to cleanup stale jobs:", err);
  }
}
