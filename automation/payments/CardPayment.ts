import { Page } from "puppeteer-core";
import { BasePayment } from "./BasePayment";
import {
  clearAndType,
  sleep,
  waitAndClick,
  waitWithRetry,
} from "../core/helpers";

interface CardDetails {
  cardNumber: string;
  expiry: string; // "MM/YY" or "MM / YY"
  cvv: string;
}

/**
 * Card Payment Strategy
 *
 * Flipkart: card fields are shown directly on the payment page.
 * Amazon: select "Credit or debit card" → "Add a new card" → fill card form in iframe → enter CVV → confirm.
 */
export class CardPayment extends BasePayment {
  private platform: "flipkart" | "amazon";

  constructor(page: Page, platform: "flipkart" | "amazon") {
    super(page);
    this.platform = platform;
  }

  /**
   * Returns true when on a payment page — prevents waitWithRetry from
   * refreshing the page and disrupting user input (card details / OTP).
   */
  private isPaymentPage = async (): Promise<boolean> => {
    try {
      return await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("payment") ||
          text.includes("credit card") ||
          text.includes("debit card") ||
          text.includes("card number") ||
          text.includes("cvv") ||
          text.includes("expiry") ||
          text.includes("net banking") ||
          text.includes("gift card") ||
          text.includes("upi")
        );
      });
    } catch {
      return false;
    }
  };

  async selectPaymentMethod(): Promise<void> {
    if (this.platform === "flipkart") {
      console.log("Card payment method selected (Flipkart default)");
    } else {
      await this.amazonSelectCard();
    }
  }

  async fillDetails(details: CardDetails): Promise<void> {
    if (this.platform === "flipkart") {
      await this.flipkartFillCard(details);
    } else {
      await this.amazonFillCard(details);
    }
  }

  async confirmPayment(): Promise<boolean> {
    if (this.platform === "flipkart") {
      await this.flipkartConfirmPayment();
    } else {
      await this.amazonConfirmPayment();
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
          text.includes("payment successful") ||
          text.includes("order successful") ||
          text.includes("thank you")
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
          text.includes("payment failed") ||
          text.includes("transaction failed") ||
          text.includes("payment declined") ||
          text.includes("insufficient")
        );
      });
      return failed;
    } catch {
      return false;
    }
  }

  // ─── Flipkart Card Flow ───
  //
  // Confirmed Flipkart selectors:
  //   #cc-input          → <input id="cc-input" class="KgilpP" placeholder="XXXX XXXX XXXX XXXX" type="text" autocomplete="cc-number">
  //   input[placeholder="MM / YY"] → <input class="wZSAY0" placeholder="MM / YY" autocomplete="cc-exp" type="text">
  //   #cvv-input         → <input id="cvv-input" class="KgilpP" placeholder="CVV" type="password">

  private async flipkartFillCard(details: CardDetails): Promise<void> {
    const startUrl = this.page.url();
    console.log(`[FlipkartCard] Payment flow starting. URL: ${startUrl}`);

    // Wait for the page to stabilize after Continue click — max 15s
    // Keep polling until the URL stops changing AND the page has content
    console.log("[FlipkartCard] Waiting for page to stabilize...");
    let stableCount = 0;
    let lastUrl = "";
    let lastBodyLen = 0;
    for (let i = 0; i < 30; i++) { // 30 * 500ms = 15s
      try {
        const currentUrl = this.page.url();
        const bodyLen = await this.page.evaluate(() => document.body.innerText.length);
        if (currentUrl === lastUrl && bodyLen === lastBodyLen && bodyLen > 50) {
          stableCount++;
          if (stableCount >= 3) {
            console.log(`[FlipkartCard] Page stable (url=${currentUrl}, body=${bodyLen} chars)`);
            break;
          }
        } else {
          stableCount = 0;
          lastUrl = currentUrl;
          lastBodyLen = bodyLen;
          console.log(`[FlipkartCard] Page still loading... (url=${currentUrl}, body=${bodyLen})`);
        }
      } catch (err) {
        // Page may be in transition — ignore and wait
        console.log(`[FlipkartCard] Page evaluation error during wait: ${(err as Error).message}`);
      }
      await sleep(500);
    }

    // Now check the final URL
    const currentUrl = this.page.url();
    console.log(`[FlipkartCard] Final URL: ${currentUrl}`);

    if (currentUrl.includes("/viewcheckout")) {
      console.log("[FlipkartCard] Still on /viewcheckout — waiting more for redirect...");
      // Wait for URL to change away from viewcheckout
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const url = this.page.url();
        if (!url.includes("/viewcheckout")) {
          console.log(`[FlipkartCard] Redirected to: ${url}`);
          break;
        }
      }
    }

    // Dismiss any overlay with Escape
    await this.page.keyboard.press("Escape").catch(() => {});
    await sleep(200);

    // Wait for card fields to appear in DOM — poll without refreshing
    console.log("[FlipkartCard] Waiting for card fields to render...");
    let fieldsFound = false;
    for (let i = 0; i < 30; i++) { // 30 * 500ms = 15s max wait
      try {
        fieldsFound = await this.page.evaluate(() => {
          const cc = document.querySelector("#cc-input");
          const exp = document.querySelector("input.wZSAY0");
          const cvv = document.querySelector("#cvv-input");
          return !!cc && !!exp && !!cvv;
        });
        if (fieldsFound) break;
      } catch (err) {
        // Frame detached or page in transition — ignore and wait
        console.log(`[FlipkartCard] Evaluate error (poll ${i}): ${(err as Error).message}`);
      }
      await sleep(500);
    }

    if (!fieldsFound) {
      let debug: Record<string, unknown> = {};
      try {
        debug = await this.page.evaluate(() => {
          return {
            url: window.location.href,
            bodyText: document.body.innerText.slice(0, 200),
            ccExists: !!document.querySelector("#cc-input"),
            expExists: !!document.querySelector("input.wZSAY0"),
            cvvExists: !!document.querySelector("#cvv-input"),
            inputs: Array.from(document.querySelectorAll("input")).map((el: HTMLInputElement) => ({
              id: el.id, name: el.name, type: el.type, placeholder: el.placeholder
            })),
          };
        });
      } catch {
        debug = { url: "evaluate failed", error: "could not read DOM" };
      }
      console.log(`[FlipkartCard] Card fields not found. Debug: ${JSON.stringify(debug)}`);
      throw new Error(
        `Card fields not rendered after 15s. URL: ${(debug as { url?: string }).url}. ` +
        `cc=${(debug as { ccExists?: boolean }).ccExists} exp=${(debug as { expExists?: boolean }).expExists} cvv=${(debug as { cvvExists?: boolean }).cvvExists}`
      );
    }

    console.log("[FlipkartCard] All card fields rendered");

    // Fill card number
    const cardNum = details.cardNumber.replace(/\s/g, "");
    await this.flipkartFill("#cc-input", cardNum);

    // Fill expiry (convert MM/YYYY → MM / YY)
    const rawExp = (details.expiry || "").replace(/\s/g, "");
    let flipkartExpiry = rawExp;
    if (rawExp.includes("/")) {
      const [mm, yy] = rawExp.split("/");
      flipkartExpiry = `${mm} / ${yy.length === 4 ? yy.slice(2) : yy}`;
    }
    await this.flipkartFill("input.wZSAY0", flipkartExpiry);

    // Fill CVV
    await this.flipkartFill("#cvv-input", details.cvv);

    console.log("[FlipkartCard] Card fields filled");
  }

  /**
   * Fill a single card field: focus, clear, type, verify.
   * Does NOT use waitWithRetry — caller is responsible for ensuring the
   * card section is expanded first. waitWithRetry can cause page refreshes
   * that destroy form state on Flipkart.
   */
  private async flipkartFill(selector: string, value: string): Promise<void> {
    // Simple existence check — do NOT refresh the page
    const exists = await this.page.evaluate((sel: string) => !!document.querySelector(sel), selector);
    if (!exists) {
      throw new Error(`Card field "${selector}" not found in DOM`);
    }

    await sleep(50);

    // Focus + clear
    await this.page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      if (!el) return;
      el.focus();
      el.select();
    }, selector);

    // Type — page.type fires real keydown/keyup events React picks up naturally
    await this.page.type(selector, value, { delay: 30 });
    await sleep(100);

    // Verify
    const entered = await this.page.evaluate(
      (sel: string) => (document.querySelector(sel) as HTMLInputElement)?.value || "",
      selector
    );

    if (entered.replace(/\s/g, "") !== value.replace(/\s/g, "")) {
      // JS setter fallback — fires React-compatible input event
      await this.page.evaluate(
        (sel: string, val: string) => {
          const el = document.querySelector(sel) as HTMLInputElement;
          if (!el) return;
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          )?.set;
          setter?.call(el, val);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: val }));
        },
        selector,
        value
      );
      await sleep(100);
    }
  }

  private async flipkartConfirmPayment(): Promise<void> {
    try {
      await waitAndClick(
        this.page,
        'div[style*="background-color: rgb(255, 194, 0)"]',
        "Pay / Place Order button",
        15000
      );
    } catch {
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("div.css-146c3p1"));
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toUpperCase() || "";
          if (text === "PAY" || text.includes("PLACE ORDER") || text.includes("PAY ")) {
            (btn.closest("div[style*='cursor']") as HTMLElement)?.click();
            return;
          }
        }
      });
    }
    console.log("Payment confirmation clicked");
  }

  // ─── Amazon Card Flow ───

  private async amazonSelectCard(): Promise<void> {
    console.log("Selecting Credit or debit card on Amazon...");

    // Click the "Credit or debit card" payment option
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForSelector(
          ".pmts-selectable-add-credit-card, .pmts-instrument-box",
          { visible: true, timeout: 10000 }
        );
      },
      { label: "Credit card payment option", timeoutMs: 10000, maxRetries: 5, isPaymentPage: this.isPaymentPage }
    );

    await this.page.evaluate(() => {
      // Click the radio button or the payment row for "Credit or debit card"
      const row = document.querySelector(".pmts-selectable-add-credit-card");
      if (row) {
        const radio = row.querySelector('input[type="radio"]') as HTMLInputElement;
        if (radio) {
          radio.click();
        } else {
          (row as HTMLElement).click();
        }
        return;
      }
      // Fallback: find by text
      const boxes = Array.from(document.querySelectorAll(".pmts-instrument-box"));
      for (const box of boxes) {
        if (box.textContent?.includes("Credit or debit card")) {
          const r = box.querySelector('input[type="radio"]') as HTMLInputElement;
          if (r) r.click();
          else (box as HTMLElement).click();
          return;
        }
      }
    });

    console.log("Selected Credit or debit card");
    await sleep(300);

    // Click "Add a new credit or debit card" link
    console.log("Clicking Add a new card...");
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForSelector(
          "#apx-add-credit-card-action-test-id, .pmts-add-cc-default-trigger-link",
          { visible: true, timeout: 10000 }
        );
      },
      { label: "Add new card link", timeoutMs: 10000, maxRetries: 3, isPaymentPage: this.isPaymentPage }
    );

    await this.page.evaluate(() => {
      const link =
        document.querySelector("#apx-add-credit-card-action-test-id") ||
        document.querySelector(".pmts-add-cc-default-trigger-link");
      if (link) (link as HTMLElement).click();
    });

    console.log("Clicked Add a new card");
    await sleep(500);
  }

  private async amazonFillCard(details: CardDetails): Promise<void> {
    console.log("amazonFillCard called, details keys:", Object.keys(details || {}));

    // Parse expiry
    const rawExpiry = (details.expiry || "").replace(/\s/g, "");
    let expiryMonth: string;
    let expiryYear: string;

    if (rawExpiry.includes("/")) {
      const parts = rawExpiry.split("/");
      expiryMonth = parts[0];
      expiryYear = parts[1]?.length === 2 ? `20${parts[1]}` : parts[1] || "";
    } else if (rawExpiry.length === 4) {
      expiryMonth = rawExpiry.slice(0, 2);
      expiryYear = `20${rawExpiry.slice(2)}`;
    } else if (rawExpiry.length === 6) {
      expiryMonth = rawExpiry.slice(0, 2);
      expiryYear = rawExpiry.slice(2);
    } else {
      throw new Error(`Invalid expiry format: "${details.expiry}". Expected MM/YY or MM/YYYY.`);
    }

    console.log(`Parsed expiry: month=${expiryMonth}, year=${expiryYear}`);

    // ── Step 1: Enter card number ──
    // <input type="tel" name="addCreditCardNumber" class="a-input-text a-form-normal pmts-account-Number">
    console.log("Entering card number...");
    const cardSel = "input.pmts-account-Number";
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForSelector(cardSel, {
          visible: true,
          timeout: 10000,
        });
      },
      { label: "Card number input", timeoutMs: 10000, maxRetries: 5, isPaymentPage: this.isPaymentPage }
    );
    await sleep(300); // extra wait for the input to become interactive

    const cleanCardNumber = details.cardNumber.replace(/\s/g, "");

    // Method 1: Puppeteer's page.type() — clicks the element and types
    try {
      await this.page.click(cardSel);
      await sleep(100);
      await this.page.type(cardSel, cleanCardNumber, { delay: 100 });
      await sleep(100);
    } catch (e) {
      console.log(`page.type failed: ${e instanceof Error ? e.message : e}`);
    }

    // Check if value was entered
    let enteredValue = await this.page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      return el?.value || "";
    }, cardSel);
    console.log(`After page.type: card value = "${enteredValue}"`);

    // Method 2: If empty, try keyboard.type on focused element
    if (!enteredValue) {
      console.log("Method 1 failed, trying keyboard.type...");
      await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (el) { el.scrollIntoView({ block: "center" }); el.focus(); el.click(); }
      }, cardSel);
      await sleep(100);
      await this.page.keyboard.type(cleanCardNumber, { delay: 100 });
      await sleep(100);

      enteredValue = await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        return el?.value || "";
      }, cardSel);
      console.log(`After keyboard.type: card value = "${enteredValue}"`);
    }

    // Method 3: If still empty, force via JS native setter
    if (!enteredValue) {
      console.log("Method 2 failed, forcing via JS native setter...");
      await this.page.evaluate((sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (el) {
          el.focus();
          // Use native setter to bypass React/framework interception
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          )?.set;
          setter?.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        }
      }, cardSel, cleanCardNumber);
      await sleep(200);

      enteredValue = await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        return el?.value || "";
      }, cardSel);
      console.log(`After JS setter: card value = "${enteredValue}"`);
    }

    // Method 4: If STILL empty, try direct assignment
    if (!enteredValue) {
      console.log("Method 3 failed, trying direct value assignment...");
      await this.page.evaluate((sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (el) {
          el.value = val;
          ["input", "change", "keydown", "keypress", "keyup"].forEach(evt => {
            el.dispatchEvent(new Event(evt, { bubbles: true }));
          });
        }
      }, cardSel, cleanCardNumber);
      await sleep(200);

      enteredValue = await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        return el?.value || "";
      }, cardSel);
      console.log(`After direct assignment: card value = "${enteredValue}"`);
    }

    if (!enteredValue) {
      // Log debug info
      const debugInfo = await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (!el) return "ELEMENT NOT FOUND";
        return JSON.stringify({
          tagName: el.tagName,
          type: el.type,
          name: el.name,
          id: el.id,
          className: el.className,
          disabled: el.disabled,
          readOnly: el.readOnly,
          hidden: el.hidden,
          offsetWidth: el.offsetWidth,
          offsetHeight: el.offsetHeight,
        });
      }, cardSel);
      console.log(`Card input debug: ${debugInfo}`);
      throw new Error("Failed to enter card number after all methods");
    }

    console.log(`Card number entered successfully: ${enteredValue.length} chars`);

    // ── Step 2: Select expiry month ──
    // Find all dropdown triggers near the card form
    // Month is the first .a-button-dropdown, year is the second
    console.log(`Selecting expiry month: ${expiryMonth}...`);
    await this.selectAmazonExpiryDropdown(0, expiryMonth);
    await sleep(100);

    // ── Step 3: Select expiry year ──
    console.log(`Selecting expiry year: ${expiryYear}...`);
    await this.selectAmazonExpiryDropdown(1, expiryYear);
    await sleep(100);

    // ── Step 4: Click Continue ──
    console.log("Clicking Continue...");
    const continueBtn = await this.page.$(
      'input[name="ppw-widgetEvent:AddCreditCardEvent"]'
    );
    if (continueBtn) {
      await continueBtn.click();
    } else {
      // Fallback: find by text
      await this.page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll("span.a-button-text"));
        for (const span of spans) {
          if (span.textContent?.trim() === "Continue") {
            const input = span
              .closest(".a-button")
              ?.querySelector("input") as HTMLElement;
            if (input) { input.click(); return; }
            (span as HTMLElement).click();
            return;
          }
        }
      });
    }
    console.log("Clicked Continue");
    await sleep(100);

    // ── Step 5: Enter CVV ──
    console.log("Entering CVV...");
    await this.amazonEnterCVV(details.cvv);
    await sleep(100);
  }

  /**
   * Select month (index 0) or year (index 1) from Amazon's expiry dropdowns.
   * Uses Puppeteer's native click on ElementHandle to trigger Amazon's JS handlers.
   */
  private async selectAmazonExpiryDropdown(
    dropdownIndex: number,
    value: string
  ): Promise<void> {
    // Find all .a-button-dropdown elements inside the card form area
    // The card form has exactly 2 dropdowns: month (0) and year (1)
    const dropdowns = await this.page.$$('.a-button-dropdown');

    // Filter to only dropdowns near the card number input
    // by checking which ones are inside the add-card section
    let targetDropdowns = await this.page.$$(
      '.pmts-add-credit-card-component-container .a-button-dropdown'
    );

    // If no dropdowns found in the container, try broader search
    if (targetDropdowns.length === 0) {
      // Get dropdowns that have a-dropdown-prompt inside (expiry dropdowns)
      const filtered = [];
      for (const dd of dropdowns) {
        const prompt = await dd.$('.a-dropdown-prompt');
        if (prompt) {
          const text = await this.page.evaluate(
            (el: Element) => el.textContent?.trim() || "",
            prompt
          );
          // Month shows 01-12, year shows 20XX
          if (/^\d{1,2}$/.test(text) || /^\d{4}$/.test(text)) {
            filtered.push(dd);
          }
        }
      }
      targetDropdowns = filtered;
    }

    console.log(`Found ${targetDropdowns.length} expiry dropdowns, clicking index ${dropdownIndex}`);

    if (!targetDropdowns[dropdownIndex]) {
      throw new Error(
        `Expiry dropdown index ${dropdownIndex} not found (found ${targetDropdowns.length} dropdowns)`
      );
    }

    // Click the dropdown trigger using Puppeteer's native click
    await targetDropdowns[dropdownIndex].click();
    await sleep(300);

    // Wait for the dropdown popup to appear
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForSelector(".a-popover-wrapper .a-dropdown-item", {
          visible: true,
          timeout: 5000,
        });
      },
      { label: `Expiry dropdown ${value}`, timeoutMs: 5000, maxRetries: 3, isPaymentPage: this.isPaymentPage }
    );
    await sleep(100);

    // Click the matching option using Puppeteer's native click
    const items = await this.page.$$(".a-popover-wrapper .a-dropdown-item");
    let clicked = false;

    for (const item of items) {
      const text = await this.page.evaluate(
        (el: Element) => el.textContent?.trim() || "",
        item
      );
      if (text === value) {
        await item.click();
        clicked = true;
        console.log(`Selected expiry value: ${value}`);
        break;
      }
    }

    if (!clicked) {
      // Log what options are available
      const available = await this.page.evaluate(() => {
        const els = document.querySelectorAll(".a-popover-wrapper .a-dropdown-item");
        return Array.from(els).map(el => el.textContent?.trim() || "");
      });
      console.log(`Available options: ${JSON.stringify(available)}`);
      throw new Error(`Could not find expiry dropdown option: ${value}`);
    }

    await sleep(100);
  }

  /**
   * Enter CVV on Amazon — may be in an iframe.
   */
  private async amazonEnterCVV(cvv: string): Promise<void> {
    // First try: CVV field directly on the page
    const directField = await this.page.$(".card-cvv, #addCreditCardVerificationNumber");
    if (directField) {
      await clearAndType(this.page, ".card-cvv", cvv, "CVV");
      return;
    }

    // Second try: CVV field inside an iframe
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        const cvvField = await frame.$(".card-cvv, input[type='tel'][maxlength='4']");
        if (cvvField) {
          await cvvField.click();
          await sleep(100);
          await cvvField.type(cvv, { delay: 50 });
          console.log("Entered CVV in iframe");
          return;
        }
      } catch {
        // Frame not accessible, skip
      }
    }

    // Third try: wait for the field to appear (it may load after Continue)
    await waitWithRetry(
      this.page,
      async () => {
        // Check all frames again
        const allFrames = this.page.frames();
        for (const f of allFrames) {
          const field = await f.$(".card-cvv, input[type='tel'][maxlength='4']");
          if (field) return;
        }
        throw new Error("CVV field not found in any frame");
      },
      { label: "CVV field", timeoutMs: 10000, maxRetries: 5, isPaymentPage: this.isPaymentPage }
    );

    // Retry after wait
    const retryFrames = this.page.frames();
    for (const frame of retryFrames) {
      try {
        const cvvField = await frame.$(".card-cvv, input[type='tel'][maxlength='4']");
        if (cvvField) {
          await cvvField.click();
          await sleep(100);
          await cvvField.type(cvv, { delay: 50 });
          console.log("Entered CVV in iframe (after retry)");
          return;
        }
      } catch {
        // Skip
      }
    }

    throw new Error("Could not find CVV field on Amazon payment page");
  }

  private async amazonConfirmPayment(): Promise<void> {
    console.log('Clicking "Use this payment method"...');

    // Wait for the button to be enabled and click it
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            const btn = document.querySelector(
              '[data-testid="secondary-continue-button"], ' +
                'input[aria-labelledby="checkout-secondary-continue-button-id-announce"]'
            ) as HTMLInputElement;
            return btn && !btn.disabled;
          },
          { timeout: 15000 }
        );
      },
      { label: "Use this payment method button", timeoutMs: 15000, maxRetries: 5, isPaymentPage: this.isPaymentPage }
    );

    await this.page.evaluate(() => {
      const btn = document.querySelector(
        '[data-testid="secondary-continue-button"], ' +
          'input[aria-labelledby="checkout-secondary-continue-button-id-announce"]'
      ) as HTMLElement;
      if (btn) btn.click();
    });

    console.log("Clicked Use this payment method");
    await sleep(500);

    // Amazon may show a "Place your order" final step
    try {
      await this.page.waitForSelector(
        '#submitOrderButtonId input, input[name="placeYourOrder1"]',
        { visible: true, timeout: 10000 }
      );
      await this.page.evaluate(() => {
        const placeOrder = document.querySelector(
          '#submitOrderButtonId input, input[name="placeYourOrder1"]'
        ) as HTMLElement;
        if (placeOrder) placeOrder.click();
      });
      console.log("Clicked Place your order");
    } catch {
      console.log("No separate Place Order step found, payment may already be submitted");
    }
  }
}
