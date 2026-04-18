/**
 * GiftCardJobReporter — buffered DB writer used inside gift-card runner
 * child processes. Collects log / card_status / counter updates in memory
 * and flushes them to the GiftCardJob document on a short interval, plus
 * on explicit `flush()` / `finalize()` calls.
 *
 * Design notes:
 *   - Runs inside a child process (spawned from Next.js). It connects to
 *     MongoDB on its own — does not share the parent's mongoose cache.
 *   - Uses $push/$inc so concurrent flushes from the same process don't
 *     overwrite each other and never clobber seed data the API wrote.
 *   - All errors are swallowed + logged: a DB blip must never crash the
 *     runner mid-batch; the UI will simply stop seeing updates until the
 *     next successful flush.
 */

import mongoose from "mongoose";
import GiftCardJob, {
  type GiftCardJobCardStatus,
  type GiftCardJobLog,
  type GiftCardJobStatus,
} from "../../src/lib/db/models/GiftCardJob";

const FLUSH_INTERVAL_MS = 1000;

export class GiftCardJobReporter {
  private pendingLogs: GiftCardJobLog[] = [];
  private pendingCards: GiftCardJobCardStatus[] = [];
  private deltaCompleted = 0;
  private deltaFailed = 0;
  private deltaSkipped = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private closed = false;

  constructor(private jobId: string) {}

  async connect(mongoUri: string): Promise<void> {
    if (mongoose.connection.readyState === 1) return;
    await mongoose.connect(mongoUri, { bufferCommands: false });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  }

  log(level: GiftCardJobLog["level"], message: string) {
    this.pendingLogs.push({ level, message, at: new Date() });
  }

  cardResult(entry: GiftCardJobCardStatus) {
    this.pendingCards.push(entry);
    if (entry.status === "added" || entry.status === "success") this.deltaCompleted++;
    else this.deltaFailed++;
  }

  incSkipped(n = 1) {
    this.deltaSkipped += n;
  }

  async markRunning(): Promise<void> {
    try {
      await GiftCardJob.updateOne(
        { _id: this.jobId },
        { $set: { status: "running", startedAt: new Date() } }
      );
    } catch (err) {
      console.error(`[reporter ${this.jobId}] markRunning failed:`, err);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    if (
      this.pendingLogs.length === 0 &&
      this.pendingCards.length === 0 &&
      this.deltaCompleted === 0 &&
      this.deltaFailed === 0 &&
      this.deltaSkipped === 0
    ) {
      return;
    }
    this.flushing = true;
    const logs = this.pendingLogs.splice(0);
    const cards = this.pendingCards.splice(0);
    const dCompleted = this.deltaCompleted;
    const dFailed = this.deltaFailed;
    const dSkipped = this.deltaSkipped;
    this.deltaCompleted = 0;
    this.deltaFailed = 0;
    this.deltaSkipped = 0;

    const update: Record<string, unknown> = {};
    const push: Record<string, unknown> = {};
    if (logs.length > 0) push.logs = { $each: logs };
    if (cards.length > 0) push.cardStatuses = { $each: cards };
    if (Object.keys(push).length > 0) update.$push = push;

    const inc: Record<string, number> = {};
    if (dCompleted) inc.completed = dCompleted;
    if (dFailed) inc.failed = dFailed;
    if (dSkipped) inc.skipped = dSkipped;
    if (Object.keys(inc).length > 0) update.$inc = inc;

    try {
      await GiftCardJob.updateOne({ _id: this.jobId }, update);
    } catch (err) {
      console.error(`[reporter ${this.jobId}] flush failed:`, err);
      // Requeue so we don't lose data; next flush will retry
      this.pendingLogs.unshift(...logs);
      this.pendingCards.unshift(...cards);
      this.deltaCompleted += dCompleted;
      this.deltaFailed += dFailed;
      this.deltaSkipped += dSkipped;
    } finally {
      this.flushing = false;
    }
  }

  async finalize(status: GiftCardJobStatus, errorMessage?: string | null): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final flush of any pending buffers before writing terminal status
    await this.flush();
    try {
      await GiftCardJob.updateOne(
        { _id: this.jobId },
        {
          $set: {
            status,
            completedAt: new Date(),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
          },
        }
      );
    } catch (err) {
      console.error(`[reporter ${this.jobId}] finalize failed:`, err);
    }
    this.closed = true;
  }

  async disconnect(): Promise<void> {
    try {
      await mongoose.disconnect();
    } catch { /* ignore */ }
  }
}
