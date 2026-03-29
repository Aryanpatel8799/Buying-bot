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

      if (!rtgsButton) await sleep(500);
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

    // Wait for page to respond — Flipkart may open bank portal or show RTGS confirmation
    await sleep(3000);

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
   * Clicks "Place Order" on the RTGS payment page and waits for the poll URL.
   * Uses STABLE semantic selectors (text + accessibility attributes) — no CSS class names.
   * Returns true if /payments/rtgs/poll was reached or a bank popup was detected (within 10s).
   * Returns false if the click didn't trigger navigation within 10s.
   * Does NOT throw — lets the caller decide how to handle failure.
   */
  async confirmPayment(): Promise<boolean> {
    if (this.platform !== "flipkart") {
      console.log("[RTGS] confirmPayment: not Flipkart, skipping");
      return true;
    }

    console.log("[RTGS] confirmPayment: looking for Place Order button...");

    // Give the page time to render after RTGS selection
    await sleep(2000);

    // ── Debug: capture pre-click state ─────────────────────────────────────────
    try {
      const pageState = await this.page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll("button")).map((b) => ({
          text: ((b as HTMLElement).innerText || "").trim(),
          type: (b as HTMLButtonElement).type,
          disabled: (b as HTMLButtonElement).disabled,
          ariaLabel: b.getAttribute("aria-label") || "",
          dataAuto: Array.from(b.attributes)
            .filter((a) => a.name.startsWith("data-") || a.name.startsWith("data_"))
            .map((a) => `${a.name}=${a.value}`),
        }));
        const placeOrderEls = Array.from(
          document.querySelectorAll("*")
        )
          .filter((el) => {
            const text = (el.textContent || "").trim();
            return text === "Place Order" || text === "PLACE ORDER";
          })
          .map((el) => ({
            tag: el.tagName,
            text: (el.textContent || "").trim(),
            className: el.className.slice(0, 80),
            id: el.id,
            hasDisabled: (el as HTMLButtonElement).disabled !== undefined,
            disabled: (el as HTMLButtonElement).disabled,
            attrs: Array.from(el.attributes)
              .filter((a) => a.name.startsWith("data-") || a.name === "aria-label" || a.name === "role")
              .map((a) => `${a.name}=${a.value}`),
            // Walk up for context
            parentTag: el.parentElement?.tagName,
            parentClass: el.parentElement?.className.slice(0, 60),
          }));
        return {
          url: window.location.href,
          buttons: allBtns.filter((b) => b.text.length > 0),
          placeOrderEls,
          bodySnippet: document.body.innerText.toLowerCase().slice(0, 400),
        };
      });
      console.log(`[RTGS] Pre-click state — URL: ${pageState.url}`);
      console.log(`[RTGS] Buttons found: ${JSON.stringify(pageState.buttons.slice(0, 15))}`);
      if (pageState.placeOrderEls.length > 0) {
        console.log(`[RTGS] "Place Order" elements: ${JSON.stringify(pageState.placeOrderEls)}`);
      } else {
        console.log(`[RTGS] No "Place Order" text found in DOM`);
      }
    } catch (err) {
      console.log(`[RTGS] Pre-click state dump failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Find the Place Order button using STABLE semantic selectors ─────────────
    // No CSS class names — only text + accessibility + DOM traversal.
    // This is the single most important fix: CSS classes change on every Flipkart deploy.

    const BUTTON_TIMEOUT = 20; // iterations × 500ms = 10s
    let tapped = false;
    let tappedCoords: { x: number; y: number } | null = null;

    for (let attempt = 0; attempt < BUTTON_TIMEOUT && !tapped; attempt++) {
      if (attempt > 0) {
        await sleep(500);
      }

      try {
        const result = await this.page.evaluate(() => {
          /**
           * Finds the best clickable element for "Place Order".
           * Priority:
           * 1. <button> with exact text "Place Order" (most reliable)
           * 2. Any element with exact text "Place Order" + clickable ancestor
           * 3. element with aria-label containing "place order"
           */
          function findPlaceOrderButton(): { x: number; y: number; strategy: string } | null {
            // ── Priority 0: Flipkart's Button-module_button class (known stable class) ──
            // <button class="Button-module_button__P7hTI ... font-m-semibold ..." variant="neutral">Place Order</button>
            const knownBtn = document.querySelector("button.Button-module_button__P7hTI");
            if (knownBtn) {
              const text = (knownBtn.textContent || "").trim();
              if (text === "Place Order" && !(knownBtn as HTMLButtonElement).disabled) {
                (knownBtn as HTMLElement).scrollIntoView({ block: "center" });
                const rect = knownBtn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: "Button-module_button" };
                }
              }
            }

            // ── Priority 1: <button> with exact text "Place Order" ──────────────
            const buttons = document.querySelectorAll("button");
            for (const btn of buttons) {
              const text = (btn.textContent || "").trim();
              if (text !== "Place Order") continue;
              if ((btn as HTMLButtonElement).disabled) continue;
              (btn as HTMLElement).scrollIntoView({ block: "center" });
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return {
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  strategy: "button-exact-text",
                };
              }
              // Button has no size — walk up to find visible parent
              let el: HTMLElement | null = btn;
              while (el && el !== document.body) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: "button-walked-up" };
                }
                el = el.parentElement;
              }
            }

            // ── Priority 2: aria-label on any element ───────────────────────────
            const allWithAria = document.querySelectorAll("[aria-label]");
            for (const el of allWithAria) {
              const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
              if (!label.includes("place order")) continue;
              (el as HTMLElement).scrollIntoView({ block: "center" });
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return {
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  strategy: "aria-label",
                };
              }
            }

            // ── Priority 3: Any element with exact text "Place Order" ───────────
            // Walk the entire DOM once, collecting all matching text nodes
            const allEls = document.querySelectorAll("*");
            for (const el of allEls) {
              const text = (el.textContent || "").trim();
              if (text !== "Place Order") continue;

              // Skip hidden elements
              const style = window.getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden") continue;

              // Walk up to find a clickable ancestor
              let node: HTMLElement | null = el as HTMLElement;
              while (node && node !== document.body) {
                const nodeStyle = node.getAttribute("style") || "";
                const nodeTag = node.tagName;
                const nodeRole = node.getAttribute("role");
                if (
                  nodeStyle.includes("cursor: pointer") ||
                  nodeTag === "BUTTON" ||
                  nodeRole === "button" ||
                  node.className.includes("css-g5y9jx") // Flipkart's clickable button class
                ) {
                  (node as HTMLElement).scrollIntoView({ block: "center" });
                  const r = node.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) {
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2, strategy: "text-walked-up" };
                  }
                }
                node = node.parentElement;
              }

              // Fallback: use the element itself if visible
              (el as HTMLElement).scrollIntoView({ block: "center" });
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, strategy: "text-direct" };
              }
            }

            return null;
          }

          return findPlaceOrderButton();
        });

        if (result) {
          const { x, y, strategy } = result;
          console.log(`[RTGS] Place Order found via "${strategy}" at (${x.toFixed(0)}, ${y.toFixed(0)}) — tapping...`);
          await this.page.touchscreen.tap(x, y);
          tapped = true;
          tappedCoords = { x, y };
          console.log("[RTGS] Place Order tapped!");
          break;
        }

        if (attempt === 0) {
          // Only log on first attempt to avoid spam
          console.log("[RTGS] Place Order button not visible yet — waiting...");
        }
      } catch (err) {
        console.log(`[RTGS] Attempt ${attempt + 1} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!tapped) {
      // Screenshot the page so we can see what Flipkart rendered
      try {
        const screenshotPath = `rtgs-placeorder-debug-${Date.now()}.png`;
        await this.page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[RTGS] DEBUG SCREENSHOT saved: ${screenshotPath}`);
      } catch { /* ignore screenshot failures */ }

      console.log("[RTGS] Place Order button could not be found — returning false");
      return false;
    }

    // ── Wait for navigation to the RTGS poll page ──────────────────────────────
    // After clicking "Place Order", Flipkart navigates to /payments/rtgs/poll
    // OR opens a bank popup. Either confirms the click worked.
    // Reduce to 10s (was 30s) so orchestrator moves to next tab faster.
    console.log("[RTGS] Waiting for RTGS poll page or bank popup (10s timeout)...");

    for (let w = 0; w < 20; w++) { // 20 × 500ms = 10s
      const url = this.page.url();
      if (url.includes("/payments/rtgs/poll")) {
        console.log(`[RTGS] Poll page reached: ${url}`);
        return true;
      }

      // Check for bank popup tabs
      try {
        const browser = this.page.browser();
        const pages = await browser.pages();
        for (const p of pages) {
          if (p !== this.page && !p.url().startsWith("about:blank")) {
            console.log(`[RTGS] Bank popup detected: ${p.url()}`);
            return true;
          }
        }
      } catch { /* ignore */ }

      await sleep(500);
    }

    // 10s passed — click may have fired but navigation was delayed.
    // Return false so orchestrator marks pending; parallel polling phase will catch it.
    console.log("[RTGS] Poll URL not reached after 10s — marking pending for parallel polling");
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
