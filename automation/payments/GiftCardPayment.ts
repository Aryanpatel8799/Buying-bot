import { Page } from "puppeteer-core";
import { BasePayment } from "./BasePayment";
import { clearAndType, sleep, waitAndClick } from "../core/helpers";

// @ts-ignore - customQueryHandlers exists at runtime but not in puppeteer-core v24 types
import * as puppeteerCore from "puppeteer-core";

interface GiftCardDetails {
  code: string;
  pin?: string;
}

// ── Register pierce query handler for Amazon web components ──
// @ts-ignore - customQueryHandlers exists at runtime but not in puppeteer-core v24 types
(puppeteerCore.customQueryHandlers as any).register("pierce", {
  queryOne(root: Document | ShadowRoot | Element, selector: string): Element | null {
    const found = root.querySelector(selector);
    if (found) return found;
    const all = root.querySelectorAll("*");
    for (const el of Array.from(all)) {
      if ((el as Element).shadowRoot) {
        const nested = this.queryOne((el as Element).shadowRoot!, selector);
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
        results.push(...this.queryAll((el as Element).shadowRoot!, selector));
      }
    }
    return results;
  },
});

export class GiftCardPayment extends BasePayment {
  private platform: "flipkart" | "amazon";

  constructor(page: Page, platform: "flipkart" | "amazon") {
    super(page);
    this.platform = platform;
  }

  async selectPaymentMethod(): Promise<void> {
    if (this.platform === "flipkart") {
      // Flipkart: gift card is already added to the account.
      // Just tick the checkbox to apply the gift card balance during checkout.
      console.log("[Flipkart GC] Waiting for gift card checkbox...");
      await this.page.waitForSelector(
        'input[type="checkbox"].Checkbox-module_input-checkbox__3IlN4.CJ7EqD',
        { visible: true, timeout: 15000 }
      );

      // Use native Puppeteer click for real mouse events
      const checkbox = await this.page.$('input[type="checkbox"].Checkbox-module_input-checkbox__3IlN4.CJ7EqD');
      if (checkbox) {
        const isChecked = await this.page.evaluate(
          (el) => (el as HTMLInputElement).checked,
          checkbox
        );
        if (!isChecked) {
          await checkbox.click();
          console.log("[Flipkart GC] Gift card checkbox ticked");
        } else {
          console.log("[Flipkart GC] Gift card checkbox already checked");
        }
      } else {
        // Fallback: try evaluate click
        const checked = await this.page.evaluate(() => {
          const cb = document.querySelector("input.Checkbox-module_input-checkbox__3IlN4.CJ7EqD") as HTMLInputElement | null;
          if (cb && !cb.checked) {
            cb.click();
            return true;
          }
          return cb?.checked || false;
        });
        if (checked) {
          console.log("[Flipkart GC] Gift card checkbox ticked (evaluate fallback)");
        } else {
          throw new Error("[Flipkart GC] Gift card checkbox not found");
        }
      }
      await sleep(1000);
      console.log("[Flipkart GC] Gift card balance applied");
    } else {
      // Amazon: navigate to gift card redemption page
      console.log("[Amazon GC] Navigating to gift card redemption page...");
      await this.page.goto("https://www.amazon.in/gift-gc/claim", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await sleep(2000);
      console.log("[Amazon GC] On gift card page");
    }
  }

  async fillDetails(details: GiftCardDetails): Promise<void> {
    if (this.platform === "flipkart") {
      // Flipkart: gift card balance is already on the account.
      // No code/PIN entry needed — checkbox was ticked in selectPaymentMethod().
      console.log("[Flipkart GC] No details to fill — gift card balance already applied via checkbox");
    } else {
      // Amazon: the input sits inside a <tux-input> shadow DOM.
      const code = details.code;
      console.log(`[Amazon GC] === fillDetails start === code length: ${code.length}`);

      // Click tux-input to activate and find the input
      await this.page.evaluate(() => {
        const tuxInput = document.querySelector("tux-input#claim-Code-input-box") as HTMLElement | null;
        if (tuxInput) {
          tuxInput.scrollIntoView({ block: "center" });
          tuxInput.click();
        }
        function walkShadow(root: Document | ShadowRoot | Element): HTMLInputElement | null {
          const found = root.querySelector('input.input-tag[name="claimCode"]');
          if (found) return found as HTMLInputElement;
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as Element).shadowRoot) {
              const n = walkShadow((el as Element).shadowRoot!);
              if (n) return n;
            }
          }
          return null;
        }
        const innerInput = walkShadow(document);
        if (innerInput) {
          innerInput.scrollIntoView({ block: "center" });
          innerInput.click();
        }
      });
      await sleep(600);

