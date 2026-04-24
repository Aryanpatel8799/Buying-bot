/**
 * Runner — Child process entry point
 *
 * Receives job config as base64-encoded JSON via process.argv[2].
 * Outputs progress/log messages as newline-delimited JSON to stdout.
 * Parent (JobExecutor) parses stdout to update DB and SSE clients.
 */

import { BrowserManager } from "./core/BrowserManager";
import { BatchOrchestrator } from "./core/BatchOrchestrator";
import { sendMessage } from "./core/helpers";

// Platform imports
import { FlipkartPlatform } from "./platforms/FlipkartPlatform";
import { AmazonPlatform } from "./platforms/AmazonPlatform";

// Payment imports
import { CardPayment } from "./payments/CardPayment";
import { GiftCardPayment } from "./payments/GiftCardPayment";
import { RTGSPayment } from "./payments/RTGSPayment";

import type { JobConfig } from "../src/types";
import fs from "fs";

async function main() {
  // Parse config from argv
  const configB64 = process.argv[2];
  if (!configB64) {
    console.error("Usage: runner <base64-config>");
    process.exit(1);
  }

  let config: JobConfig;
  try {
    config = JSON.parse(Buffer.from(configB64, "base64").toString("utf-8"));
  } catch {
    console.error("Failed to parse job config");
    process.exit(1);
  }

  sendMessage({
    type: "log",
    level: "info",
    message: `Runner started for job ${config.jobId} | ${config.platform} | ${config.paymentMethod}`,
  });

  if (config.address) {
    sendMessage({
      type: "log",
      level: "info",
      message: `Runner config has GST address: ${config.address.gstNumber} (${config.address.companyName})`,
    });
  } else {
    sendMessage({
      type: "log",
      level: "warn",
      message: "Runner config has NO GST address — address/GST verification will be skipped",
    });
  }

  if (config.instaDdrAccounts && config.instaDdrAccounts.length > 0) {
    sendMessage({
      type: "log",
      level: "info",
      message: `Runner config has ${config.instaDdrAccounts.length} InstaDDR account(s) — OTP automation enabled`,
    });
  } else {
    sendMessage({
      type: "log",
      level: "info",
      message: "Runner config has NO InstaDDR accounts — OTP will be manual",
    });
  }

  // Ensure error-screenshots directory exists
  if (!fs.existsSync("error-screenshots")) {
    fs.mkdirSync("error-screenshots", { recursive: true });
  }

  const browserManager = new BrowserManager();
  let runnerErrored = false;

  try {
    // Launch browser with profile
    const { page } = await browserManager.launch(config.chromeProfileDir);

    // Determine the initial product URL
    const initialUrl =
      config.products && config.products.length > 0
        ? config.products[0].url
        : config.productUrl;

    // Create platform adapter
    const platform =
      config.platform === "flipkart"
        ? new FlipkartPlatform(page, initialUrl)
        : new AmazonPlatform(page, initialUrl);

    // Create payment strategy
    let payment;
    switch (config.paymentMethod) {
      case "card":
        payment = new CardPayment(page, config.platform);
        break;
      case "giftcard":
        payment = new GiftCardPayment(page, config.platform);
        break;
      case "rtgs":
        payment = new RTGSPayment(page, config.platform);
        break;
      default:
        throw new Error(`Unknown payment method: ${config.paymentMethod}`);
    }

    // Run batch orchestrator
    const orchestrator = new BatchOrchestrator(page, platform, payment, config);
    const { completed, failed } = await orchestrator.run();

    // Iterations can fail without throwing (e.g. "Buy Now button not found"
    // is caught per-iteration). Treat any failed iteration the same as an
    // error for the purposes of keeping Chrome open for inspection.
    if (failed > 0) {
      runnerErrored = true;
      sendMessage({
        type: "log",
        level: "warn",
        message: `Runner finished with ${failed} failed iteration(s) and ${completed} successful — keeping Chrome open.`,
      });
    } else {
      sendMessage({ type: "log", level: "info", message: "Runner completed" });
    }
  } catch (err) {
    runnerErrored = true;
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendMessage({
      type: "log",
      level: "error",
      message: `Runner fatal error: ${errorMsg}`,
    });
  } finally {
    if (runnerErrored) {
      // Leave Chrome open so the user can inspect what happened or pick up
      // the purchase manually. Disconnect just detaches Puppeteer; the
      // process stays running until the user closes the window themselves.
      sendMessage({
        type: "log",
        level: "info",
        message: "Chrome left open for manual inspection. Close the window when done.",
      });
      await browserManager.disconnect();
    } else {
      await browserManager.close();
    }
    process.exit(runnerErrored ? 1 : 0);
  }
}

main();
