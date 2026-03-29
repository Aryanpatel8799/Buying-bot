import { NextRequest } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import { getExecutor } from "@/lib/jobs/jobRegistry";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  await dbConnect();
  const { jobId } = await params;
  const userId = (session.user as { id: string }).id;

  const job = await Job.findOne({ _id: jobId, userId });
  if (!job) {
    return new Response("Job not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  // Track cleanup function so cancel() can call it when client disconnects
  let cleanupFn: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Send current job state immediately
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "state", job: job.toObject() })}\n\n`
        )
      );

      const executor = getExecutor(jobId);
      if (!executor) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "closed", reason: "Job not running" })}\n\n`
          )
        );
        controller.close();
        return;
      }

      const onProgress = (msg: object) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "progress", ...msg })}\n\n`)
          );
        } catch {
          cleanup();
        }
      };

      const onLog = (msg: object) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "log", ...msg })}\n\n`)
          );
        } catch {
          cleanup();
        }
      };

      const onWaitingForOtp = (msg: object) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "waiting_for_otp", ...msg })}\n\n`)
          );
        } catch {
          cleanup();
        }
      };

      const onDone = (status: string) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done", status })}\n\n`
            )
          );
          controller.close();
        } catch {
          // Stream already closed
        }
        cleanup();
      };

      function cleanup() {
        executor?.removeListener("progress", onProgress);
        executor?.removeListener("log", onLog);
        executor?.removeListener("waiting_for_otp", onWaitingForOtp);
        executor?.removeListener("done", onDone);
      }

      // Store cleanup so cancel() can invoke it on client disconnect
      cleanupFn = cleanup;

      executor.on("progress", onProgress);
      executor.on("log", onLog);
      executor.on("waiting_for_otp", onWaitingForOtp);
      executor.on("done", onDone);
    },
    cancel() {
      // Called when client disconnects — remove all event listeners
      cleanupFn?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
