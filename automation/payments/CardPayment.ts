import { Page } from "puppeteer-core";
import { BasePayment } from "./BasePayment";
import {
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
    // Strategy 1: Click the <button> "Pay ₹..." button (payment gateway page)
    const btnClicked = await this.page.evaluate(() => {
      // Match button with class containing "Button-module_button" and text starting with "Pay"
      const buttons = document.querySelectorAll('button[class*="Button-module_button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text.startsWith("Pay") || text.includes("Pay ")) {
          (btn as HTMLElement).click();
          return "button-module";
        }
      }
      // Also try any <button> whose text starts with "Pay ₹"
      const allButtons = document.querySelectorAll("button");
      for (const btn of allButtons) {
        const text = (btn.textContent || "").trim();
        if (/^Pay\s*₹/.test(text)) {
          (btn as HTMLElement).click();
          return "button-pay-rupee";
        }
      }
      return null;
    });

    if (btnClicked) {
      console.log(`Payment confirmation clicked (${btnClicked})`);
      return;
    }

    // Strategy 2: Yellow background div (Flipkart checkout page)
    try {
      await waitAndClick(
        this.page,
        'div[style*="background-color: rgb(255, 194, 0)"]',
        "Pay / Place Order button",
        15000
      );
      console.log("Payment confirmation clicked (yellow div)");
      return;
    } catch { /* fall through */ }

    // Strategy 3: Text-based fallback in React Native Web divs
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
    console.log("Payment confirmation clicked (text fallback)");
  }

  // ─── Amazon Card Flow ───

  private async amazonSelectCard(): Promise<void> {
    console.log("Selecting Credit or debit card on Amazon...");

    // Wait for the "Credit or debit card" row to appear
    await waitWithRetry(
      this.page,
      async () => {
        const found = await this.page.evaluate(() => {
          const divs = document.querySelectorAll('[data-pmts-component-id]');
          for (const div of divs) {
            if ((div.textContent || "").includes("Credit or debit card")) return true;
          }
          return !!document.querySelector('.pmts-selectable-add-credit-card, .pmts-instrument-box');
        });
        if (!found) throw new Error("Credit card payment row not found");
      },
      { label: "Credit card payment option", timeoutMs: 10000, maxRetries: 5, isPaymentPage: this.isPaymentPage }
    );

    // Strategy 1: Native Puppeteer click on the radio button (fires real mouse events)
    let expanded = false;
    const radioSelector = 'input[type="radio"][name="ppw-instrumentRowSelection"][value="SelectableAddCreditCard"]';
    const radioEl = await this.page.$(radioSelector);
    if (radioEl) {
      await radioEl.click();
      console.log("Clicked credit card radio button (native)");
      await sleep(1500);
      expanded = await this.isAddCardLinkVisible();
    }

    // Strategy 2: Native click on the label wrapping the radio
    if (!expanded) {
      const labelClicked = await this.page.evaluate((sel: string) => {
        const input = document.querySelector(sel);
        if (input) {
          const label = input.closest("label");
          if (label) { label.click(); return "label"; }
        }
        return null;
      }, radioSelector);
      if (labelClicked) {
        console.log("Clicked radio label");
        await sleep(1500);
        expanded = await this.isAddCardLinkVisible();
      }
    }

    // Strategy 3: Native Puppeteer click on the row div containing "Credit or debit card"
    if (!expanded) {
      const rowHandle = await this.page.evaluateHandle(() => {
        const divs = document.querySelectorAll('[data-pmts-component-id]');
        for (const div of divs) {
          if ((div.textContent || "").includes("Credit or debit card")) {
            return div as HTMLElement;
          }
        }
        return null;
      });
      const rowEl = rowHandle.asElement() as import("puppeteer-core").ElementHandle<Element> | null;
      if (rowEl) {
        try {
          await this.page.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "center" }), rowEl);
          await sleep(300);
          await rowEl.click();
          console.log("Clicked credit card row (native Puppeteer click)");
          await sleep(1500);
          expanded = await this.isAddCardLinkVisible();
        } catch (e) {
          console.log(`Row native click failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Strategy 4: Click the bold "Credit or debit card" text span itself
    if (!expanded) {
      const boldSpans = await this.page.$$('span.a-text-bold');
      for (const boldHandle of boldSpans) {
        const textContent = await this.page.evaluate(el => el.textContent || "", boldHandle);
        if (textContent.includes("Credit or debit card")) {
          await boldHandle.click();
          console.log("Clicked bold text span (native)");
          await sleep(1500);
          expanded = await this.isAddCardLinkVisible();
          break;
        }
      }
    }

    // Strategy 5: Force-unhide the hidden "Add a new card" section
    if (!expanded) {
      console.log("All click strategies failed to expand — force-unhiding the hidden section...");
      await this.page.evaluate(() => {
        // Find all hidden divs that contain "Add a new credit"
        const hiddenDivs = document.querySelectorAll('.a-hidden, .aok-hidden, [style*="display: none"]');
        for (const div of hiddenDivs) {
          if ((div.textContent || "").includes("Add a new credit")) {
            (div as HTMLElement).classList.remove("a-hidden", "aok-hidden");
            (div as HTMLElement).style.display = "";
          }
        }
        // Also try by ID pattern: pp-XXXXX-115
        const innerDivs = document.querySelectorAll('div[id^="pp-"][id$="-115"]');
        for (const div of innerDivs) {
          if ((div.textContent || "").includes("Add a new credit")) {
            (div as HTMLElement).classList.remove("a-hidden", "aok-hidden");
            (div as HTMLElement).style.display = "";
          }
        }
      });
      await sleep(1000);
      expanded = await this.isAddCardLinkVisible();
      console.log(`After force-unhide, 'Add a new card' visible: ${expanded}`);
    }

    console.log(`Selected Credit or debit card (expanded: ${expanded})`);

    // Now click "Add a new credit or debit card" link
    console.log("Clicking 'Add a new credit or debit card'...");
    await waitWithRetry(
      this.page,
      async () => {
        const visible = await this.isAddCardLinkVisible();
        if (!visible) throw new Error("Add new card link not visible yet");
      },
      { label: "Add new card link", timeoutMs: 10000, maxRetries: 5, isPaymentPage: this.isPaymentPage }
    );
    await sleep(300);

    // Use native Puppeteer click on the link for real mouse events
    let linkClicked = false;

    // Try #apx-add-credit-card-action-test-id first
    const triggerEl = await this.page.$("#apx-add-credit-card-action-test-id");
    if (triggerEl) {
      try {
        await triggerEl.click();
        linkClicked = true;
        console.log("Clicked via #apx-add-credit-card-action-test-id (native)");
      } catch { /* fall through */ }
    }

    // Try the link itself
    if (!linkClicked) {
      const linkEl = await this.page.$(".pmts-add-cc-default-trigger-link");
      if (linkEl) {
        try {
          await linkEl.click();
          linkClicked = true;
          console.log("Clicked via .pmts-add-cc-default-trigger-link (native)");
        } catch { /* fall through */ }
      }
    }

    // Fallback: find visible link by text with native click
    if (!linkClicked) {
      const linkHandle = await this.page.evaluateHandle(() => {
        const links = document.querySelectorAll('a[href="#"]');
        for (const el of links) {
          if ((el.textContent || "").toLowerCase().includes("add a new credit") &&
              (el as HTMLElement).offsetWidth > 0) {
            return el as HTMLElement;
          }
        }
        return null;
      });
      const el = linkHandle.asElement() as import("puppeteer-core").ElementHandle<Element> | null;
      if (el) {
        await el.click();
        linkClicked = true;
        console.log("Clicked 'Add a new card' link by text (native)");
      }
    }

    // Last resort: evaluate click
    if (!linkClicked) {
      await this.page.evaluate(() => {
        const trigger = document.getElementById("apx-add-credit-card-action-test-id");
        if (trigger) { (trigger as HTMLElement).click(); return; }
        const links = document.querySelectorAll('a');
        for (const el of links) {
          if ((el.textContent || "").toLowerCase().includes("add a new credit")) {
            el.click();
            return;
          }
        }
      });
      console.log("Clicked 'Add a new card' via evaluate fallback");
    }

    console.log("Clicked Add a new card");
    await sleep(500);
  }

  /** Check if the "Add a new credit or debit card" link is visible on page */
  private async isAddCardLinkVisible(): Promise<boolean> {
    return await this.page.evaluate(() => {
      // Check #apx-add-credit-card-action-test-id
      const trigger = document.getElementById("apx-add-credit-card-action-test-id");
      if (trigger && (trigger as HTMLElement).offsetWidth > 0 && (trigger as HTMLElement).offsetHeight > 0) {
        return true;
      }
      // Check links with "Add a new credit" text
      const links = document.querySelectorAll('a[href="#"]');
      for (const el of links) {
        if ((el.textContent || "").toLowerCase().includes("add a new credit") &&
            (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0) {
          return true;
        }
      }
      return false;
    });
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

    // Step 0 & 1 are now handled by amazonSelectCard() which is called before fillDetails().
    // Verify the card form is ready by checking if "Add a new card" was already clicked.
    const addCardVisible = await this.isAddCardLinkVisible();
    if (addCardVisible) {
      // The link is still visible meaning it wasn't clicked yet — click it now as a safety net
      console.log("[amazonFillCard] 'Add a new card' link still visible — clicking it...");
      const triggerEl = await this.page.$("#apx-add-credit-card-action-test-id");
      if (triggerEl) {
        await triggerEl.click();
      } else {
        const linkEl = await this.page.$(".pmts-add-cc-default-trigger-link");
        if (linkEl) await linkEl.click();
      }
      await sleep(2000);
    }

    // ── Step 2: Find the card number input (may be in an iframe) ──
    console.log("Looking for card number input...");
    const cardSel = 'input[type="tel"][name="addCreditCardNumber"]';

    // Debug: list all frames
    const allFrames = this.page.frames();
    console.log(`[amazonFillCard] Total frames: ${allFrames.length}`);
    for (let i = 0; i < allFrames.length; i++) {
      const f = allFrames[i];
      console.log(`[amazonFillCard] Frame ${i}: url=${f.url().substring(0, 80)} name=${f.name()}`);
    }

    // Wait for card input to appear in any frame
    const cardResult: { el: import("puppeteer-core").ElementHandle | null; frame: import("puppeteer-core").Frame | null } = { el: null, frame: null };

    await waitWithRetry(
      this.page,
      async () => {
        // Try main page
        const found = await this.page.$(cardSel);
        if (found) { cardResult.el = found; cardResult.frame = this.page.mainFrame(); return; }
        // Try each frame
        for (const frame of allFrames) {
          try {
            const fEl = await frame.$(cardSel);
            if (fEl) { cardResult.el = fEl; cardResult.frame = frame; return; }
          } catch {
            // Frame not accessible, skip
          }
        }
        // Fallback: id-based selector
        for (const frame of allFrames) {
          try {
            const fEl = await frame.$('input[id^="pp-"][type="tel"]');
            if (fEl) { cardResult.el = fEl; cardResult.frame = frame; return; }
          } catch {
            // skip
          }
        }
        // Fallback: just the name attribute (type may not always be "tel")
        for (const frame of allFrames) {
          try {
            const fEl = await frame.$('input[name="addCreditCardNumber"]');
            if (fEl) { cardResult.el = fEl; cardResult.frame = frame; return; }
          } catch {
            // skip
          }
        }
        throw new Error("Card input not found yet");
      },
      { label: "Card number input", timeoutMs: 15000, maxRetries: 10, isPaymentPage: this.isPaymentPage }
    );

    if (!cardResult.el || !cardResult.frame) {
      throw new Error("Card input not found after waiting — check debug logs");
    }

    const cardInput = cardResult.el;
    const cardFrame = cardResult.frame;
    console.log(`[amazonFillCard] Card input found in frame: ${cardFrame.url().substring(0, 80)}`);
    await sleep(300);

    const cleanCardNumber = details.cardNumber.replace(/\s/g, "");

    // Helper: verify card value via the correct frame
    const getCardValue = async (): Promise<string> => {
      return await cardFrame.evaluate(() => {
        // Try name-only selector — more stable than type+name combo
        const el = (
          document.querySelector('input[name="addCreditCardNumber"]') ||
          document.querySelector('input[type="tel"][name="addCreditCardNumber"]')
        ) as HTMLInputElement | null;
        return el?.value || "";
      });
    };

    // Method 1: Click the element, then type via frame context
    try {
      await cardInput.click();
      await sleep(150);
      await cardFrame.evaluate((val: string) => {
        const el = document.querySelector('input[type="tel"][name="addCreditCardNumber"]') as HTMLInputElement | null;
        if (!el) return;
        el.focus();
        el.select();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, cleanCardNumber);
      await sleep(100);
    } catch (e) {
      console.log(`Method 1 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    let enteredValue = await getCardValue();
    console.log(`After method 1: card value = "${enteredValue}"`);

    // Method 2: If empty, triple-click to select all, then keyboard.type
    if (!enteredValue) {
      console.log("Method 1 failed, trying method 2 (triple-click + keyboard.type)...");
      try {
        await cardInput.click({ clickCount: 3 });
        await sleep(150);
        await this.page.keyboard.type(cleanCardNumber, { delay: 80 });
        await sleep(100);
      } catch (e) {
        console.log(`Method 2 failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      enteredValue = await getCardValue();
      console.log(`After method 2: card value = "${enteredValue}"`);
    }

    // Method 3: If still empty, force via JS native setter within the frame
    if (!enteredValue) {
      console.log("Method 2 failed, forcing via JS native setter in frame...");
      try {
        await cardFrame.evaluate((val: string) => {
          const el = document.querySelector('input[type="tel"][name="addCreditCardNumber"]') as HTMLInputElement | null;
          if (!el) return;
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          setter?.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        }, cleanCardNumber);
        await sleep(200);
      } catch (e) {
        console.log(`Method 3 failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      enteredValue = await getCardValue();
      console.log(`After method 3: card value = "${enteredValue}"`);
    }

    // Method 4: If STILL empty, direct value assignment in frame
    if (!enteredValue) {
      console.log("Method 3 failed, trying method 4 (direct assignment in frame)...");
      try {
        await cardFrame.evaluate((val: string) => {
          const el = document.querySelector('input[type="tel"][name="addCreditCardNumber"]') as HTMLInputElement | null;
          if (!el) return;
          el.value = val;
          ["input", "change", "keydown", "keypress", "keyup"].forEach(evt => {
            el.dispatchEvent(new Event(evt, { bubbles: true }));
          });
        }, cleanCardNumber);
        await sleep(200);
      } catch (e) {
        console.log(`Method 4 failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      enteredValue = await getCardValue();
      console.log(`After method 4: card value = "${enteredValue}"`);
    }

    if (!enteredValue) {
      // Log all inputs visible in the frame for debugging
      try {
        const frameDebug = await cardFrame.evaluate(() => {
          return Array.from(document.querySelectorAll("input")).slice(0, 15).map(el => ({
            type: el.type,
            name: el.name,
            id: el.id,
            placeholder: el.placeholder,
            maxLength: el.maxLength,
            className: el.className,
            visible: el.offsetWidth > 0 && el.offsetHeight > 0,
          }));
        });
        console.log(`[amazonFillCard] Inputs in frame: ${JSON.stringify(frameDebug)}`);
      } catch {
        // ignore
      }
      throw new Error("Failed to enter card number after all methods");
    }

    console.log(`Card number entered successfully: ${enteredValue.length} chars`);

    // ── Step 4: Select expiry month ──
    // Find all dropdown triggers near the card form
    // Month is the first .a-button-dropdown, year is the second
    console.log(`Selecting expiry month: ${expiryMonth}...`);
    await this.selectAmazonExpiryDropdown(0, expiryMonth);
    await sleep(100);

    // ── Step 5: Select expiry year ──
    console.log(`Selecting expiry year: ${expiryYear}...`);
    await this.selectAmazonExpiryDropdown(1, expiryYear);
    await sleep(100);

    // ── Step 6: Click Continue ──
    // <input name="ppw-widgetEvent:AddCreditCardEvent" class="a-button-input" type="submit">
    console.log("Clicking Continue...");
    await waitWithRetry(
      this.page,
      async () => {
        // Search all frames for the Continue button
        for (const frame of allFrames) {
          try {
            const btn = await frame.$('input[name="ppw-widgetEvent:AddCreditCardEvent"]');
            if (btn) return;
          } catch { /* skip */ }
        }
        // Also check main page
        const mainBtn = await this.page.$('input[name="ppw-widgetEvent:AddCreditCardEvent"]');
        if (mainBtn) return;
        throw new Error("Continue button not found");
      },
      { label: "Continue button", timeoutMs: 10000, maxRetries: 3, isPaymentPage: this.isPaymentPage }
    );
    await sleep(300);
    const continueClicked = await this.page.evaluate(() => {
      const inputs = document.querySelectorAll('input[name="ppw-widgetEvent:AddCreditCardEvent"]');
      for (const input of inputs) {
        if ((input as HTMLInputElement).disabled) continue;
        (input as HTMLInputElement).click();
        return true;
      }
      return false;
    });
    if (continueClicked) {
      console.log("Clicked Continue");
    } else {
      // Fallback: try in frames
      for (const frame of allFrames) {
        try {
          const clicked = await frame.evaluate(() => {
            const inputs = document.querySelectorAll('input[name="ppw-widgetEvent:AddCreditCardEvent"]');
            for (const input of inputs) {
              if ((input as HTMLInputElement).disabled) continue;
              (input as HTMLInputElement).click();
              return true;
            }
            return false;
          });
          if (clicked) { console.log("Clicked Continue (from frame)"); break; }
        } catch { /* skip */ }
      }
    }
    // ── Step 7+8: Wait for CVV section and enter CVV ──
    // Fast poll — do NOT use waitWithRetry here because isPaymentPage triggers a 2-min sleep
    console.log("Waiting for CVV section to appear...");
    let cvvSectionReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        cvvSectionReady = await this.page.evaluate(() => {
          const selectedCard = document.querySelector(".pmts-credit-card-row.pmts-selected");
          if (!selectedCard) return false;
          const text = (selectedCard as HTMLElement).innerText || "";
          return text.includes("Enter CVV") || text.includes("CVV");
        });
      } catch { /* skip */ }

      // Also check if CVV iframe input is already accessible in any frame
      if (!cvvSectionReady) {
        for (const frame of this.page.frames()) {
          try {
            const input = await frame.$('input.card-cvv, input#field[type="tel"]');
            if (input) { cvvSectionReady = true; break; }
          } catch { /* skip */ }
        }
      }

      if (cvvSectionReady) break;
      if (attempt % 10 === 9) {
        console.log(`[CVV section] Still waiting (attempt ${attempt + 1}/30)...`);
      }
      await sleep(500);
    }
    if (!cvvSectionReady) {
      throw new Error("CVV section not found after 15s");
    }
    console.log("CVV section ready, entering CVV...");
    await this.amazonEnterCVV(details.cvv);
  }

  /**
   * Select month (index 0) or year (index 1) from Amazon's expiry dropdowns.
   * Uses Puppeteer's native click on ElementHandle to trigger Amazon's JS handlers.
   */
  private async selectAmazonExpiryDropdown(
    dropdownIndex: number,
    value: string
  ): Promise<void> {
    const allFrames = this.page.frames();
    let targetDropdowns: import("puppeteer-core").ElementHandle[] = [];
    let targetFrame: import("puppeteer-core").Frame | null = null;

    // Search in each frame
    for (const frame of allFrames) {
      try {
        const containers = await frame.$$('.pmts-add-credit-card-component-container .a-button-dropdown');
        if (containers.length > 0) {
          targetDropdowns = containers;
          targetFrame = frame;
          console.log(`[expiryDropdown] Found ${containers.length} dropdowns in frame: ${frame.url().substring(0, 80)}`);
          break;
        }
      } catch {
        // skip inaccessible frame
      }
    }

    // Fallback: search all .a-button-dropdown in all frames
    if (targetDropdowns.length === 0) {
      for (const frame of allFrames) {
        try {
          const dropdowns = await frame.$$('.a-button-dropdown');
          const filtered = [];
          for (const dd of dropdowns) {
            const prompt = await dd.$('.a-dropdown-prompt');
            if (prompt) {
              const text = await frame.evaluate((el: Element) => el.textContent?.trim() || "", prompt);
              if (/^\d{1,2}$/.test(text) || /^\d{4}$/.test(text)) {
                filtered.push(dd);
              }
            }
          }
          if (filtered.length > 0) {
            targetDropdowns = filtered;
            targetFrame = frame;
            console.log(`[expiryDropdown] Found ${filtered.length} expiry dropdowns in frame: ${frame.url().substring(0, 80)}`);
            break;
          }
        } catch {
          // skip
        }
      }
    }

    // If still nothing, search main page
    if (targetDropdowns.length === 0) {
      const containers = await this.page.$$('.pmts-add-credit-card-component-container .a-button-dropdown');
      if (containers.length > 0) {
        targetDropdowns = containers;
        targetFrame = this.page.mainFrame();
      } else {
        const dropdowns = await this.page.$$('.a-button-dropdown');
        for (const dd of dropdowns) {
          const prompt = await dd.$('.a-dropdown-prompt');
          if (prompt) {
            const text = await this.page.evaluate((el: Element) => el.textContent?.trim() || "", prompt);
            if (/^\d{1,2}$/.test(text) || /^\d{4}$/.test(text)) {
              targetDropdowns.push(dd);
            }
          }
        }
        targetFrame = this.page.mainFrame();
      }
    }

    console.log(`[expiryDropdown] Found ${targetDropdowns.length} expiry dropdowns, clicking index ${dropdownIndex}`);

    if (!targetDropdowns[dropdownIndex] || !targetFrame) {
      throw new Error(`Expiry dropdown index ${dropdownIndex} not found (found ${targetDropdowns.length} dropdowns)`);
    }

    await targetDropdowns[dropdownIndex].click();
    await sleep(300);

    // Wait for the dropdown popup to appear
    const frameUrl = targetFrame.url().substring(0, 80);
    await waitWithRetry(
      this.page,
      async () => {
        // Check both main page and the target frame
        const mainItems = await this.page.$$(".a-popover-wrapper .a-dropdown-item");
        if (mainItems.length > 0) { targetFrame = this.page.mainFrame(); return; }
        for (const frame of allFrames) {
          try {
            const items = await frame.$$(".a-popover-wrapper .a-dropdown-item");
            if (items.length > 0) { targetFrame = frame; return; }
          } catch { /* skip */ }
        }
        throw new Error("Dropdown items not visible");
      },
      { label: `Expiry dropdown ${value}`, timeoutMs: 5000, maxRetries: 3, isPaymentPage: this.isPaymentPage }
    );
    await sleep(100);

    // Click the matching option
    let clicked = false;
    const framesToCheck = [targetFrame, ...allFrames.filter(f => f !== targetFrame)];

    for (const frame of framesToCheck) {
      try {
        const items = await frame.$$(".a-popover-wrapper .a-dropdown-item");
        for (const item of items) {
          const text = await frame.evaluate((el: Element) => el.textContent?.trim() || "", item);
          if (text === value) {
            await item.click();
            clicked = true;
            console.log(`[expiryDropdown] Selected ${value}`);
            break;
          }
        }
        if (clicked) break;
      } catch { /* skip */ }
    }

    if (!clicked) {
      // Log available options
      const available: string[] = [];
      for (const frame of framesToCheck) {
        try {
          const items = await frame.$$(".a-popover-wrapper .a-dropdown-item");
          for (const item of items) {
            const text = await frame.evaluate((el: Element) => el.textContent?.trim() || "", item);
            available.push(text);
          }
        } catch { /* skip */ }
      }
      console.log(`[expiryDropdown] Available options: ${JSON.stringify(available)}`);
      throw new Error(`Could not find expiry dropdown option: ${value}`);
    }

    await sleep(100);
  }

  /**
   * Enter CVV on Amazon.
   * The CVV field (input#field.card-cvv) lives inside Amazon's secure iframe
   * which Puppeteer cannot access the DOM of directly.
   * Instead: click the iframe element to focus the input, then use page.keyboard to type.
   */
  private async amazonEnterCVV(cvv: string): Promise<void> {
    console.log("[amazonEnterCVV] Looking for CVV input across all frames...");

    // Primary approach: scan all frames for the CVV input directly (fast)
    let cvvInput: import("puppeteer-core").ElementHandle | null = null;
    let cvvFrame: import("puppeteer-core").Frame | null = null;
    const cvvSelectors = ['input.card-cvv', 'input#field[type="tel"]'];

    for (let attempt = 0; attempt < 20; attempt++) {
      for (const frame of this.page.frames()) {
        for (const sel of cvvSelectors) {
          try {
            const input = await frame.$(sel);
            if (input) {
              cvvInput = input;
              cvvFrame = frame;
              console.log(`[amazonEnterCVV] Found CVV input with "${sel}" in frame: ${frame.url().substring(0, 80)}`);
              break;
            }
          } catch { /* skip inaccessible frame */ }
        }
        if (cvvInput) break;
      }
      if (cvvInput) break;
      if (attempt % 5 === 4) {
        console.log(`[amazonEnterCVV] Still looking for CVV input (attempt ${attempt + 1}/20)...`);
      }
      await sleep(250);
    }

    if (cvvInput && cvvFrame) {
      // Type directly into the CVV input inside the frame
      await cvvInput.click({ clickCount: 3 }); // select any existing value
      await sleep(50);
      await cvvInput.type(cvv, { delay: 50 });
      console.log("[amazonEnterCVV] ✅ Typed CVV directly into iframe input");

      // Verify
      try {
        const val = await cvvFrame.evaluate(() => {
          const input = document.querySelector('input.card-cvv, input#field') as HTMLInputElement;
          return input?.value?.length ?? 0;
        });
        console.log(`[amazonEnterCVV] ✅ Verified: CVV field has ${val} characters`);
      } catch { /* cross-origin, trust the typing */ }
      return;
    }

    // Fallback: find iframe element on the page and use keyboard
    console.log("[amazonEnterCVV] CVV input not found in frames, falling back to iframe click + keyboard...");
    const iframeSelectors = [
      '.pmts-credit-card-verification iframe',
      'span[id^="secureFieldsCVV"] iframe',
      'iframe[name*="addCreditCardVerificationNumber"]',
      'iframe[name*="CreditCardVerificationNumber"]',
    ];

    let iframeHandle: import("puppeteer-core").ElementHandle | null = null;
    for (const sel of iframeSelectors) {
      try {
        iframeHandle = await this.page.$(sel);
        if (iframeHandle) break;
      } catch { /* skip */ }
    }

    if (!iframeHandle) {
      throw new Error("CVV iframe not found on Amazon payment page");
    }

    const box = await iframeHandle.boundingBox();
    if (box) {
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await iframeHandle.click();
    }
    await sleep(150);
    await this.page.keyboard.type(cvv, { delay: 50 });
    console.log("[amazonEnterCVV] ✅ Typed CVV via keyboard fallback");
  }

  private async amazonConfirmPayment(): Promise<void> {
    // Helper: click an Amazon button via evaluate (avoids coordinate issues with zero-dimension inputs)
    const clickAmazonBtn = async (selector: string, label: string, maxAttempts = 20): Promise<boolean> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const clicked = await this.page.evaluate((sel: string) => {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn) { btn.click(); return true; }
            return false;
          }, selector);
          if (clicked) {
            console.log(`Clicked "${label}"`);
            return true;
          }
        } catch { /* skip */ }
        await sleep(500);
      }
      console.log(`"${label}" button not found after ${maxAttempts * 0.5}s`);
      return false;
    };

    // ── Step 1: Click "Use this payment method" ──
    console.log('Clicking "Use this payment method"...');
    const step1 = await clickAmazonBtn(
      'input[aria-labelledby="checkout-secondary-continue-button-id-announce"]',
      "Use this payment method"
    );
    if (!step1) throw new Error("Use this payment method button not found");
    await sleep(2000);

    // ── Step 2: Click "Continue without saving" in the card save popup ──
    console.log('Clicking "Continue without saving"...');
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const clicked = await this.page.evaluate(() => {
          // Find the span that contains "Continue without saving" text
          const spans = document.querySelectorAll('span.a-button-text');
          for (const span of spans) {
            if ((span.textContent || "").trim() === "Continue without saving") {
              // Click the parent span.a-button wrapper
              const wrapper = span.closest("span.a-button") as HTMLElement | null;
              if (wrapper) { wrapper.click(); return true; }
              (span as HTMLElement).click();
              return true;
            }
          }
          return false;
        });
        if (clicked) {
          console.log('Clicked "Continue without saving"');
          break;
        }
      } catch { /* skip */ }
      await sleep(500);
    }
    await sleep(2000);

    // ── Step 3: Click "Use this address" / billing address continue ──
    console.log('Clicking "Use this address"...');
    await clickAmazonBtn(
      'input[data-csa-c-slot-id="checkout-secondary-continue-billingaddressselect"]',
      "Use this address",
      10
    );
    await sleep(2000);

    // ── Step 4: Click "Place your order" / "Pay with debit card" ──
    console.log("Clicking Place your order...");
    let placed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const btnHandle = await this.page.$('input#placeOrder');
      if (!btnHandle) {
        await sleep(500);
        continue;
      }
      console.log(`[PlaceOrder] Found input#placeOrder (attempt ${attempt + 1})`);

      // Scroll the button's parent into view
      await this.page.evaluate(() => {
        const el = document.querySelector('#bottomSubmitOrderButtonId') ||
                   document.querySelector('#submitOrderButtonId') ||
                   document.getElementById('placeOrder');
        el?.scrollIntoView({ block: "center" });
      });
      await sleep(500);

      // Method 1: Focus the input and press Enter — generates a trusted form submission
      try {
        await btnHandle.focus();
        await sleep(100);
        await this.page.keyboard.press('Enter');
        console.log('[PlaceOrder] Pressed Enter on focused input#placeOrder');
        placed = true;
        break;
      } catch (e) {
        console.log(`[PlaceOrder] Enter key failed: ${e instanceof Error ? e.message : e}`);
      }

      // Method 2: requestSubmit with the button as submitter — trusted form submission
      try {
        const submitted = await this.page.evaluate(() => {
          const input = document.getElementById('placeOrder') as HTMLInputElement;
          if (input?.form) {
            input.form.requestSubmit(input);
            return true;
          }
          return false;
        });
        if (submitted) {
          console.log('[PlaceOrder] Used form.requestSubmit()');
          placed = true;
          break;
        }
      } catch (e) {
        console.log(`[PlaceOrder] requestSubmit failed: ${e instanceof Error ? e.message : e}`);
      }

      await sleep(500);
    }
    if (!placed) {
      console.log("Place Order button not found after all attempts");
    }
  }
}
