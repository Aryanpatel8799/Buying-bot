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
      // Click the "Have a Flipkart Gift Card? Add" button
      console.log('Waiting for "Have a Flipkart Gift Card?" button ...');
      await this.page.waitForSelector("div.DF3_NF", {
        visible: true,
        timeout: 15000,
      });
      // Click the "Add" span inside the gift card section
      await this.page.evaluate(() => {
        const container = document.querySelector("div.DF3_NF");
        if (container) {
          const addBtn = container.querySelector("span.v_6Ifl");
          if (addBtn) {
            (addBtn as HTMLElement).click();
          } else {
            (container as HTMLElement).click();
          }
        }
      });
      console.log("Clicked Gift Card Add button");
      await sleep(300);

      // Click the gift card checkbox
      const checked = await this.page.evaluate(() => {
        const cb = document.querySelector("input.Checkbox-module_input-checkbox__3IlN4.CJ7EqD") as HTMLInputElement | null;
        if (cb && !cb.checked) {
          cb.click();
          return true;
        }
        return false;
      });
      if (checked) {
        console.log("Gift card checkbox ticked");
        await sleep(200);
      }
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
      // Enter voucher number
      await clearAndType(
        this.page,
        "#egvNumber",
        details.code,
        "Voucher Number"
      );
      await sleep(200);

      // Enter voucher PIN
      if (details.pin) {
        await clearAndType(this.page, "#pin", details.pin, "Voucher PIN");
        await sleep(200);
      }
    } else {
      // Amazon: the input sits inside a <tux-input> shadow DOM.
      const code = details.code;
      console.log(`[Amazon GC] === fillDetails start === code length: ${code.length}`);

      // Step 1: Check page state
      const pageInfo = await this.page.evaluate(() => {
        const tuxInput = document.querySelector("tux-input#claim-Code-input-box");
        const bodyText = document.body.innerText.substring(0, 200).replace(/\s+/g, " ");
        return {
          tuxInputFound: !!tuxInput,
          tuxInputTagName: tuxInput?.tagName,
          tuxInputHTML: tuxInput?.outerHTML?.substring(0, 300),
          bodySnippet: bodyText,
          allTuxInputs: document.querySelectorAll("tux-input").length,
          allInputs: document.querySelectorAll("input").length,
          hasShadowRoot: !!(tuxInput as any)?.shadowRoot,
          shadowRootHTML: (tuxInput as any)?.shadowRoot?.innerHTML?.substring(0, 300),
        };
      });
      console.log(`[Amazon GC] Step 1 - Page state:`);
      console.log(`  tux-input found: ${pageInfo.tuxInputFound}`);
      console.log(`  tagName: ${pageInfo.tuxInputTagName}`);
      console.log(`  tux-input count: ${pageInfo.allTuxInputs}`);
      console.log(`  total inputs: ${pageInfo.allInputs}`);
      console.log(`  has shadowRoot: ${pageInfo.hasShadowRoot}`);
      console.log(`  shadowRoot HTML: ${pageInfo.shadowRootHTML}`);
      console.log(`  body snippet: ${pageInfo.bodySnippet}`);

      // Step 2: Check if we can find input via pierce in page context
      const pierceCheck = await this.page.evaluate(() => {
        // Try pierce-style walk
        function walkShadow(root: Document | ShadowRoot | Element): any {
          const found = root.querySelector('input.input-tag[name="claimCode"]');
          if (found) {
            return { found: true, tagName: found.tagName, value: (found as HTMLInputElement).value, rect: found.getBoundingClientRect() };
          }
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as Element).shadowRoot) {
              const n = walkShadow((el as Element).shadowRoot!);
              if (n?.found) return n;
            }
          }
          return { found: false };
        }
        const result = walkShadow(document);
        // Also try regular query
        const regular = document.querySelector('input[name="claimCode"]') as HTMLInputElement | null;
        return {
          pierce: result,
          regular: regular ? { found: true, value: regular.value, rect: regular.getBoundingClientRect() } : { found: false },
          pierceShadowWalkers: document.querySelectorAll("*").length,
        };
      });
      console.log(`[Amazon GC] Step 2 - Pierce check:`);
      console.log(`  pierce found: ${pierceCheck.pierce.found}`);
      if (pierceCheck.pierce.found) {
        console.log(`  pierce value: "${pierceCheck.pierce.value}"`);
        console.log(`  pierce rect: ${JSON.stringify(pierceCheck.pierce.rect)}`);
      }
      console.log(`  regular found: ${pierceCheck.regular.found}`);
      if (pierceCheck.regular.found) {
        console.log(`  regular value: "${pierceCheck.regular.value}"`);
        console.log(`  regular rect: ${JSON.stringify(pierceCheck.regular.rect)}`);
      }
      console.log(`  DOM elements to walk: ${pierceCheck.pierceShadowWalkers}`);

      // Step 3: Click tux-input to activate
      console.log(`[Amazon GC] Step 3 - Clicking tux-input element...`);
      await this.page.evaluate(() => {
        const tuxInput = document.querySelector("tux-input#claim-Code-input-box") as HTMLElement | null;
        if (tuxInput) {
          tuxInput.scrollIntoView({ block: "center" });
          tuxInput.click();
          console.log("[Amazon GC] tux-input clicked via evaluate");
        } else {
          console.log("[Amazon GC] tux-input NOT FOUND in evaluate");
        }
        // Also try clicking the inner input directly
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
          console.log("[Amazon GC] inner shadow input clicked via evaluate");
        } else {
          console.log("[Amazon GC] inner shadow input NOT FOUND");
        }
      });
      await sleep(600);

      // Step 4: Check focused element
      const focusedInfo = await this.page.evaluate(() => {
        const active = document.activeElement;
        return {
          activeTagName: active?.tagName,
          activeClass: active?.className?.substring(0, 100),
          activeValue: (active as HTMLInputElement)?.value,
          activeShadowRoot: !!(active as Element)?.shadowRoot,
          activeShadowHTML: (active as Element)?.shadowRoot?.innerHTML?.substring(0, 200),
          allShadowInputs: (() => {
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
            return walkShadow(document)?.value || "(not found)";
          })(),
        };
      });
      console.log(`[Amazon GC] Step 4 - Focused element:`);
      console.log(`  activeTagName: ${focusedInfo.activeTagName}`);
      console.log(`  activeClass: ${focusedInfo.activeClass}`);
      console.log(`  activeValue: "${focusedInfo.activeValue}"`);
      console.log(`  activeHasShadow: ${focusedInfo.activeShadowRoot}`);
      console.log(`  activeShadowHTML: ${focusedInfo.activeShadowHTML}`);
      console.log(`  allShadowInputs value: "${focusedInfo.allShadowInputs}"`);

      // Step 5: Try page.type() on pierce selector
      console.log(`[Amazon GC] Step 5 - Trying page.type('input[name="claimCode"]', ...) with ${code.length} chars`);
      let pageTypeError = "";
      try {
        await this.page.type('input[name="claimCode"]', code, { delay: 30 });
        console.log(`[Amazon GC] page.type() completed without error`);
      } catch (e) {
        pageTypeError = (e as Error).message;
        console.log(`[Amazon GC] page.type() error: ${pageTypeError}`);
      }
      await sleep(300);

      // Step 6: Verify after page.type()
      const afterType = await this.page.evaluate(() => {
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
        const shadowVal = walkShadow(document)?.value || "";
        const regularVal = (document.querySelector('input[name="claimCode"]') as HTMLInputElement)?.value || "";
        const activeVal = (document.activeElement as HTMLInputElement)?.value || "";
        return { shadowVal, regularVal, activeVal };
      });
      console.log(`[Amazon GC] Step 6 - Value after page.type():`);
      console.log(`  shadow DOM value: "${afterType.shadowVal}"`);
      console.log(`  regular DOM value: "${afterType.regularVal}"`);
      console.log(`  active element value: "${afterType.activeVal}"`);

      // Step 7: If not set, try native setter + InputEvent
      if (!afterType.shadowVal || afterType.shadowVal.length < code.length) {
        console.log(`[Amazon GC] Step 7 - page.type() failed (value="${afterType.shadowVal}"). Trying native setter + InputEvent...`);
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
          const input = walkShadow(document) as HTMLInputElement | null;
          if (!input) { console.log("FAIL: input not found in walkShadow"); return; }

          console.log(`Setting value via native setter: ${val.substring(0, 4)}****`);
          input.focus();

          // Use native setter
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, val);
          console.log(`Setter called. Current value: ${input.value}`);

          // Fire input event (bubble through shadow boundary with composed)
          input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
          input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          input.blur();
          console.log(`Events dispatched. Final value: ${input.value}`);
        }, code);
        await sleep(500);

        // Verify
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
        console.log(`[Amazon GC] Step 7 result - shadow DOM value: "${afterSetter}"`);

        if (!afterSetter || afterSetter.length < code.length) {
          console.log(`[Amazon GC] ERROR: native setter also failed. Throwing.`);
          throw new Error(`[Amazon GC] Failed to enter code. Shadow DOM value: "${afterSetter}"`);
        }
      } else {
        console.log(`[Amazon GC] Step 6 SUCCESS - code entered via page.type()`);
      }

      console.log(`[Amazon GC] === fillDetails complete ===`);
    }
  }

  async confirmPayment(): Promise<boolean> {
    if (this.platform === "flipkart") {
      // Click the "APPLY" button after entering gift card details
      console.log('Clicking "APPLY" for gift card ...');
      try {
        // Try clicking a button/div with text "APPLY" near the gift card inputs
        await this.page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll(
              "button, div[class*='semibold'], span[class*='semibold']"
            )
          );
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toUpperCase() || "";
            if (text === "APPLY") {
              (btn as HTMLElement).click();
              return;
            }
          }
        });
      } catch {
        // Fallback: try clicking submit-like button near gift card section
        await waitAndClick(
          this.page,
          'button[type="submit"]',
          "Gift Card Apply",
          10000
        );
      }
      console.log("Gift card applied");
      await sleep(500);

      // Now click "Place Order" / "PAY" button
      console.log("Clicking Place Order ...");
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
      console.log("Payment confirmation clicked");
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
