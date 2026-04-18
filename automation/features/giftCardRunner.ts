/**
 * Gift Card Runner — Standalone child process for adding gift cards to Flipkart or Amazon account.
 *
 * Receives config as base64-encoded JSON via process.argv[2].
 * Config: { chromeProfileDir, platform, giftCards: [{cardNumber, pin?}] }
 *
 * Outputs newline-delimited JSON messages to stdout:
 *   - { type: "log", level, message }
 *   - { type: "progress", iteration, total, status }
 *   - { type: "card_status", cardNumber, status: "added"|"not added", error? }
 *   - { type: "done", completed, failed }
 */

import { BrowserManager } from "../core/BrowserManager";
import { sendMessage, sleep, navigateWithRetry, waitWithRetry, clearAndType, withTimeout, onSendMessage } from "../core/helpers";
import { FlipkartPlatform } from "../platforms/FlipkartPlatform";
import { InstaDdrService } from "../services/InstaDdrService";
import { GiftCardJobReporter } from "./giftCardJobReporter";
import type { Browser } from "puppeteer-core";

// ── Register a shadow-piercing query handler for Amazon's web components ──
import * as puppeteerCore from "puppeteer-core";

// Register "pierce" query handler that walks shadow DOM
(puppeteerCore as any).customQueryHandlers.register("pierce", {
  queryOne(root: Document | ShadowRoot | Element, selector: string): Element | null {
    const found = root.querySelector(selector);
    if (found) return found;
    const all = root.querySelectorAll("*");
    for (const el of Array.from(all)) {
      if ((el as Element).shadowRoot) {
        const nested = (puppeteerCore as any).customQueryHandlers.queryOne((el as Element).shadowRoot!, selector);
        if (nested) return nested;
      }
    }
    return null;
  },
  queryAll(root: Document | ShadowRoot | Element, selector: string): Element[] {
    const results: Element[] = [];
    const found = root.querySelectorAll(selector);
    results.push(...found);
    const all = root.querySelectorAll("*");
    for (const el of Array.from(all)) {
      if ((el as Element).shadowRoot) {
        results.push(...(puppeteerCore as any).customQueryHandlers.queryAll((el as Element).shadowRoot!, selector));
      }
    }
    return results;
  },
});
import fs from "fs";

interface GiftCardEntry {
  cardNumber: string;
  pin: string;
}

interface InstaDdrAccountConfig {
  instaDdrId: string;
  instaDdrPassword: string;
  email: string;
}

interface GiftCardConfig {
  /** When present, runner writes progress to the GiftCardJob record in DB */
  jobId?: string;
  chromeProfileDir: string;
  platform: "flipkart" | "amazon";
  giftCards: GiftCardEntry[];
  batchSize?: number;
  maxRetries?: number;
  cardTimeoutMs?: number;
  /** Optional Flipkart account email — when provided, runner logs in before adding cards */
  account?: string;
  /** Optional InstaDDR accounts for auto-OTP fetch during login */
  instaDdrAccounts?: InstaDdrAccountConfig[];
}

// ─── Flipkart Gift Card Flow ────────────────────────────────────────────────

async function addFlipkartGiftCard(
  page: any,
  gc: GiftCardEntry,
  maskedNumber: string,
  maxRetries: number,
  cardTimeoutMs: number
): Promise<"added" | "not added"> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await withTimeout(
        () => addFlipkartGiftCardOnce(page, gc, maskedNumber),
        cardTimeoutMs,
        `Flipkart card ${maskedNumber}`
      );
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        sendMessage({ type: "log", level: "warn", message: `Card ${maskedNumber} attempt ${attempt} failed: ${errMsg}. Retrying...` });
        await sleep(1000);
      } else {
        sendMessage({ type: "log", level: "error", message: `Card ${maskedNumber} failed after ${maxRetries} attempts: ${errMsg}` });
        return "not added";
      }
    }
  }
  return "not added";
}

