/**
 * Gift Card Balance Checker — Standalone child process for checking Flipkart gift card balances via woohoo.in.
 *
 * Receives config as base64-encoded JSON via process.argv[2].
 * Config: { chromeProfileDir, phoneNumber, giftCards: [{cardNumber, pin}] }
 *
 * Flow:
 *   1. Navigate to woohoo.in/signin → enter phone → click Log in → wait for OTP (manual)
 *   2. After login, navigate to woohoo.in/profile/check-balance
 *   3. For each gift card: enter card number + pin → click Check Balance → read balance
 *
 * Outputs newline-delimited JSON messages to stdout:
 *   - { type: "log", level, message }
 *   - { type: "otp_required" }                          — signals frontend to wait for OTP
 *   - { type: "logged_in" }                              — OTP accepted, login complete
 *   - { type: "balance_result", cardNumber, pin, balance, status }
 *   - { type: "done", completed, failed }
 */

import { BrowserManager } from "../core/BrowserManager";
import { sendMessage, sleep } from "../core/helpers";
import fs from "fs";

interface GiftCardEntry {
  cardNumber: string;
  pin: string;
}

interface BalanceCheckerConfig {
  chromeProfileDir: string;
  phoneNumber: string;
  giftCards: GiftCardEntry[];
}

async function main() {
  const configB64 = process.argv[2];
  if (!configB64) {
    sendMessage({ type: "log", level: "error", message: "No config provided" });
    process.exit(1);
  }

  let config: BalanceCheckerConfig;
  try {
    config = JSON.parse(Buffer.from(configB64, "base64").toString("utf-8"));
  } catch {
    sendMessage({ type: "log", level: "error", message: "Invalid config" });
    process.exit(1);
  }

  if (!config.giftCards || config.giftCards.length === 0) {
    sendMessage({ type: "log", level: "error", message: "No gift cards provided" });
    process.exit(1);
  }

  if (!fs.existsSync("error-screenshots")) {
    fs.mkdirSync("error-screenshots", { recursive: true });
  }

  const browserManager = new BrowserManager();

  try {
    const { page } = await browserManager.launch(config.chromeProfileDir);

    // ── Step 1: Login to woohoo.in ──────────────────────────────────────
    sendMessage({ type: "log", level: "info", message: "Navigating to woohoo.in sign-in..." });
    await page.goto("https://www.woohoo.in/signin", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    // Check if already logged in (redirected away from signin or profile elements exist)
    const currentUrl = page.url();
    const isAlreadyLoggedIn = !currentUrl.includes("/signin") || await page.evaluate(() => {
      return !!document.querySelector('a[href*="/profile"]');
    });

    if (isAlreadyLoggedIn) {
      sendMessage({ type: "log", level: "info", message: "Already logged in to woohoo.in" });
      sendMessage({ type: "logged_in" });
    } else {
      // Enter phone number
      sendMessage({ type: "log", level: "info", message: "Entering phone number..." });
      const phoneInput = await page.waitForSelector('input#phoneNumber', { visible: true, timeout: 15000 });
      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await page.keyboard.type(config.phoneNumber, { delay: 50 });
      }
      await sleep(500);

      // Click Log in button
      sendMessage({ type: "log", level: "info", message: "Clicking Log in button..." });
      await page.evaluate(() => {
        const btn = document.querySelector('button.submit-button') as HTMLElement;
        if (btn) btn.click();
      });
      await sleep(1000);

      // Signal that OTP is required
      sendMessage({ type: "otp_required" });
      sendMessage({ type: "log", level: "info", message: "Waiting for OTP entry (manual)..." });

      // Wait for login to complete — poll for up to 120 seconds
      let loggedIn = false;
      for (let i = 0; i < 120; i++) {
        await sleep(1000);
        try {
          const url = page.url();
          // After OTP, woohoo.in redirects away from /signin
          if (!url.includes("/signin")) {
            loggedIn = true;
            break;
          }
          // Also check if profile link appeared (some flows stay on same URL)
          const hasProfile = await page.evaluate(() => {
            return !!document.querySelector('a[href*="/profile"]') ||
                   !!document.querySelector('.user-profile') ||
                   !!document.querySelector('[class*="logged-in"]');
          });
          if (hasProfile) {
            loggedIn = true;
            break;
          }
        } catch { /* page navigating */ }
      }

      if (!loggedIn) {
        sendMessage({ type: "log", level: "error", message: "Login timed out after 120s" });
        sendMessage({ type: "done", completed: 0, failed: config.giftCards.length });
        process.exit(1);
      }

      sendMessage({ type: "log", level: "info", message: "Login successful!" });
      sendMessage({ type: "logged_in" });
    }

    await sleep(1000);

    // ── Step 2: Navigate to check-balance page ──────────────────────────
    sendMessage({ type: "log", level: "info", message: "Navigating to balance check page..." });
    await page.goto("https://www.woohoo.in/profile/check-balance", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(2000);

    // Wait for card number input
    try {
      await page.waitForSelector('input#cardNumber', { visible: true, timeout: 15000 });
      sendMessage({ type: "log", level: "info", message: "Balance check page loaded" });
    } catch {
      sendMessage({ type: "log", level: "error", message: "Balance check page did not load properly" });
      try {
        await page.screenshot({ path: "error-screenshots/balance-check-page-error.png", fullPage: true });
      } catch { /* ignore */ }
    }

    // ── Step 3: Check balance for each gift card ────────────────────────
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < config.giftCards.length; i++) {
      const gc = config.giftCards[i];
      const masked = gc.cardNumber.length > 8
        ? gc.cardNumber.slice(0, 4) + "****" + gc.cardNumber.slice(-4)
        : gc.cardNumber.slice(0, 2) + "****";

      sendMessage({ type: "log", level: "info", message: `--- Card ${i + 1}/${config.giftCards.length} (${masked}) ---` });

      try {
        // If not on check-balance page (e.g. after a previous check), navigate back
        if (!page.url().includes("check-balance")) {
          await page.goto("https://www.woohoo.in/profile/check-balance", {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          await sleep(1500);
        }

        // Clear and enter card number
        const cardInput = await page.waitForSelector('input#cardNumber', { visible: true, timeout: 10000 });
        if (cardInput) {
          await cardInput.click({ clickCount: 3 });
          await sleep(100);
          await page.keyboard.press("Backspace");
          await page.keyboard.type(gc.cardNumber, { delay: 30 });
        }
        await sleep(300);

        // Clear and enter PIN
        const pinInput = await page.waitForSelector('input#cardPin', { visible: true, timeout: 5000 });
        if (pinInput) {
          await pinInput.click({ clickCount: 3 });
          await sleep(100);
          await page.keyboard.press("Backspace");
          await page.keyboard.type(gc.pin, { delay: 30 });
        }
        await sleep(300);

        // Click Check Balance button
        await page.evaluate(() => {
          const btn = document.querySelector('button.check-balance-screen__form__save-btn') as HTMLElement;
          if (btn) btn.click();
        });
        await sleep(3000);

        // Wait for balance to appear
        let balance = "";
        for (let attempt = 0; attempt < 15; attempt++) {
          balance = await page.evaluate(() => {
            // Look for the balance amount div
            const balDiv = document.querySelector('.card-details-content__balance-amount');
            if (balDiv) return (balDiv.textContent || "").trim();
            // Fallback: look for any element with balance text
            const allEls = document.querySelectorAll("div, span");
            for (const el of allEls) {
              const text = (el.textContent || "").trim();
              if (text.startsWith("₹") && text.length < 20) return text;
            }
            // Check for error messages
            const errorEl = document.querySelector('.error-message, .alert-danger, [class*="error"]');
            if (errorEl) {
              const errText = (errorEl.textContent || "").trim();
              if (errText) return "ERROR: " + errText;
            }
            return "";
          });

          if (balance) break;
          await sleep(1000);
        }

        if (balance && !balance.startsWith("ERROR:")) {
          sendMessage({ type: "log", level: "info", message: `Card ${masked} balance: ${balance}` });
          sendMessage({ type: "balance_result", cardNumber: gc.cardNumber, pin: gc.pin, balance, status: "success" });
          completed++;
        } else if (balance.startsWith("ERROR:")) {
          sendMessage({ type: "log", level: "error", message: `Card ${masked}: ${balance}` });
          sendMessage({ type: "balance_result", cardNumber: gc.cardNumber, pin: gc.pin, balance, status: "error" });
          failed++;
        } else {
          sendMessage({ type: "log", level: "error", message: `Card ${masked}: could not retrieve balance` });
          sendMessage({ type: "balance_result", cardNumber: gc.cardNumber, pin: gc.pin, balance: "N/A", status: "error" });
          failed++;
          try {
            await page.screenshot({ path: `error-screenshots/balance-${Date.now()}.png`, fullPage: true });
          } catch { /* ignore */ }
        }

        // Navigate back to check-balance for next card
        if (i < config.giftCards.length - 1) {
          await page.goto("https://www.woohoo.in/profile/check-balance", {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          await sleep(1500);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendMessage({ type: "log", level: "error", message: `Card ${masked} error: ${errMsg}` });
        sendMessage({ type: "balance_result", cardNumber: gc.cardNumber, pin: gc.pin, balance: "N/A", status: "error" });
        failed++;
        try {
          await page.screenshot({ path: `error-screenshots/balance-${Date.now()}.png`, fullPage: true });
        } catch { /* ignore */ }
      }

      if (i < config.giftCards.length - 1) {
        await sleep(500);
      }
    }

    sendMessage({ type: "done", completed, failed });
    process.exit(0);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sendMessage({ type: "log", level: "error", message: `Balance Checker fatal error: ${errMsg}` });
    sendMessage({ type: "done", completed: 0, failed: config.giftCards.length });
    process.exit(1);
  } finally {
    await browserManager.close();
  }
}

main();
