/**
 * Gift Card Runner — Standalone child process for adding gift cards to Flipkart account.
 *
 * Receives config as base64-encoded JSON via process.argv[2].
 * Config: { chromeProfileDir, giftCards: [{cardNumber, pin}] }
 */

import { BrowserManager } from "../core/BrowserManager";
import { sendMessage, sleep, navigateWithRetry, waitWithRetry, clearAndType } from "../core/helpers";

interface GiftCardEntry {
  cardNumber: string;
  pin: string;
}

interface GiftCardConfig {
  chromeProfileDir: string;
  giftCards: GiftCardEntry[];
}

async function main() {
  const configB64 = process.argv[2];
  if (!configB64) {
    console.error("Usage: giftCardRunner <base64-config>");
    process.exit(1);
  }

  let config: GiftCardConfig;
  try {
    config = JSON.parse(Buffer.from(configB64, "base64").toString("utf-8"));
  } catch {
    console.error("Failed to parse gift card config");
    process.exit(1);
  }

  sendMessage({
    type: "log",
    level: "info",
    message: `Gift Card Runner started — ${config.giftCards.length} cards to add`,
  });

  const browserManager = new BrowserManager();

  try {
    const { page } = await browserManager.launch(config.chromeProfileDir);

    let added = 0;
    let failed = 0;

    for (let i = 0; i < config.giftCards.length; i++) {
      const gc = config.giftCards[i];
      const maskedNumber = gc.cardNumber.slice(0, 4) + "****" + gc.cardNumber.slice(-4);

      sendMessage({
        type: "log",
        level: "info",
        message: `--- Card ${i + 1}/${config.giftCards.length} (${maskedNumber}) ---`,
      });

      try {
        // Navigate to gift card page
        await navigateWithRetry(page, "https://www.flipkart.com/account/giftcard", {
          timeoutMs: 15000,
          maxRetries: 3,
        });
        await sleep(500);

        // Click "ADD A GIFT CARD" button
        await waitWithRetry(
          page,
          async () => {
            await page.waitForFunction(
              () => {
                // Look for the "ADD A GIFT CARD" text inside a span within J_a41c div
                const spans = Array.from(document.querySelectorAll("span"));
                for (const s of spans) {
                  if (s.textContent?.trim().toUpperCase() === "ADD A GIFT CARD") return true;
                }
                return false;
              },
              { timeout: 10000 }
            );
          },
          { label: "ADD A GIFT CARD button", timeoutMs: 10000, maxRetries: 3 }
        );

        await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll("span"));
          for (const s of spans) {
            if (s.textContent?.trim().toUpperCase() === "ADD A GIFT CARD") {
              // Click the parent div (J_a41c container)
              const parent = s.closest("div.J_a41c") || s.parentElement;
              if (parent) {
                (parent as HTMLElement).click();
                return;
              }
              (s as HTMLElement).click();
              return;
            }
          }
        });
        sendMessage({ type: "log", level: "info", message: "Clicked ADD A GIFT CARD" });
        await sleep(300);

        // Enter card number
        await clearAndType(
          page,
          'input[name="cardNumber"]',
          gc.cardNumber,
          "Gift Card Number"
        );
        await sleep(200);

        // Enter PIN
        await clearAndType(
          page,
          'input[name="pin"]',
          gc.pin,
          "Gift Card PIN"
        );
        await sleep(200);

        // Click "ADD GIFT CARD TO ACCOUNT" button
        await waitWithRetry(
          page,
          async () => {
            await page.waitForFunction(
              () => {
                const buttons = Array.from(document.querySelectorAll("button"));
                for (const btn of buttons) {
                  if (btn.textContent?.trim().toUpperCase() === "ADD GIFT CARD TO ACCOUNT") return true;
                }
                return false;
              },
              { timeout: 5000 }
            );
          },
          { label: "ADD GIFT CARD TO ACCOUNT button", timeoutMs: 5000, maxRetries: 3 }
        );

        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const btn of buttons) {
            if (btn.textContent?.trim().toUpperCase() === "ADD GIFT CARD TO ACCOUNT") {
              btn.click();
              return;
            }
          }
        });
        sendMessage({ type: "log", level: "info", message: "Clicked ADD GIFT CARD TO ACCOUNT" });
        await sleep(500);

        // Check for success or error
        const result = await page.evaluate(() => {
          const text = document.body.innerText;
          if (text.includes("successfully") || text.includes("Successfully") || text.includes("added to your account")) {
            return "success";
          }
          if (text.includes("Invalid") || text.includes("invalid") || text.includes("already") || text.includes("error")) {
            // Try to extract error message
            const errorEls = Array.from(document.querySelectorAll('[class*="error"], [class*="Error"], .yWkr8W'));
            for (const el of errorEls) {
              const t = (el as HTMLElement).innerText?.trim();
              if (t) return `error: ${t}`;
            }
            return "error: Gift card could not be added";
          }
          return "unknown";
        });

        if (result === "success") {
          added++;
          sendMessage({
            type: "progress",
            iteration: i + 1,
            total: config.giftCards.length,
            status: "success",
          });
          sendMessage({
            type: "log",
            level: "info",
            message: `Card ${maskedNumber} added successfully`,
          });
        } else {
          // "unknown" and error results are all treated as failures
          failed++;
          sendMessage({
            type: "progress",
            iteration: i + 1,
            total: config.giftCards.length,
            status: "failed",
          });
          sendMessage({
            type: "log",
            level: "error",
            message: `Card ${maskedNumber}: ${result}`,
          });
        }
      } catch (err) {
        failed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        sendMessage({
          type: "progress",
          iteration: i + 1,
          total: config.giftCards.length,
          status: "failed",
        });
        sendMessage({
          type: "log",
          level: "error",
          message: `Card ${maskedNumber} failed: ${errMsg}`,
        });
      }

      // Small delay between cards
      if (i < config.giftCards.length - 1) {
        await sleep(500);
      }
    }

    sendMessage({
      type: "done",
      completed: added,
      failed,
    });

    process.exit(0);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendMessage({
      type: "log",
      level: "error",
      message: `Gift Card Runner fatal error: ${errorMsg}`,
    });
    process.exit(1);
  } finally {
    await browserManager.close();
  }
}

main();