async function addFlipkartGiftCardOnce(
  page: any,
  gc: GiftCardEntry,
  maskedNumber: string
): Promise<"added" | "not added"> {
  await navigateWithRetry(page, "https://www.flipkart.com/account/giftcard", {
    timeoutMs: 15000,
    maxRetries: 3,
  });
  await sleep(400);

  await waitWithRetry(
    page,
    async () => {
      await page.waitForFunction(
        () => {
          const spans = Array.from(document.querySelectorAll("span"));
          for (const s of spans) {
            if (s.textContent?.trim().toUpperCase() === "ADD A GIFT CARD") return true;
          }
          return false;
        },
        { timeout: 8000 }
      );
    },
    { label: "ADD A GIFT CARD button", timeoutMs: 8000, maxRetries: 3 }
  );

  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("span"));
    for (const s of spans) {
      if (s.textContent?.trim().toUpperCase() === "ADD A GIFT CARD") {
        const parent = s.closest("div.J_a41c") || s.parentElement;
        if (parent) { (parent as HTMLElement).click(); return; }
        (s as HTMLElement).click();
        return;
      }
    }
  });
  sendMessage({ type: "log", level: "info", message: "Clicked ADD A GIFT CARD" });
  await sleep(250);

  await clearAndType(page, 'input[name="cardNumber"]', gc.cardNumber, "Gift Card Number");
  await sleep(150);

  await clearAndType(page, 'input[name="pin"]', gc.pin, "Gift Card PIN");
  await sleep(150);

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
  await sleep(400);

  const result = await page.evaluate(() => {
    const text = document.body.innerText;
    if (text.includes("successfully") || text.includes("Successfully") || text.includes("added to your account")) {
      return "success";
    }
    if (text.includes("Invalid") || text.includes("invalid") || text.includes("already") || text.includes("error") || text.includes("Error")) {
      const errorEls = Array.from(document.querySelectorAll('[class*="error"], [class*="Error"], .yWkr8W'));
      for (const el of errorEls) {
        const t = (el as HTMLElement).innerText?.trim();
        if (t) return `error: ${t}`;
      }
      return "error: Gift card could not be added";
    }
    return "unknown";
  });

  if (result === "success") return "added";
  return "not added";
}

// ─── Amazon Gift Card Flow ──────────────────────────────────────────────────

async function addAmazonGiftCard(
  page: any,
  gc: GiftCardEntry,
  maskedNumber: string,
  maxRetries: number,
  cardTimeoutMs: number
): Promise<"added" | "not added"> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await withTimeout(
        () => addAmazonGiftCardOnce(page, gc, maskedNumber),
        cardTimeoutMs,
        `Amazon card ${maskedNumber}`
      );
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        sendMessage({ type: "log", level: "warn", message: `Card ${maskedNumber} attempt ${attempt} failed: ${errMsg}. Retrying...` });
        await sleep(1000);
      } else {
        sendMessage({ type: "log", level: "error", message: `Card ${maskedNumber} failed after ${maxRetries} attempts: ${errMsg}` });
        return "not added";
      }
    }
  }
  return "not added";
}

