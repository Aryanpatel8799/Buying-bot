import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import SavedCard from "@/lib/db/models/SavedCard";
import FlipkartAccount from "@/lib/db/models/FlipkartAccount";
import SavedAddress from "@/lib/db/models/SavedAddress";
import Log from "@/lib/db/models/Log";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { decrypt } from "@/lib/encryption";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { removeExecutor } from "./jobRegistry";
import type { RunnerMessage, JobConfig } from "@/types";

export class JobExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private jobId: string;

  constructor(jobId: string) {
    super();
    this.jobId = jobId;
  }

  async start(): Promise<void> {
    await dbConnect();

    const job = await Job.findById(this.jobId).populate("chromeProfileId");
    if (!job) throw new Error(`Job ${this.jobId} not found`);

    // Decrypt payment details (may be empty if using card rotation)
    let paymentDetails: Record<string, string> = {};
    if (job.paymentDetails && job.paymentDetails.includes(":")) {
      try {
        paymentDetails = JSON.parse(decrypt(job.paymentDetails));
      } catch {
        console.warn(`[Job ${this.jobId}] Could not decrypt paymentDetails, using empty`);
      }
    }
    // Cast to PaymentDetails — the actual structure depends on paymentMethod
    const typedPaymentDetails = paymentDetails as unknown as import("@/types").PaymentDetails;

    // Build config for the runner
    const chromeProfile = job.chromeProfileId as unknown as { directoryName: string };
    // Build products array: use job.products if available, else fall back to single productUrl
    const products =
      job.products && job.products.length > 0
        ? job.products.map((p: { url: string; quantity: number }) => ({
            url: p.url,
            quantity: p.quantity,
          }))
        : [{ url: job.productUrl, quantity: job.perOrderQuantity }];

    // Decrypt saved cards for rotation (skip corrupt cards)
    let cards: { cardNumber: string; expiry: string; cvv: string }[] | undefined;
    if (job.cardIds && job.cardIds.length > 0) {
      const savedCards = await SavedCard.find({ _id: { $in: job.cardIds } });
      cards = savedCards
        .map((sc: { _id: unknown; encryptedDetails: string }) => {
          try {
            const details = JSON.parse(decrypt(sc.encryptedDetails));
            return {
              cardNumber: details.cardNumber,
              expiry: details.expiry,
              cvv: details.cvv,
            };
          } catch {
            console.warn(`[Job ${this.jobId}] Skipping corrupt card ${sc._id}`);
            return null;
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
    }

    // Decrypt Flipkart accounts for rotation (skip corrupt accounts)
    let accounts: string[] | undefined;
    if (job.accountIds && job.accountIds.length > 0) {
      const savedAccounts = await FlipkartAccount.find({ _id: { $in: job.accountIds } });
      accounts = savedAccounts
        .map((sa: { _id: unknown; encryptedEmail: string }) => {
          try {
            return decrypt(sa.encryptedEmail);
          } catch {
            console.warn(`[Job ${this.jobId}] Skipping corrupt account ${sa._id}`);
            return null;
          }
        })
        .filter((a): a is string => a !== null);
    }

    // Decrypt InstaDDR accounts for OTP automation
    let instaDdrAccounts: import("@/types").InstaDdrAccount[] | undefined;
    const instaDdrAccountIds = (job as any).instaDdrAccountIds;
    console.log(`[Job ${this.jobId}] InstaDDR accountIds from job: ${JSON.stringify(instaDdrAccountIds ?? "undefined")}`);
    if (instaDdrAccountIds && instaDdrAccountIds.length > 0) {
      const groups = await InstaDdrAccount.find({ _id: { $in: instaDdrAccountIds } }).lean();
      console.log(`[Job ${this.jobId}] Found ${groups.length} InstaDDR group(s) in DB, total accounts: ${groups.reduce((n, g) => n + ((g.accounts as any[])?.length ?? 0), 0)}`);
      const allAccounts: import("@/types").InstaDdrAccount[] = [];
      for (const group of groups) {
        for (const a of (group.accounts as any[])) {
          try {
            allAccounts.push({
              instaDdrId: a.instaDdrId,
              instaDdrPassword: decrypt(a.instaDdrPassword),
              email: decrypt(a.email),
            });
          } catch (err) {
            console.warn(`[Job ${this.jobId}] Skipping corrupt InstaDDR account ${a._id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      if (allAccounts.length > 0) {
        instaDdrAccounts = allAccounts;
        console.log(`[Job ${this.jobId}] Loaded ${allAccounts.length} InstaDDR accounts from ${groups.length} group(s)`);
      } else {
        console.warn(`[Job ${this.jobId}] InstaDDR group(s) selected but all accounts were corrupt — skipping InstaDDR`);
      }
    } else {
      console.log(`[Job ${this.jobId}] No InstaDDR accountIds in job document — InstaDDR disabled`);
    }

    // Fetch GST address details
    // Uses job.addressIds if populated, otherwise falls back to the first saved address for Flipkart jobs
    let address: import("@/types").AddressDetails | undefined;

    if (job.addressIds && job.addressIds.length > 0) {
      console.log(`[Job ${this.jobId}] Job has addressIds: ${job.addressIds.length}`);
      const savedAddresses = await SavedAddress.find({ _id: { $in: job.addressIds } });
      console.log(`[Job ${this.jobId}] Found ${savedAddresses.length} saved addresses`);
      if (savedAddresses.length > 0) {
        const addr = savedAddresses[0];
        address = {
          name: addr.name,
          mobile: addr.mobile,
          pincode: addr.pincode,
          locality: addr.locality,
          addressLine1: addr.addressLine1,
          city: addr.city,
          state: addr.state,
          addressType: addr.addressType,
          gstNumber: addr.gstNumber,
          companyName: addr.companyName,
          ...(job.checkoutPincode ? { checkoutPincode: job.checkoutPincode as string } : {}),
        };
        console.log(`[Job ${this.jobId}] Loaded GST address: ${address.gstNumber} (${address.companyName}) city=${address.city} pincode=${address.checkoutPincode || address.pincode}`);
      } else {
        console.warn(`[Job ${this.jobId}] addressIds provided but no addresses found in DB`);
      }
    }

    // Fallback: if no address loaded yet and this is a Flipkart job, use the first saved address
    if (!address && job.platform === "flipkart") {
      const userId = job.userId.toString();
      console.log(`[Job ${this.jobId}] No addressIds in job — falling back to first saved address for Flipkart`);
      const firstAddress = await SavedAddress.findOne({ userId });
      if (firstAddress) {
        address = {
          name: firstAddress.name,
          mobile: firstAddress.mobile,
          pincode: firstAddress.pincode,
          locality: firstAddress.locality,
          addressLine1: firstAddress.addressLine1,
          city: firstAddress.city,
          state: firstAddress.state,
          addressType: firstAddress.addressType,
          gstNumber: firstAddress.gstNumber,
          companyName: firstAddress.companyName,
          ...(job.checkoutPincode ? { checkoutPincode: job.checkoutPincode as string } : {}),
        };
        console.log(`[Job ${this.jobId}] Fallback GST address loaded: ${address.gstNumber} (${address.companyName})`);
      } else {
        console.warn(`[Job ${this.jobId}] No saved GST addresses found for this user`);
      }
    }

    if (!address) {
      console.log(`[Job ${this.jobId}] GST address verification will be skipped (no address available)`);
    }

    const config: JobConfig = {
      jobId: this.jobId,
      platform: job.platform,
      paymentMethod: job.paymentMethod,
      productUrl: job.productUrl,
      products,
      totalQuantity: job.totalQuantity,
      perOrderQuantity: job.perOrderQuantity,
      intervalSeconds: job.intervalSeconds,
      chromeProfileDir: getProfileDir(chromeProfile.directoryName),
      paymentDetails: typedPaymentDetails,
      ...(cards && cards.length > 0 ? { cards } : {}),
      ...(accounts && accounts.length > 0 ? { accounts } : {}),
      ...(address ? { address } : {}),
      ...(job.maxConcurrentTabs > 1 ? { maxConcurrentTabs: job.maxConcurrentTabs } : {}),
      ...(instaDdrAccounts && instaDdrAccounts.length > 0 ? { instaDdrAccounts } : {}),
    };

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    // Spawn the runner as a child process using tsx
    // Using spawn instead of fork to avoid Next.js bundler resolving the path
    this.process = spawn("npx", ["tsx", "automation/runner.ts", configB64], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    // Update job status
    const totalIterations = Math.ceil(job.totalQuantity / job.perOrderQuantity);
    await Job.updateOne(
      { _id: this.jobId },
      {
        status: "running",
        pid: this.process.pid,
        startedAt: new Date(),
        "progress.totalIterations": totalIterations,
      }
    );

    // Parse stdout for JSON messages
    let buffer = "";
    this.process.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: RunnerMessage = JSON.parse(line);
          this.handleMessage(msg);
        } catch {
          // Not JSON, might be console.log from automation
          this.emit("output", line);
        }
      }
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      console.error(`[Job ${this.jobId}] stderr: ${text}`);
    });

    this.process.on("error", async (err) => {
      console.error(`[Job ${this.jobId}] Process error: ${err.message}`);
      try {
        await Job.updateOne(
          { _id: this.jobId },
          { status: "failed", completedAt: new Date(), pid: null }
        );
      } catch {}
      this.emit("done", "failed");
      removeExecutor(this.jobId);
    });

    this.process.on("exit", async (code) => {
      const finalStatus = code === 0 ? "completed" : "failed";
      try {
        await Job.updateOne(
          { _id: this.jobId },
          {
            status: finalStatus,
            completedAt: new Date(),
            pid: null,
          }
        );
      } catch (err) {
        console.error(`[Job ${this.jobId}] Failed to update status on exit:`, err);
      }
      this.emit("done", finalStatus);
      removeExecutor(this.jobId);
    });
  }

  private async handleMessage(msg: RunnerMessage): Promise<void> {
    switch (msg.type) {
      case "progress":
        await Job.updateOne(
          { _id: this.jobId },
          {
            $set: { "progress.currentIteration": msg.iteration },
            $inc: msg.status === "success"
              ? { "progress.completedIterations": 1 }
              : { "progress.failedIterations": 1 },
          }
        );
        this.emit("progress", msg);
        break;

      case "log":
        await Log.create({
          jobId: this.jobId,
          iteration: msg.iteration || 0,
          level: msg.level,
          message: msg.message,
          screenshotPath: msg.screenshot || null,
        });
        this.emit("log", msg);
        break;

      case "waiting_for_otp":
        await Log.create({
          jobId: this.jobId,
          iteration: msg.iteration || 0,
          level: "info",
          message: `Waiting for OTP: ${msg.email}`,
        });
        this.emit("waiting_for_otp", msg);
        break;

      case "done":
        this.emit("complete", msg);
        break;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    this.process.kill("SIGTERM");

    // Wait for process to exit, force kill after 5s
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      this.process!.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await Job.updateOne(
      { _id: this.jobId },
      { status: "cancelled", pid: null, completedAt: new Date() }
    );
  }

  getProcessId(): number | undefined {
    return this.process?.pid;
  }
}