      // Try page.type() first
      let typed = false;
      try {
        await this.page.type('input[name="claimCode"]', code, { delay: 30 });
        typed = true;
        console.log(`[Amazon GC] page.type() completed`);
      } catch (e) {
        console.log(`[Amazon GC] page.type() error: ${(e as Error).message}`);
      }
      await sleep(300);

      // Verify value
      const currentVal = await this.page.evaluate(() => {
        function walkShadow(root: Document | ShadowRoot | Element): HTMLInputElement | null {
          const found = root.querySelector('input.input-tag[name="claimCode"]');
          if (found) return found as HTMLInputElement;
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as Element).shadowRoot) {
              const n = walkShadow((el as Element).shadowRoot!);
              if (n) return n;
            }
          }
          return null;
        }
        return walkShadow(document)?.value || "";
      });

      // If not set, try native setter + InputEvent
      if (!currentVal || currentVal.length < code.length) {
        console.log(`[Amazon GC] page.type() failed (value="${currentVal}"). Trying native setter...`);
        await this.page.evaluate((val: string) => {
          function walkShadow(root: Document | ShadowRoot | Element): HTMLInputElement | null {
            const found = root.querySelector('input.input-tag[name="claimCode"]');
            if (found) return found as HTMLInputElement;
            const all = root.querySelectorAll("*");
            for (const el of Array.from(all)) {
              if ((el as Element).shadowRoot) {
                const n = walkShadow((el as Element).shadowRoot!);
                if (n) return n;
              }
            }
            return null;
          }
          const input = walkShadow(document);
          if (!input) throw new Error("input not found in walkShadow");
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, val);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
          input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          input.blur();
        }, code);
        await sleep(500);

        // Verify again
        const afterSetter = await this.page.evaluate(() => {
          function walkShadow(root: Document | ShadowRoot | Element): HTMLInputElement | null {
            const found = root.querySelector('input.input-tag[name="claimCode"]');
            if (found) return found as HTMLInputElement;
            const all = root.querySelectorAll("*");
            for (const el of Array.from(all)) {
              if ((el as Element).shadowRoot) {
                const n = walkShadow((el as Element).shadowRoot!);
                if (n) return n;
              }
            }
            return null;
          }
          return walkShadow(document)?.value || "";
        });
        if (!afterSetter || afterSetter.length < code.length) {
          throw new Error(`[Amazon GC] Failed to enter code. Value: "${afterSetter}"`);
        }
      }
      console.log(`[Amazon GC] === fillDetails complete ===`);
    }
  }

  async confirmPayment(): Promise<boolean> {
    if (this.platform === "flipkart") {
      // Flipkart: gift card balance applied via checkbox — just click Place Order
      console.log("[Flipkart GC] Clicking Place Order ...");
      try {
        await waitAndClick(
          this.page,
          'div[style*="background-color: rgb(255, 194, 0)"]',
          "Place Order button",
          15000
        );
      } catch {
        await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("div, button, span"));
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toUpperCase() || "";
            if (
              text === "PLACE ORDER" ||
              text.includes("PAY ") ||
              text === "PAY"
            ) {
              (btn.closest("div[style*='cursor']") as HTMLElement)?.click();
              return;
            }
          }
        });
      }
      console.log("[Flipkart GC] Payment confirmation clicked");
    } else {
      // Amazon: click the "Add gift card to balance" tux-button
      console.log("[Amazon GC] Clicking submit button...");
      const clicked = await this.clickShadowButton();
      if (!clicked) {
        throw new Error('Submit button "Add gift card to balance" not found');
      }
      await sleep(3000);
      console.log("[Amazon GC] Gift card applied");
    }
    return true;
  }

  async verifyPaymentSuccess(): Promise<boolean> {
    try {
      const success = await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("order confirmed") ||
          text.includes("order placed") ||
          text.includes("order successful")
        );
      });
      return success;
    } catch {
      return false;
    }
  }

  async isPaymentFailed(): Promise<boolean> {
    try {
      const failed = await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("invalid gift card") ||
          text.includes("invalid voucher") ||
          text.includes("gift card expired") ||
          text.includes("insufficient balance") ||
          text.includes("payment failed")
        );
      });
      return failed;
    } catch {
      return false;
    }
  }

  /**
   * Recursively walk shadow DOMs to find and click the "Add gift card to balance" button.
   * Uses page.evaluate() to access shadow DOM elements, then CDP mouse for clicking.
   */
  private async clickShadowButton(): Promise<boolean> {
    // Strategy 1: Use pierce locator with bounding box + CDP click (most reliable)
    try {
      // @ts-ignore - .count() exists at runtime
      const count = await (this.page.locator("pierce/tux-button.add-gift-card-button") as any).count();
      console.log(`[Amazon GC] Found ${count} tux-button.add-gift-card-button via pierce`);
      for (let i = 0; i < count; i++) {
        try {
          // @ts-ignore - nth() exists at runtime
          const btn = (this.page.locator("pierce/tux-button.add-gift-card-button") as any).nth(i);
          // @ts-ignore - boundingBox() exists at runtime
          const box = await (btn as any).boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            const text = await (btn as any).innerText().catch(() => "");
            if ((text || "").trim().includes("Add gift card to balance")) {
              await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              console.log(`[Amazon GC] Clicked button[${i}] at (${box.x + box.width / 2}, ${box.y + box.height / 2})`);
              return true;
            }
          }
        } catch { /* continue to next */ }
      }
    } catch { /* fall through */ }

    // Strategy 2: Walk shadow DOM manually, click by JS dispatch
    try {
      const clicked = await this.page.evaluate(() => {
        function walkShadow(root: Document | ShadowRoot | Element): Element | null {
          // Try direct query
          const found = root.querySelector('tux-button.add-gift-card-button');
          if (found) return found;
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as Element).shadowRoot) {
              const nested = walkShadow((el as Element).shadowRoot!);
              if (nested) return nested;
            }
          }
          return null;
        }

        const btn = walkShadow(document) as HTMLElement | null;
        if (!btn) return false;

        // Check text
        const text = (btn as any).shadowRoot
          ? (btn as any).shadowRoot.textContent || ""
          : btn.textContent || "";
        if (!text.trim().includes("Add gift card to balance")) return false;

        // Try clicking the button inside shadow root
        if ((btn as any).shadowRoot) {
          const innerBtn = (btn as any).shadowRoot.querySelector("button");
          if (innerBtn) {
            (innerBtn as HTMLElement).click();
            return true;
          }
        }
        btn.click();
        return true;
      });
      if (clicked) {
        console.log("[Amazon GC] Button clicked via JS evaluate");
        return true;
      }
    } catch (err) {
      console.log("[Amazon GC] JS button click error:", (err as Error).message);
    }

    // Strategy 3: Click by coordinates (fallback)
    try {
      const coords = await this.page.evaluate(() => {
        function walkShadow(root: Document | ShadowRoot | Element): Element | null {
          const found = root.querySelector('tux-button.add-gift-card-button');
          if (found) return found;
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as Element).shadowRoot) {
              const nested = walkShadow((el as Element).shadowRoot!);
              if (nested) return nested;
            }
          }
          return null;
        }
        const btn = walkShadow(document);
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      if (coords) {
        await this.page.mouse.click(coords.x, coords.y);
        console.log(`[Amazon GC] Clicked by coords (${coords.x}, ${coords.y})`);
        return true;
      }
    } catch (err) {
      console.log("[Amazon GC] Coord button click error:", (err as Error).message);
    }

    return false;
  }
}
