import { JobExecutor } from "./JobExecutor";
import { setExecutor, getAllExecutors } from "./jobRegistry";

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS || "3", 10);
const pendingQueue: string[] = [];

export async function enqueueJob(jobId: string): Promise<void> {
  const running = getAllExecutors().size;

  if (running < MAX_CONCURRENT) {
    await startJob(jobId);
  } else {
    pendingQueue.push(jobId);
    console.log(`Job ${jobId} queued. Position: ${pendingQueue.length}`);
  }
}

async function startJob(jobId: string): Promise<void> {
  const executor = new JobExecutor(jobId);
  setExecutor(jobId, executor);

  executor.on("done", () => {
    // Start next queued job if any
    if (pendingQueue.length > 0) {
      const nextJobId = pendingQueue.shift()!;
      startJob(nextJobId).catch((err) =>
        console.error(`Failed to start queued job ${nextJobId}:`, err)
      );
    }
  });

  await executor.start();
}

export function getQueuePosition(jobId: string): number {
  return pendingQueue.indexOf(jobId);
}

export function removeFromQueue(jobId: string): boolean {
  const idx = pendingQueue.indexOf(jobId);
  if (idx !== -1) {
    pendingQueue.splice(idx, 1);
    return true;
  }
  return false;
}
