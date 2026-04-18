import { NextRequest } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardJob, { type IGiftCardJob } from "@/lib/db/models/GiftCardJob";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15000;

// GET /api/giftcards/jobs/[id]/stream — Server-Sent Events: pushes progress
// as the runner records it in the DB. Closes when the job reaches a terminal
// state.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = (session.user as { id: string }).id;
  const { id } = await params;

  await dbConnect();
  // Ownership check up-front — avoids leaking the existence of other users' jobs.
  const initial = await GiftCardJob.findOne({ _id: id, userId }).lean();
  if (!initial) {
    return new Response("Job not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let logsSent = 0;
      let cardsSent = 0;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      const pushDelta = (job: IGiftCardJob | { [k: string]: unknown }) => {
        const j = job as IGiftCardJob;
        const newLogs = (j.logs || []).slice(logsSent);
        if (newLogs.length > 0) {
          for (const l of newLogs) send("log", l);
          logsSent += newLogs.length;
        }
        const newCards = (j.cardStatuses || []).slice(cardsSent);
        if (newCards.length > 0) {
          for (const c of newCards) send("card_status", c);
          cardsSent += newCards.length;
        }
        send("progress", {
          status: j.status,
          total: j.total,
          completed: j.completed,
          failed: j.failed,
          skipped: j.skipped,
        });
      };

      // Send the initial snapshot
      pushDelta(initial as unknown as IGiftCardJob);

      // If the job is already done, emit "done" immediately and close
      if (TERMINAL.has(initial.status)) {
        send("done", {
          status: initial.status,
          total: initial.total,
          completed: initial.completed,
          failed: initial.failed,
          skipped: initial.skipped,
          errorMessage: initial.errorMessage,
        });
        closed = true;
        try { controller.close(); } catch { /* ignore */ }
        return;
      }

      // Otherwise poll for updates
      let lastHeartbeat = Date.now();
      const timer = setInterval(async () => {
        if (closed) return;
        try {
          const job = await GiftCardJob.findOne({ _id: id, userId }).lean();
          if (!job) {
            send("error", { message: "Job disappeared" });
            closed = true;
            clearInterval(timer);
            try { controller.close(); } catch { /* ignore */ }
            return;
          }
          pushDelta(job as unknown as IGiftCardJob);
          if (TERMINAL.has(job.status)) {
            send("done", {
              status: job.status,
              total: job.total,
              completed: job.completed,
              failed: job.failed,
              skipped: job.skipped,
              errorMessage: job.errorMessage,
            });
            closed = true;
            clearInterval(timer);
            try { controller.close(); } catch { /* ignore */ }
            return;
          }
          // Heartbeat keeps proxies / browsers from closing idle connections
          if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
            if (!closed) {
              try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { closed = true; }
            }
            lastHeartbeat = Date.now();
          }
        } catch (err) {
          console.error(`[GiftCardJob ${id}] stream poll error:`, err);
        }
      }, POLL_INTERVAL_MS);

      // Client disconnect
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
