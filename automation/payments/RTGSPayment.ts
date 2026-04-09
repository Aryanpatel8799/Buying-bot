import { Page } from "puppeteer-core";
import { BasePayment } from "./BasePayment";
import { sleep } from "../core/helpers";

interface RTGSDetails {
  bankName: string;
}

/**
 * Flipkart RTGS / Net Banking Payment Strategy
 *
 * Flipkart RTGS Flow:
 *   1. Bot clicks RTGS payment option on the payment page
 *   2. Flipkart opens the bank's net banking portal (new tab or embedded)
 *   3. Bot clicks "Place Order" on the Flipkart checkout sidebar
 *   4. Original tab navigates to /payments/rtgs/poll
 *   5. Bot polls the poll page for order confirmation
 *   6. User manually completes bank authentication in the bank portal
 */
export class RTGSPayment extends BasePayment {
  private platform: "flipkart" | "amazon";

  constructor(page: Page, platform: "flipkart" | "amazon") {
    super(page);
    this.platform = platform;
  }

  async selectPaymentMethod(): Promise<void> {
    if (this.platform !== "flipkart") {
      throw new Error(`RTGS selector not configured for ${this.platform}`);
    }

    console.log("[RTGS] Waiting for RTGS button...");

    // Wait for RTGS div to appear with the correct state
    let rtgsButton: { x: number; y: number; disabled: boolean } | null = null;
    for (let attempt = 0; attempt < 30 && !rtgsButton; attempt++) {
      rtgsButton = await this.page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("div.nbl1sF"));
        const rtgsEl = els.find(
          (el) =>
            el.getAttribute("data-disabled") === "false" &&
            ((el as HTMLElement).innerText || "").includes("RTGS")
        ) as HTMLElement | undefined;

        if (!rtgsEl) return null;
        const rect = rtgsEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;

        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          disabled: rtgsEl.getAttribute("data-disabled") === "true",
        };
      });

      if (!rtgsButton) await sleep(300);
    }

    if (!rtgsButton) {
      throw new Error("RTGS button not found after 15s wait");
    }
    if (rtgsButton.disabled) {
      throw new Error("RTGS button is disabled — payment method not properly selected");
    }

    console.log(`[RTGS] RTGS button found at (${rtgsButton.x.toFixed(0)}, ${rtgsButton.y.toFixed(0)}) — clicking with real mouse...`);

    // Real mouse hover + click to ensure React sees it
    await this.page.mouse.move(rtgsButton.x, rtgsButton.y);
    await sleep(100);
    await this.page.mouse.click(rtgsButton.x, rtgsButton.y);
    console.log("[RTGS] RTGS button clicked with real mouse");

    // Brief wait for page to respond after RTGS selection
    await sleep(1000);

    // Detect if a new popup tab opened for the bank portal
    const browser = this.page.browser();
    const allPages = await browser.pages();
    const bankTabs = allPages.filter(
      (p) => p !== this.page && !p.url().startsWith("about:blank")
    );
    if (bankTabs.length > 0) {
      console.log(`[RTGS] Bank portal popup detected (${bankTabs.length} tab(s)): ${bankTabs.map((p) => p.url()).join(", ")}`);
    } else {
      console.log("[RTGS] No popup tab detected — bank portal may be embedded");
    }

    console.log("[RTGS] Payment method selected");
  }

  async fillDetails(_details: RTGSDetails): Promise<void> {
    // No additional fields to fill for RTGS
    console.log("[RTGS] No additional details required");
  }

  /**
   * Clicks the "Place Order" button on the RTGS payment page.
   * Finds the button → scrolls into view → clicks it → returns immediately.
   * The orchestrator handles the 2s wait and new tab opening.
   * Returns true if the button was found and clicked, false if not found.
   */
  async confirmPayment(): Promise<boolean> {
    if (this.platform !== "flipkart") {
      console.log("[RTGS] confirmPayment: not Flipkart, skipping");
      return true;
    }

    console.log("[RTGS] confirmPayment: looking for Place Order button...");

    // Brief wait for the page to render after RTGS selection
    await sleep(500);

    // Wait up to 10s for the button to appear
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await sleep(500);

      try {
        // Find the button and get its coordinates
        const buttonInfo = await this.page.evaluate(() => {
          // Strategy 1: Known Flipkart button class (fastest, most reliable)
          const knownBtn = document.querySelector("button.Button-module_button__P7hTI");
          if (knownBtn) {
            const text = (knownBtn.textContent || "").trim();
            if (text === "Place Order" && !(knownBtn as HTMLButtonElement).disabled) {
              (knownBtn as HTMLElement).scrollIntoView({ block: "center" });
              const rect = knownBtn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: "Button-module" };
              }
            }
          }

          // Strategy 2: Any <button> with exact text "Place Order"
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const btn of buttons) {
            const text = (btn.textContent || "").trim();
            if (text !== "Place Order") continue;
            if ((btn as HTMLButtonElement).disabled) continue;
            (btn as HTMLElement).scrollIntoView({ block: "center" });
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: "button-text" };
            }
            // Walk up for visible parent
            let el: HTMLElement | null = btn;
            while (el && el !== document.body) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: "button-parent" };
              }
              el = el.parentElement;
            }
          }

          // Strategy 3: div.OU_Jes container
          const containers = Array.from(document.querySelectorAll("div.OU_Jes"));
          for (const c of containers) {
            const btn = c.querySelector("button");
            if (btn && (btn.textContent || "").trim() === "Place Order") {
              (btn as HTMLElement).scrollIntoView({ block: "center" });
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: "OU_Jes" };
              }
            }
          }

          return null;
        });

        if (!buttonInfo) continue;

        const { x, y, strategy } = buttonInfo;
        console.log(`[RTGS] Place Order found via "${strategy}" at (${x.toFixed(0)}, ${y.toFixed(0)}) — clicking...`);

        // Click the button using mouse.click
        try {
          await this.page.mouse.click(x, y);
        } catch {
          // Click may trigger navigation which destroys context — that means it worked
          console.log("[RTGS] ✅ mouse.click triggered navigation!");
          return true;
        }

        // Wait up to 2s for the page to navigate away (URL change = click worked)
        const startUrl = this.page.url();
        for (let w = 0; w < 6; w++) {
          await sleep(300);
          try {
            const currentUrl = this.page.url();
            if (currentUrl !== startUrl || currentUrl.includes("/payments/rtgs/poll")) {
              console.log(`[RTGS] ✅ Page navigated to: ${currentUrl}`);
              return true;
            }
          } catch {
            // page.url() failed = page is mid-navigation = click worked
            console.log("[RTGS] ✅ Page navigating (context destroyed) — click worked!");
            return true;
          }
        }

        // URL didn't change — try JS click as fallback (button might need React event)
        console.log("[RTGS] mouse.click didn't navigate — trying JS click fallback...");
        const jsClickPromise = this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          for (const btn of btns) {
            if ((btn.textContent || "").trim() === "Place Order" && !btn.disabled) {
              btn.scrollIntoView({ block: "center" });
              btn.click();
              btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              return true;
            }
          }
          // Also try div.OU_Jes container
          const containers = Array.from(document.querySelectorAll("div.OU_Jes"));
          for (const c of containers) {
            const btn = c.querySelector("button");
            if (btn && (btn.textContent || "").trim() === "Place Order") {
              (c as HTMLElement).click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        // Race the JS click with a 5s timeout — never hang forever
        const jsResult = await Promise.race([
          jsClickPromise,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);

        if (jsResult) {
          // Check if navigation happened
          await sleep(500);
          try {
            const afterUrl = this.page.url();
            if (afterUrl.includes("/payments/rtgs/poll") || afterUrl !== startUrl) {
              console.log(`[RTGS] ✅ JS click worked — navigated to: ${afterUrl}`);
              return true;
            }
          } catch {
            console.log("[RTGS] ✅ JS click triggered navigation!");
            return true;
          }
        }

        console.log("[RTGS] Click attempt didn't trigger navigation — retrying...");
        // Continue to next attempt in the loop
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("context") || msg.includes("destroyed") || msg.includes("detached")) {
          // Page navigated — click worked!
          console.log("[RTGS] ✅ Place Order click triggered navigation!");
          return true;
        }
        console.log(`[RTGS] Attempt ${attempt + 1} error: ${msg}`);
      }
    }

    // Button not found after 10s — take debug screenshot
    try {
      const screenshotPath = `error-screenshots/rtgs-placeorder-debug-${Date.now()}.png`;
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[RTGS] DEBUG SCREENSHOT saved: ${screenshotPath}`);
    } catch { /* ignore */ }

    console.log("[RTGS] ❌ Place Order button not found after 10s");
    return false;
  }


  async waitForBankAuthCompletion(): Promise<boolean> {
    const timeout = 5 * 60 * 1000; // 5 minutes
    const deadline = Date.now() + timeout;

    console.log("[RTGS] Waiting for order confirmation...");
    console.log("=== RTGS PAYMENT IN PROGRESS ===");
    console.log("Complete the bank payment in the popup/tab that opened.");
    console.log("The bot will auto-detect when the order is confirmed.");
    console.log(`Timeout: 5 minutes`);

    while (Date.now() < deadline) {
      try {
        const currentUrl = this.page.url();

        // Poll page shows confirmation text
        if (currentUrl.includes("/payments/rtgs/poll")) {
          const confirmed = await this.page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return (
              text.includes("order placed") ||
              text.includes("order confirmed") ||
              text.includes("order has been placed") ||
              text.includes("thank you") ||
              text.includes("payment successful") ||
              text.includes("order success") ||
              text.includes("arriving")
            );
          });

          if (confirmed) {
            console.log("[RTGS] Order confirmed on poll page!");
            return true;
          }
        }

        // Navigated away from poll page — check for confirmation
        if (!currentUrl.includes("/payments/rtgs/poll") && currentUrl.includes("flipkart.com")) {
          const confirmed = await this.page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return (
              text.includes("order placed") ||
              text.includes("order confirmed") ||
              text.includes("thank you") ||
              text.includes("order success")
            );
          });
          if (confirmed) {
            console.log("[RTGS] Order confirmed!");
            return true;
          }
        }
      } catch {
        // Page transitioning — keep waiting
      }

      await sleep(2000);
    }

    console.log("[RTGS] Bank authentication timed out (5 minutes).");
    return false;
  }

  async verifyPaymentSuccess(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("order confirmed") ||
          text.includes("order placed") ||
          text.includes("payment successful") ||
          text.includes("order successful")
        );
      });
    } catch {
      return false;
    }
  }

  async isPaymentFailed(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("payment failed") ||
          text.includes("transaction failed") ||
          text.includes("payment declined")
        );
      });
    } catch {
      return false;
    }
  }
}
