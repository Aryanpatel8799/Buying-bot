import { Page } from "puppeteer-core";
import { BasePlatform } from "./BasePlatform";
import {
  sleep,
  navigateWithRetry,
  waitWithRetry,
  waitAndClick,
} from "../core/helpers";

const DELAYS = {
  short: 500,
  medium: 1000,
  long: 2000,
};

export class AmazonPlatform extends BasePlatform {
  quantityBeforeBuy = true;

  constructor(page: Page, productUrl: string) {
    super(page, productUrl);
  }

  async navigateToProduct(): Promise<void> {
    console.log("Opening Amazon product page...");
    await navigateWithRetry(this.page, this.productUrl, {
      timeoutMs: 10000,
      maxRetries: 5,
    });
    await sleep(DELAYS.long);
  }

  async setQuantity(qty: number): Promise<void> {
    if (qty <= 1) {
      console.log("Quantity is 1, skipping quantity selection");
      return;
    }

    console.log(`Setting quantity to ${qty}...`);

    // Click the quantity dropdown button (autoid varies per product, so find by "Quantity:" label)
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () =>
            !!document.querySelector('.a-dropdown-label')?.textContent?.includes('Quantity'),
          { timeout: 10000 }
        );
      },
      { label: "Quantity dropdown", timeoutMs: 10000, maxRetries: 5 }
    );

    // Use the native <select> element instead of Amazon's custom dropdown UI
    // Amazon renders a hidden <select id="quantity"> alongside the visual dropdown
    const usedNativeSelect = await this.page.evaluate((targetQty: number) => {
      const sel = document.getElementById("quantity") as HTMLSelectElement;
      if (sel && sel.tagName === "SELECT") {
        sel.value = String(targetQty);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, qty);

    if (usedNativeSelect) {
      console.log(`Set quantity to ${qty} via native <select>`);
      await sleep(DELAYS.long);

      // Verify
      const selectedQty = await this.page.evaluate(() => {
        const sel = document.getElementById("quantity") as HTMLSelectElement;
        return sel?.value || "";
      });
      console.log(`Quantity <select> value: "${selectedQty}"`);
      return;
    }

    // Fallback: click the visual dropdown using Puppeteer's click (real mouse events)
    console.log("Native <select> not found, using visual dropdown...");

    // Find the dropdown trigger and click it with Puppeteer (not page.evaluate)
    const triggerSelector = 'span.a-dropdown-container span.a-button-dropdown';
    await waitAndClick(this.page, triggerSelector, "Quantity dropdown trigger", 10000, 5);
    await sleep(DELAYS.medium);

    // Wait for dropdown popup
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForSelector(
          ".a-popover-wrapper .a-dropdown-item",
          { visible: true, timeout: 10000 }
        );
      },
      { label: "Quantity dropdown options", timeoutMs: 10000, maxRetries: 3 }
    );
    await sleep(DELAYS.short);

    // Log available options
    const options = await this.page.evaluate(() => {
      const items = document.querySelectorAll(".a-popover-wrapper .a-dropdown-item");
      return Array.from(items).map((item, i) => ({
        index: i,
        id: item.id,
        text: item.textContent?.trim() || "",
      }));
    });
    console.log("Dropdown options:", JSON.stringify(options));

    // Click the correct option using Puppeteer's click
    // Amazon uses 0-indexed ids: quantity_0 = "1", quantity_1 = "2", etc.
    const optionSelector = `#quantity_${qty - 1} a, #quantity_${qty - 1}`;
    try {
      await this.page.click(optionSelector);
      console.log(`Clicked quantity option via selector: ${optionSelector}`);
    } catch {
      // Fallback: click by text match
      const clicked = await this.page.evaluate((targetQty: number) => {
        const items = Array.from(document.querySelectorAll(".a-popover-wrapper .a-dropdown-item"));
        for (const item of items) {
          const text = item.textContent?.trim() || "";
          if (text === String(targetQty)) {
            const link = item.querySelector("a") as HTMLElement;
            if (link) { link.click(); return true; }
            (item as HTMLElement).click();
            return true;
          }
        }
        // Last resort: click by index
        if (items[targetQty - 1]) {
          (items[targetQty - 1] as HTMLElement).click();
          return true;
        }
        return false;
      }, qty);

      if (!clicked) {
        throw new Error(`Could not select quantity ${qty} from dropdown`);
      }
    }

    await sleep(DELAYS.long);

    // Verify
    const selectedQty = await this.page.evaluate(() => {
      const prompt = document.querySelector(".a-button-dropdown .a-dropdown-prompt");
      return prompt?.textContent?.trim() || "";
    });
    console.log(`Quantity dropdown now shows: "${selectedQty}"`);
  }

  async clickBuyNow(): Promise<void> {
    console.log("Clicking Buy Now...");
    await waitAndClick(
      this.page,
      "#buy-now-button",
      "Buy Now button",
      10000,
      5
    );
    await sleep(DELAYS.long);
  }

  async proceedToCheckout(): Promise<void> {
    // Amazon goes directly to checkout/payment after Buy Now
    // Wait for the payment page to load
    console.log("Waiting for checkout page...");
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            const text = document.body.innerText;
            return (
              text.includes("Payment Method") ||
              text.includes("payment method") ||
              text.includes("Select a payment method") ||
              text.includes("Deliver to") ||
              text.includes("Use this address")
            );
          },
          { timeout: 15000 }
        );
      },
      { label: "Checkout page", timeoutMs: 15000, maxRetries: 5 }
    );

    // If there's an address selection step, click "Deliver to this address" or "Use this address"
    const hasAddressStep = await this.page.evaluate(() => {
      const text = document.body.innerText;
      return (
        text.includes("Use this address") ||
        text.includes("Deliver to this address")
      );
    });

    if (hasAddressStep) {
      console.log("Address step detected, confirming address...");
      try {
        await this.page.evaluate(() => {
          // Try common Amazon address confirmation selectors
          const selectors = [
            'input[name="shipToThisAddress"]',
            "#addressChangeLinkId",
            'a[id*="addressSelect"]',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) {
              el.click();
              return;
            }
          }
          // Fallback: find button/link with matching text
          const links = Array.from(document.querySelectorAll("a, input[type='submit'], button"));
          for (const link of links) {
            const text =
              (link as HTMLElement).innerText?.toLowerCase() ||
              (link as HTMLInputElement).value?.toLowerCase() ||
              "";
            if (
              text.includes("use this address") ||
              text.includes("deliver to this address")
            ) {
              (link as HTMLElement).click();
              return;
            }
          }
        });
        await sleep(DELAYS.long);
      } catch {
        console.log("Address confirmation not needed or already selected");
      }
    }

    console.log("Checkout page loaded");
    await sleep(DELAYS.medium);
  }

  async addToCart(): Promise<void> {
    console.log("Clicking Add to Cart...");
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForSelector("#add-to-cart-button", {
          visible: true,
          timeout: 10000,
        });
      },
      { label: "Add to Cart button", timeoutMs: 10000, maxRetries: 5 }
    );

    await this.page.click("#add-to-cart-button");
    console.log("Clicked Add to Cart");
    await sleep(DELAYS.long);

    // Wait for confirmation — Amazon may show "Added to Cart" overlay or redirect
    await this.page.waitForFunction(
      () => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("added to cart") ||
          text.includes("subtotal") ||
          text.includes("cart subtotal") ||
          text.includes("proceed to checkout") ||
          text.includes("go to cart")
        );
      },
      { timeout: 10000 }
    ).catch(() => {
      console.log("Add to Cart confirmation not detected, continuing...");
    });
    await sleep(DELAYS.medium);
  }

  async goToCart(): Promise<void> {
    console.log("Navigating to Amazon cart...");
    await this.page.goto("https://www.amazon.in/gp/cart/view.html", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await sleep(DELAYS.long);

    // Wait for cart page to load
    await this.page.waitForFunction(
      () => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("shopping cart") ||
          text.includes("your cart") ||
          text.includes("subtotal")
        );
      },
      { timeout: 10000 }
    ).catch(() => {
      console.log("Cart page text not detected, continuing...");
    });
    console.log("Cart page loaded");
  }

  async setCartItemQuantity(itemIndex: number, qty: number): Promise<void> {
    if (qty <= 1) return;
    console.log(`Setting cart item ${itemIndex + 1} quantity to ${qty}...`);

    // Amazon cart has quantity dropdowns for each item
    // Each item's quantity select has a name like "quantity.C..."
    const set = await this.page.evaluate((idx: number, targetQty: number) => {
      // Find all quantity selects in the cart
      const selects = document.querySelectorAll<HTMLSelectElement>(
        'select[name^="quantity"]'
      );
      if (idx < selects.length) {
        const sel = selects[idx];
        sel.value = String(targetQty);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, itemIndex, qty);

    if (set) {
      console.log(`Set cart item ${itemIndex + 1} quantity to ${qty}`);
      await sleep(DELAYS.long);
    } else {
      console.log(`Warning: Quantity select for cart item ${itemIndex + 1} not found`);
    }
  }

  async placeOrder(): Promise<void> {
    // On Amazon cart page, click "Proceed to checkout" / "Proceed to Buy"
    console.log("Clicking Proceed to Checkout from cart...");

    const checkoutSelectors = [
      "#sc-buy-box-ptc-button input",       // "Proceed to checkout" button
      "#sc-buy-box-ptc-button",
      'input[name="proceedToRetailCheckout"]',
      'a[name="proceedToRetailCheckout"]',
    ];

    let clicked = false;
    for (const sel of checkoutSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          await el.click();
          console.log(`Clicked checkout via: ${sel}`);
          clicked = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!clicked) {
      // Fallback: find by text
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("input, button, a, span"));
        for (const btn of buttons) {
          const text = (btn as HTMLElement).innerText?.toLowerCase() ||
            (btn as HTMLInputElement).value?.toLowerCase() || "";
          if (text.includes("proceed to checkout") || text.includes("proceed to buy")) {
            (btn as HTMLElement).click();
            return;
          }
        }
      });
      console.log("Clicked checkout via text fallback");
    }

    await sleep(DELAYS.long);
  }

  async isPaymentPage(): Promise<boolean> {
    try {
      const hasPayment = await this.page.evaluate(() => {
        const text = document.body.innerText;
        return (
          text.includes("Payment Method") ||
          text.includes("Add a credit or debit card") ||
          text.includes("Credit or debit card") ||
          text.includes("Gift Card")
        );
      });
      return hasPayment;
    } catch {
      return false;
    }
  }

  async isOrderConfirmationVisible(): Promise<boolean> {
    try {
      const result = await this.page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        const text = document.body.innerText.toLowerCase();

        // URL-based detection (most reliable)
        if (
          url.includes("/buy/thankyou") ||
          url.includes("/gp/buy/thankyou") ||
          url.includes("orderid=") ||
          url.includes("/order/")
        ) {
          return { confirmed: true, method: "url" };
        }

        // Text-based detection — require specific confirmation phrases
        // Avoid generic "thank you" which appears on many Amazon pages
        if (
          text.includes("order placed, thank") ||
          text.includes("order has been placed") ||
          text.includes("your order #") ||
          text.includes("order confirmed") ||
          text.includes("arriving") && text.includes("order #")
        ) {
          return { confirmed: true, method: "text" };
        }

        // Check for the green checkmark / confirmation heading
        const heading = document.querySelector("h4.a-alert-heading, h1.a-spacing-none");
        if (heading) {
          const hText = heading.textContent?.toLowerCase() || "";
          if (hText.includes("order placed") || hText.includes("thank you")) {
            return { confirmed: true, method: "heading" };
          }
        }

        return { confirmed: false, method: "none" };
      });

      if (result.confirmed) {
        console.log(`Order confirmed (detected via: ${result.method})`);
      }
      return result.confirmed;
    } catch {
      return false;
    }
  }

  async resetForNextIteration(): Promise<void> {
    console.log("Resetting browser state for next iteration...");

    // Step 1: Close any extra tabs/pages
    try {
      const browser = this.page.browser();
      const pages = await browser.pages();
      for (const p of pages) {
        if (p !== this.page) {
          await p.close().catch(() => {});
        }
      }
    } catch {
      console.log("Tab cleanup skipped");
    }

    // Step 2: Navigate to Amazon homepage to clear order/payment page state
    try {
      await this.page.goto("https://www.amazon.in", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } catch {
      console.log("Homepage navigation failed, trying reload...");
      try {
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      } catch {
        console.log("Reload also failed, continuing anyway...");
      }
    }
    await sleep(DELAYS.long);

    // Step 3: Clear cart if it has leftover items
    try {
      await this.page.goto("https://www.amazon.in/gp/cart/view.html", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await sleep(DELAYS.long);

      for (let attempt = 0; attempt < 20; attempt++) {
        const deleted = await this.page.evaluate(() => {
          const deleteBtn = document.querySelector<HTMLElement>(
            'input[value="Delete"], a[data-action="delete"], span.a-declarative[data-action="delete"] input'
          );
          if (deleteBtn) {
            deleteBtn.click();
            return true;
          }
          return false;
        });
        if (!deleted) break;
        await sleep(500);
      }
    } catch (err) {
      console.log("Amazon cart cleanup skipped:", err instanceof Error ? err.message : err);
    }

    console.log("Browser state reset complete");
  }
}
