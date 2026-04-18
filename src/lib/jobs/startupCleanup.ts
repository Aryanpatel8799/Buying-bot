import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import GiftCardJob from "@/lib/db/models/GiftCardJob";

let cleaned = false;

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't kill — just checks whether the PID is reachable.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

    // ── Buying Jobs ──────────────────────────────────────────────────────
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

    // ── Gift Card Jobs (detached runner children) ────────────────────────
    // These runners are started with `detached: true` + `unref()`. They
    // survive parent restarts. Only mark a job as stale if its PID is
    // definitely gone, otherwise leave it alone — the runner will update
    // it on its own schedule.
    const staleGiftCardJobs = await GiftCardJob.find({
      status: { $in: ["pending", "running"] },
    }).select("pid _id");

    let gcReset = 0;
    for (const gcJob of staleGiftCardJobs) {
      // No PID recorded = never started correctly, safe to fail
      // PID recorded but not alive = orphaned, safe to fail
      // PID recorded and alive = runner is still going, don't touch
      if (!gcJob.pid || !isProcessAlive(gcJob.pid)) {
        await GiftCardJob.updateOne(
          { _id: gcJob._id },
          {
            $set: {
              status: "failed",
              pid: null,
              completedAt: new Date(),
              errorMessage: "Runner process was terminated before job completed",
            },
          }
        );
        gcReset++;
      }
    }
    if (gcReset > 0) {
      console.log(`[Startup] Reset ${gcReset} stale gift-card job(s) to failed`);
    }
  } catch (err) {
    console.error("[Startup] Failed to cleanup stale jobs:", err);
  }
}