async function addAmazonGiftCardOnce(
  page: any,
  gc: GiftCardEntry,
  maskedNumber: string
): Promise<"added" | "not added"> {
  await navigateWithRetry(page, "https://www.amazon.in/gp/aw/ya/gcb", {
    timeoutMs: 15000,
    maxRetries: 3,
  });

  // Wait for Amazon web components to fully hydrate
  await sleep(3000);

  // ── Step 1: Debug page state via page.evaluate() ──
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] === addAmazonGiftCardOnce start ===` });

  const pageInfo = await page.evaluate(() => {
    const tuxInput = document.querySelector("tux-input#claim-Code-input-box");
    return {
      url: window.location.href,
      tuxInputFound: !!tuxInput,
      tuxInputCount: document.querySelectorAll("tux-input").length,
      inputCount: document.querySelectorAll("input").length,
      bodySnippet: document.body.innerText.substring(0, 300).replace(/\s+/g, " "),
      hasShadow: !!(tuxInput as any)?.shadowRoot,
      shadowHTML: (tuxInput as any)?.shadowRoot?.innerHTML?.substring(0, 500),
    };
  });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] URL: ${pageInfo.url}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] tux-input found: ${pageInfo.tuxInputFound}, count: ${pageInfo.tuxInputCount}, inputs: ${pageInfo.inputCount}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] body snippet: ${pageInfo.bodySnippet}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] tux-input has shadowRoot: ${pageInfo.hasShadow}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] shadowRoot HTML: ${pageInfo.shadowHTML}` });

  // ── Step 2: Walk shadow DOM to find and interact with input ──
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Walking shadow DOM to find input...` });

  let inputInfo: any;
  try {
    inputInfo = await page.evaluate(() => {
      // Directly access tux-input's shadow root — no recursion, no named functions
      const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
      if (!tuxInput) return { error: "tux-input not found" };
      const shadow = tuxInput.shadowRoot;
      if (!shadow) return { error: "no shadowRoot on tux-input" };
      const input = shadow.querySelector('input.input-tag[name="claimCode"]');
      if (!input) return { error: "input not found in shadowRoot" };
      const r = input.getBoundingClientRect();
      return {
        found: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        value: input.value,
        outerHTML: input.outerHTML,
        shadowHTML: shadow.innerHTML.substring(0, 300),
      };
    });
  } catch (e) {
    sendMessage({ type: "log", level: "error", message: `[Amazon GC] Step 2 evaluate CRASHED: ${(e as Error).message}` });
    sendMessage({ type: "log", level: "error", message: `[Amazon GC] Stack: ${(e as Error).stack}` });
    return "not added";
  }

  sendMessage({ type: "log", level: "info", message: `[Amazon GC] inputInfo: ${JSON.stringify(inputInfo)}` });

  if (!inputInfo || inputInfo.error) {
    sendMessage({ type: "log", level: "error", message: `[Amazon GC] FATAL: ${inputInfo?.error || "no result"}` });
    return "not added";
  }

  const rect = { x: inputInfo.x, y: inputInfo.y, width: inputInfo.width, height: inputInfo.height };
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Input rect: x=${rect.x.toFixed(0)}, y=${rect.y.toFixed(0)}, w=${rect.width}, h=${rect.height}` });

  // ── Step 3: Click to focus input ──
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Clicking input via CDP mouse...` });
  await page.mouse.click(rect.x, rect.y);
  await sleep(600);

  // ── Step 4: Check focused element ──
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
    const shadow = tuxInput?.shadowRoot;
    const shadowInput = shadow?.querySelector('input.input-tag[name="claimCode"]');
    return {
      activeTag: active?.tagName,
      activeValue: (active as HTMLInputElement)?.value,
      shadowInputValue: shadowInput?.value || "",
      bodyText: document.body.innerText.substring(0, 200),
    };
  });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Focused element: tag=${focused.activeTag}, value="${focused.activeValue}", shadowInputValue="${focused.shadowInputValue}"` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Body text: ${focused.bodyText.replace(/\s+/g, " ")}` });

  // ── Step 5: Type the code via CDP keyboard ──
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Typing code (${gc.cardNumber.length} chars) via CDP...` });
  await page.keyboard.type(gc.cardNumber, { delay: 30 });
  await sleep(300);

  // ── Step 6: Verify ──
  const afterType = await page.evaluate(() => {
    const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
    const shadow = tuxInput?.shadowRoot;
    const shadowInput = shadow?.querySelector('input.input-tag[name="claimCode"]');
    return {
      shadowValue: shadowInput?.value || "",
      shadowValueLength: shadowInput?.value?.length || 0,
      activeValue: (document.activeElement as HTMLInputElement)?.value || "",
      bodyText: document.body.innerText.substring(0, 200).replace(/\s+/g, " "),
    };
  });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] After typing — shadowValue="${afterType.shadowValue.substring(0, 4)}****", length=${afterType.shadowValueLength}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Active element value: "${afterType.activeValue}"` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Body: ${afterType.bodyText}` });

  // ── Step 7: If CDP typing failed, try JS native setter ──
  if (!afterType.shadowValue || afterType.shadowValue.length < gc.cardNumber.length) {
    sendMessage({ type: "log", level: "warn", message: `[Amazon GC] CDP typing failed. Trying JS native setter...` });
    try {
      await page.evaluate((val: string) => {
        const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
        const input = tuxInput?.shadowRoot?.querySelector('input.input-tag[name="claimCode"]');
        if (!input) { console.log("FAIL: input not found"); return; }
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, val);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        console.log(`JS setter: value now = "${input.value}"`);
      }, gc.cardNumber);
    } catch (e) {
      sendMessage({ type: "log", level: "error", message: `[Amazon GC] Step 7 evaluate CRASHED: ${(e as Error).message}` });
      sendMessage({ type: "log", level: "error", message: `[Amazon GC] Stack: ${(e as Error).stack}` });
      return "not added";
    }
    await sleep(400);

    const afterSetter = await page.evaluate(() => {
      const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
      const input = tuxInput?.shadowRoot?.querySelector('input.input-tag[name="claimCode"]');
      return input?.value || "";
    });
    sendMessage({ type: "log", level: "info", message: `[Amazon GC] After JS setter: "${afterSetter.substring(0, 4)}****"` });

    if (!afterSetter || afterSetter.length < gc.cardNumber.length) {
      sendMessage({ type: "log", level: "error", message: `[Amazon GC] ALL INPUT METHODS FAILED. shadow="${afterSetter}", CDP="${afterType.shadowValue}"` });
      return "not added";
    }
  }

  // ── Step 8: Click the "Add gift card to balance" button ──
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Looking for submit button...` });

  let buttonClicked = false;

  // Strategy A: Click the tux-button via shadow DOM walk + CDP
  try {
    const buttonInfo = await page.evaluate(() => {
      const tuxBtn = document.querySelector("tux-button.add-gift-card-button") as any;
      if (!tuxBtn) return null;
      const shadow = tuxBtn.shadowRoot;
      const innerBtn = shadow?.querySelector?.("button") as HTMLButtonElement | null;
      if (!innerBtn) return null;
      const r = innerBtn.getBoundingClientRect();
      return {
        found: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        text: innerBtn.textContent?.trim(),
      };
    });

    if (buttonInfo?.found) {
      sendMessage({ type: "log", level: "info", message: `[Amazon GC] Found button at (${buttonInfo.x.toFixed(0)}, ${buttonInfo.y.toFixed(0)}) — text: "${buttonInfo.text}"` });
      await page.mouse.click(buttonInfo.x, buttonInfo.y);
      buttonClicked = true;
      sendMessage({ type: "log", level: "info", message: `[Amazon GC] Button clicked via CDP` });
    }
  } catch (e) {
    sendMessage({ type: "log", level: "warn", message: `[Amazon GC] Strategy A failed: ${(e as Error).message}` });
  }

  // Strategy B: pierce locator
  if (!buttonClicked) {
    try {
      const count = await (page.locator("pierce/tux-button.add-gift-card-button") as any).count();
      sendMessage({ type: "log", level: "info", message: `[Amazon GC] pierce found ${count} tux-button.add-gift-card-button` });
      for (let i = 0; i < count; i++) {
        const btn = (page.locator("pierce/tux-button.add-gift-card-button") as any).nth(i);
        const text = await (btn as any).innerText().catch(() => "");
        if ((text || "").trim().includes("Add gift card to balance")) {
          const box = await (btn as any).boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            buttonClicked = true;
            sendMessage({ type: "log", level: "info", message: `[Amazon GC] Button clicked via pierce locator[${i}]` });
            break;
          }
        }
      }
    } catch (e) {
      sendMessage({ type: "log", level: "warn", message: `[Amazon GC] Strategy B failed: ${(e as Error).message}` });
    }
  }

  if (!buttonClicked) {
    sendMessage({ type: "log", level: "error", message: `[Amazon GC] Submit button not found` });
    return "not added";
  }

  // ── Step 9: Wait for result to appear (Amazon takes 1-2 seconds) ──
  await sleep(2000);

  const result = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();

    // Check hidden error/success input elements that Amazon uses
    const invalidGCInput = (document.getElementById("invalid-gift-card-message") as HTMLInputElement | null);
    const invalidCodeInput = (document.getElementById("invalid-claim-code-error-message") as HTMLInputElement | null);
    const captchaInput = (document.getElementById("gc-claim-page-enter-captcha-error-msg") as HTMLInputElement | null);

    const invalidGCValue = invalidGCInput?.value?.toLowerCase() || "";
    const invalidCodeValue = invalidCodeInput?.value?.toLowerCase() || "";
    const captchaValue = captchaInput?.value?.toLowerCase() || "";

    // Check tux-input error attribute
    const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
    const tuxError = tuxInput?.getAttribute?.("error") || "false";
    const tuxErrorMsg = tuxInput?.getAttribute?.("errormessage") || "";

    // Check if the "Add another gift card" section appeared (success indicator)
    const addAnotherBtn = document.getElementById("add-another-gift-card-button");
    const addAnotherVisible = addAnotherBtn && !addAnotherBtn.classList.contains("hidden");

    // Success keywords — must be in the actual result message, not generic page text
    const successPhrases = [
      "gift card has been added",
      "successfully added",
      "successfully applied",
      "gift card applied",
      "has been applied to your balance",
      "added to your gift card balance",
      "balance has been updated",
    ];
    const hasSuccess = successPhrases.some(p => text.includes(p));

    // Failure keywords — must appear in the page result section, not just any mention
    const failurePhrases = [
      "invalid gift card",
      "invalid promo code",
      "already been redeemed",
      "already been applied",
      "gift card code is not valid",
      "enter a valid gift card",
      "enter the alphanumeric gift card",
      "incorrect code",
      "captcha",
    ];
    const hasFailure = failurePhrases.some(p => text.includes(p));

    return {
      text: text.substring(0, 600),
      hasSuccess,
      hasFailure,
      invalidGCValue,
      invalidCodeValue,
      captchaValue,
      tuxError,
      tuxErrorMsg,
      addAnotherVisible,
      tuxInputErrorAttr: tuxError,
    };
  });

  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Result check after 2s:` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   hasSuccess: ${result.hasSuccess}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   hasFailure: ${result.hasFailure}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   tux-input error attr: ${result.tuxInputErrorAttr}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   tux-input error msg: ${result.tuxErrorMsg}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   addAnotherVisible: ${result.addAnotherVisible}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   invalidGCValue: ${result.invalidGCValue}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   invalidCodeValue: ${result.invalidCodeValue}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   body snippet: ${result.text.replace(/\s+/g, " ")}` });

  // Decision logic: failure takes priority over success
  if (result.hasFailure || result.tuxError === "true" || result.invalidGCValue || result.invalidCodeValue || result.captchaValue) {
    sendMessage({ type: "log", level: "info", message: `[Amazon GC] Result: FAILED` });
    return "not added";
  }

  if (result.hasSuccess || result.addAnotherVisible) {
    sendMessage({ type: "log", level: "info", message: `[Amazon GC] Result: SUCCESS` });
    return "added";
  }

  // Wait a bit longer and check again
  await sleep(2000);
  const finalResult = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const tuxInput = (window as any).document.querySelector("tux-input#claim-Code-input-box");
    const tuxError = tuxInput?.getAttribute?.("error") || "false";
    return {
      text: text.substring(0, 400),
      tuxError,
      successPhrases: ["gift card has been added", "successfully added", "successfully applied", "gift card applied", "has been applied"],
      hasSuccess: ["gift card has been added", "successfully added", "successfully applied", "gift card applied", "has been applied"].some(p => text.includes(p)),
      hasFailure: ["invalid gift card", "invalid promo code", "already been redeemed", "gift card code is not valid", "enter a valid gift card", "captcha"].some(p => text.includes(p)),
      addAnotherVisible: (() => {
        const btn = document.getElementById("add-another-gift-card-button");
        return btn && !btn.classList.contains("hidden");
      })(),
    };
  });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Final check (4s total):` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   hasSuccess: ${finalResult.hasSuccess}, hasFailure: ${finalResult.hasFailure}, addAnother: ${finalResult.addAnotherVisible}, tuxError: ${finalResult.tuxError}` });
  sendMessage({ type: "log", level: "info", message: `[Amazon GC]   body: ${finalResult.text.replace(/\s+/g, " ")}` });

  if (finalResult.hasFailure || finalResult.tuxError === "true") {
    sendMessage({ type: "log", level: "info", message: `[Amazon GC] Final result: FAILED` });
    return "not added";
  }
  if (finalResult.hasSuccess || finalResult.addAnotherVisible) {
    sendMessage({ type: "log", level: "info", message: `[Amazon GC] Final result: SUCCESS` });
    return "added";
  }

  sendMessage({ type: "log", level: "info", message: `[Amazon GC] Final result: UNKNOWN — treating as not added` });
  return "not added";
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

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

  const platform = config.platform || "flipkart";
  const maxRetries = config.maxRetries ?? 2;
  const cardTimeoutMs = config.cardTimeoutMs ?? 30000;
  const batchSize = config.batchSize ?? 50;

  // ── DB reporter setup (only when invoked with a jobId) ──────────────────
  let reporter: GiftCardJobReporter | null = null;
  let unsubscribeReporter: (() => void) | null = null;
  if (config.jobId && process.env.MONGODB_URI) {
    reporter = new GiftCardJobReporter(config.jobId);
    try {
      await reporter.connect(process.env.MONGODB_URI);
      await reporter.markRunning();
      reporter.start();
      unsubscribeReporter = onSendMessage((msg) => {
        const m = msg as { type?: string; level?: string; message?: string; cardNumber?: string; status?: string };
        if (m.type === "log" && m.level && m.message) {
          const level = (m.level === "warn" || m.level === "error" ? m.level : "info") as "info" | "warn" | "error";
          reporter!.log(level, m.message);
        } else if (m.type === "card_status" && m.cardNumber && m.status) {
          reporter!.cardResult({ cardNumber: m.cardNumber, status: m.status as "added" | "not added" });
        }
      });
    } catch (err) {
      console.error(`[giftCardRunner] reporter init failed: ${(err as Error).message} — continuing without DB updates`);
      reporter = null;
    }
  }

  sendMessage({
    type: "log",
    level: "info",
    message: `Gift Card Runner started — ${config.giftCards.length} cards on ${platform} (batch=${batchSize}, retries=${maxRetries})`,
  });

  if (!fs.existsSync("error-screenshots")) {
    fs.mkdirSync("error-screenshots", { recursive: true });
  }

  const browserManager = new BrowserManager();
  let instaDdrService: InstaDdrService | null = null;
  let runnerErrored: string | null = null;

  try {
    const { page } = await browserManager.launch(config.chromeProfileDir);

    // ── Optional Flipkart account login (mirrors BatchOrchestrator login block) ──
    if (config.account && platform === "flipkart") {
      const flipkartPlatform = new FlipkartPlatform(page, "https://www.flipkart.com");

      // Pick the InstaDDR account whose email matches the chosen account, else
      // fall back to the first one in the group.
      const instaDdrAccount = config.instaDdrAccounts && config.instaDdrAccounts.length > 0
        ? config.instaDdrAccounts.find((a) => a.email.toLowerCase() === config.account!.toLowerCase())
          ?? config.instaDdrAccounts[0]
        : undefined;

      if (instaDdrAccount) {
        sendMessage({ type: "log", level: "info", message: "Creating isolated InstaDDR browser context..." });
        const browser = page.browser() as Browser;
        const instaDdrContext = await browser.createBrowserContext();
        const instaDdrPage = await instaDdrContext.newPage();
        instaDdrService = new InstaDdrService(instaDdrPage, "https://m.kuku.lu", instaDdrContext);
      }

      const maskedEmail = `${config.account.substring(0, 3)}***`;
      sendMessage({
        type: "log",
        level: "info",
        message: `Logging in to Flipkart as ${maskedEmail}` +
          (instaDdrService ? " (InstaDDR auto-OTP)" : " (manual OTP — enter in browser)"),
      });

      const instaOptions = instaDdrService && instaDdrAccount
        ? { instaDdrService, instaDdrAccount }
        : undefined;

      await flipkartPlatform.loginWithEmail(config.account, instaOptions);

      if (!instaOptions) {
        // No InstaDDR — wait for manual OTP entry in the browser
        sendMessage({ type: "log", level: "info", message: `Waiting for manual OTP entry (up to 5 min)...` });
        const ok = await flipkartPlatform.waitForLoginCompletion(300000);
        if (!ok) throw new Error(`Login timed out for ${maskedEmail}`);
      }

      sendMessage({ type: "log", level: "info", message: `Login successful — proceeding with gift card additions` });
    }

    let added = 0;
    let failed = 0;
    const totalBatches = Math.ceil(config.giftCards.length / batchSize);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchStart = batchIdx * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, config.giftCards.length);
      const batch = config.giftCards.slice(batchStart, batchEnd);

      if (totalBatches > 1) {
        sendMessage({ type: "log", level: "info", message: `Batch ${batchIdx + 1}/${totalBatches} (cards ${batchStart + 1}–${batchEnd})` });
      }

      for (let i = 0; i < batch.length; i++) {
        const globalIdx = batchStart + i;
        const gc = batch[i];
        const masked = gc.cardNumber.length > 8
          ? gc.cardNumber.slice(0, 4) + "****" + gc.cardNumber.slice(-4)
          : gc.cardNumber.slice(0, 2) + "****";

        sendMessage({ type: "log", level: "info", message: `--- Card ${globalIdx + 1}/${config.giftCards.length} (${masked}) ---` });

        let status: "added" | "not added";
        try {
          if (platform === "amazon") {
            status = await addAmazonGiftCard(page, gc, masked, maxRetries, cardTimeoutMs);
          } else {
            status = await addFlipkartGiftCard(page, gc, masked, maxRetries, cardTimeoutMs);
          }
        } catch (err) {
          status = "not added";
          const errMsg = err instanceof Error ? err.message : String(err);
          sendMessage({ type: "log", level: "error", message: `Card ${masked} fatal error: ${errMsg}` });
          try {
            await page.screenshot({ path: `error-screenshots/giftcard-${platform}-${Date.now()}.png`, fullPage: true });
          } catch { /* ignore */ }
        }

        if (status === "added") {
          added++;
          sendMessage({ type: "progress", iteration: globalIdx + 1, total: config.giftCards.length, status: "success" });
          sendMessage({ type: "log", level: "info", message: `Card ${masked} added successfully` });
        } else {
          failed++;
          sendMessage({ type: "progress", iteration: globalIdx + 1, total: config.giftCards.length, status: "failed" });
          sendMessage({ type: "log", level: "error", message: `Card ${masked}: not added` });
        }

        sendMessage({ type: "card_status", cardNumber: gc.cardNumber, status } as any);

        if (globalIdx < config.giftCards.length - 1) {
          await sleep(300);
        }
      }
    }

    sendMessage({ type: "done", completed: added, failed });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    runnerErrored = errMsg;
    sendMessage({ type: "log", level: "error", message: `Gift Card Runner fatal error: ${errMsg}` });
  } finally {
    if (instaDdrService) {
      try {
        await instaDdrService.close();
      } catch {
        /* ignore */
      }
    }
    await browserManager.close();

    // Finalize DB record (if we have a reporter) — even if the runner errored
    if (reporter) {
      try {
        await reporter.finalize(
          runnerErrored ? "failed" : "completed",
          runnerErrored,
        );
      } catch (err) {
        console.error(`[giftCardRunner] reporter finalize failed:`, err);
      }
      if (unsubscribeReporter) unsubscribeReporter();
      await reporter.disconnect();
    }

    process.exit(runnerErrored ? 1 : 0);
  }
}

main();
