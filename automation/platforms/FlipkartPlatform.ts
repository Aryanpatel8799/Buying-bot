import { Page } from "puppeteer-core";
import { BasePlatform, AddressDetails, InstaDdrLoginOptions, OrderDetails } from "./BasePlatform";
import {
  sleep,
  clearAndType,
  navigateWithRetry,
  waitWithRetry,
} from "../core/helpers";

const DELAYS = {
  short: 100,
  medium: 200,
  long: 300,
};

export class FlipkartPlatform extends BasePlatform {
  constructor(page: Page, productUrl: string) {
    super(page, productUrl);
  }

  /**
   * Detect if the current page context is stale (destroyed by SPA navigation)
   * and re-navigate to restore it. Call this after any action that might
   * trigger a Flipkart SPA navigation (address Change, address selection, etc.).
   */
  private async ensurePageValid(): Promise<void> {
    const STALE_ERRORS = [
      "Execution context was destroyed",
      "Session closed",
      "Target closed",
      "Protocol error",
      "Frame detached",
      "Detached",
    ];

    const isStaleError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return STALE_ERRORS.some((s) => msg.includes(s));
    };

    let staleCount = 0;
    while (staleCount < 3) {
      try {
        await this.page.evaluate(() => document.readyState);
        return;
      } catch (err) {
        if (!isStaleError(err)) {
          throw err;
        }
        staleCount++;
        console.log(`[ensurePageValid] Page context stale (attempt ${staleCount}/3) — re-attaching...`);
        const currentUrl = this.page.url().split("?")[0];
        await sleep(500);
        try {
          await this.page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await sleep(500);
          await this.page.evaluate(() => document.readyState);
          console.log("[ensurePageValid] Page re-attached successfully");
          return;
        } catch (navErr) {
          if (!isStaleError(navErr)) {
            console.log(`[ensurePageValid] Navigation error: ${(navErr as Error).message}`);
            return;
          }
          console.log(`[ensurePageValid] Navigation also stale, retrying...`);
          await sleep(1000);
        }
      }
    }
    console.log("[ensurePageValid] WARNING: Could not restore page context after 3 attempts");
  }

  async navigateToProduct(): Promise<void> {
    console.log("Opening product page...");
    await navigateWithRetry(this.page, this.productUrl, {
      timeoutMs: 10000,
      maxRetries: 5,
    });
    await sleep(DELAYS.medium);
  }

  async clickBuyNow(): Promise<void> {
    console.log("Waiting for Buy Now button ...");
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            // Check for "Buy Now" text OR yellow gradient button
            const allEls = document.querySelectorAll("div, span, button");
            for (const el of allEls) {
              const text = el.textContent?.trim().toLowerCase();
              if (text === "buy now" || text === "buy now!") return true;
            }
            // Also check for yellow gradient (Buy Now button background)
            const gradients = document.querySelectorAll('div[style*="linear-gradient"]');
            for (const g of gradients) {
              const style = g.getAttribute("style") || "";
              if (style.includes("#ffe51f") || style.includes("#ffcd03") || style.includes("rgb(255, 229, 31)")) {
                return true;
              }
            }
            return false;
          },
          { timeout: 10000 }
        );
      },
      { label: "Buy Now button", timeoutMs: 10000, maxRetries: 5 }
    );

    // Find the Buy Now button using multiple strategies
    const buyBox = await this.page.evaluate(() => {
      // polyfill esbuild's __name helper which doesn't exist in browser context
      if (typeof (globalThis as any).__name === "undefined") (globalThis as any).__name = (fn: any) => fn;

      const logs: string[] = [];

      // --- Strategy 1 (HIGHEST PRIORITY): Find "Buy Now" text and walk up ---
      // This avoids clicking "Buy Combo" or other yellow-gradient buttons
      const allEls = document.querySelectorAll("div, span, button");
      for (const label of allEls) {
        const text = label.textContent?.trim().toLowerCase();
        if (text !== "buy now" && text !== "buy now!") continue;
        if (label.children.length > 3) continue;

        // REJECT if parent text contains "combo" — this is Buy Combo, not Buy Now
        const parentText = (label.parentElement?.textContent || "").toLowerCase();
        if (parentText.includes("combo")) {
          logs.push(`Skipped: "Buy Now" inside a combo context: "${parentText.slice(0, 60)}"`);
          continue;
        }

        logs.push(`Found "Buy Now" text in <${label.tagName.toLowerCase()}> class="${label.className}"`);

        let best: HTMLElement = label as HTMLElement;
        let el: HTMLElement | null = label as HTMLElement;
        while (el && el !== document.body) {
          const s = el.getAttribute("style") || "";
          if (el.getAttribute("role") === "button" || s.includes("cursor: pointer") || s.includes("cursor:pointer") || el.tagName === "BUTTON") {
            best = el;
          }
          if (el.getBoundingClientRect().width > 400) break;
          el = el.parentElement;
        }

        best.scrollIntoView({ block: "center" });
        const rect = best.getBoundingClientRect();
        logs.push(`Text-based pressable at (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "text", logs };
      }

      // --- Strategy 2: Find yellow gradient that is specifically Buy Now (not Buy Combo) ---
      // The Buy Now gradient has: linear-gradient(90deg, rgb(255, 229, 31), rgb(255, 205, 3))
      const gradients = document.querySelectorAll('div[style*="linear-gradient"]');
      for (const g of gradients) {
        const style = g.getAttribute("style") || "";
        if (!(style.includes("#ffe51f") || style.includes("#ffcd03") || style.includes("rgb(255, 229, 31)"))) continue;

        logs.push(`Found yellow gradient: style="${style.slice(0, 80)}..."`);

        // Go up: gradient div → position:absolute wrapper → pressable parent
        let target: HTMLElement = g as HTMLElement;
        if (g.parentElement) {
          const ps = g.parentElement.getAttribute("style") || "";
          if (ps.includes("position") && ps.includes("absolute")) {
            target = g.parentElement.parentElement || g.parentElement;
          } else {
            target = g.parentElement;
          }
        }

        // Walk up to find the best pressable container
        let best: HTMLElement = target;
        let el: HTMLElement | null = target;
        while (el && el !== document.body) {
          const s = el.getAttribute("style") || "";
          if (el.getAttribute("role") === "button" || s.includes("cursor: pointer") || s.includes("cursor:pointer") || el.tagName === "BUTTON") {
            best = el;
          }
          if (el.getBoundingClientRect().width > 400) break;
          el = el.parentElement;
        }

        // REJECT if the pressable contains "combo" text
        const containerText = best.textContent?.trim().toLowerCase() || "";
        if (containerText.includes("combo")) {
          logs.push(`Skipped yellow gradient: contains 'combo' text`);
          continue;
        }

        best.scrollIntoView({ block: "center" });
        const rect = best.getBoundingClientRect();
        logs.push(`Yellow gradient pressable at (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);

        // Confirm it's the Buy Now button
        if (containerText.includes("buy now")) {
          logs.push("Confirmed: contains 'buy now' text");
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "yellow-gradient", logs };
        }
        if (rect.width < 300 && rect.height > 30 && rect.height < 70) {
          logs.push("Likely Buy Now based on size (no combo text)");
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "yellow-gradient-size", logs };
        }
      }

      logs.push("No Buy Now button found");
      return null;
    });

    if (buyBox) {
      for (const line of buyBox.logs) console.log(line);
    }
    if (!buyBox) throw new Error("Buy Now button not found");
    console.log(`=== Buy Now (variant: ${buyBox.variant}) ===`);

    await sleep(300);

    // Tap and wait for navigation — "context destroyed" means the click worked
    try {
      // Start listening for navigation BEFORE tapping
      const navPromise = this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null);

      // Method 1: touchscreen.tap (works for React Native Web Pressable)
      await this.page.touchscreen.tap(buyBox.x, buyBox.y);
      console.log(`Tapped Buy Now at (${buyBox.x.toFixed(0)}, ${buyBox.y.toFixed(0)})`);

      // Wait for navigation to complete
      const navResult = await navPromise;
      if (navResult) {
        console.log(`Buy Now navigated to: ${this.page.url()}`);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("context") || msg.includes("destroyed") || msg.includes("detached")) {
        // Navigation happened — context destroyed is a success signal
        console.log("Buy Now triggered navigation (context destroyed)");
        // Wait for new page to settle
        await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        console.log(`After Buy Now, URL: ${this.page.url()}`);
        return;
      }
      console.log(`Buy Now tap error: ${msg}`);
    }

    // Check if navigation already happened
    await sleep(DELAYS.medium);
    try {
      const currentUrl = await this.page.url();
      if (!currentUrl.includes("/p/") || currentUrl.includes("checkout") || currentUrl.includes("viewcart") || currentUrl.includes("order")) {
        console.log(`Buy Now already navigated to: ${currentUrl}`);
        return;
      }
    } catch {
      // Context destroyed — navigation in progress, wait for it
      await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      console.log(`After Buy Now, URL: ${this.page.url()}`);
      return;
    }

    // Method 2: mouse click fallback
    console.log("Tap may not have worked, trying mouse click...");
    try {
      const navPromise = this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null);
      await this.page.mouse.click(buyBox.x, buyBox.y);
      const navResult = await navPromise;
      if (navResult) {
        console.log(`Mouse click navigated to: ${this.page.url()}`);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("context") || msg.includes("destroyed") || msg.includes("detached")) {
        await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        console.log(`Mouse click navigated to: ${this.page.url()}`);
        return;
      }
    }

    // Method 3: React fiber handler
    console.log("Mouse click also didn't navigate, trying React fiber handler...");
    try {
      const fiberResult = await this.page.evaluate(() => {
        if (typeof (globalThis as any).__name === "undefined") (globalThis as any).__name = (fn: any) => fn;

        // Try yellow gradient element first
        const gradients = document.querySelectorAll('div[style*="linear-gradient"]');
        for (const g of gradients) {
          const style = g.getAttribute("style") || "";
          if (style.includes("#ffe51f") || style.includes("#ffcd03") || style.includes("rgb(255, 229, 31)")) {
            let el: HTMLElement | null = g as HTMLElement;
            while (el && el !== document.body) {
              const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
              if (fiberKey) {
                let fiber = (el as any)[fiberKey];
                let depth = 0;
                while (fiber && depth < 30) {
                  const props = fiber.memoizedProps || fiber.pendingProps;
                  if (props) {
                    const h = props.onPress || props.onClick || props.onPressIn;
                    if (typeof h === "function") {
                      try { h({ nativeEvent: {}, preventDefault: () => {}, stopPropagation: () => {} }); return "gradient handler invoked"; } catch {}
                    }
                  }
                  fiber = fiber.return;
                  depth++;
                }
              }
              el = el.parentElement;
            }
          }
        }

        // Try "Buy Now" text elements
        const allEls = document.querySelectorAll("div, span, button");
        for (const label of allEls) {
          const text = label.textContent?.trim().toLowerCase();
          if (text !== "buy now" && text !== "buy now!") continue;
          if (label.children.length > 3) continue;
          let el: HTMLElement | null = label as HTMLElement;
          while (el && el !== document.body) {
            const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
            if (fiberKey) {
              let fiber = (el as any)[fiberKey];
              let depth = 0;
              while (fiber && depth < 30) {
                const props = fiber.memoizedProps || fiber.pendingProps;
                if (props) {
                  const h = props.onPress || props.onClick || props.onPressIn;
                  if (typeof h === "function") {
                    try { h({ nativeEvent: {}, preventDefault: () => {}, stopPropagation: () => {} }); return "text handler invoked"; } catch {}
                  }
                }
                fiber = fiber.return;
                depth++;
              }
            }
            el = el.parentElement;
          }
        }
        return "no handler found";
      });
      console.log(`React fiber fallback: ${fiberResult}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("context") || msg.includes("destroyed") || msg.includes("detached")) {
        console.log("Fiber handler triggered navigation");
        await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      }
    }

    console.log(`After Buy Now, URL: ${this.page.url()}`);
  }

  async setQuantity(qty: number): Promise<void> {
    if (qty <= 1) {
      console.log("Quantity is 1, skipping quantity selection");
      return;
    }

    // Step 1: Open quantity dropdown (click "Qty: X")
    console.log("Waiting for Quantity dropdown ...");
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () =>
            [...document.querySelectorAll("div")].some((el) =>
              el.textContent?.trim().startsWith("Qty:")
            ),
          { timeout: 10000 }
        );
      },
      { label: "Quantity dropdown", timeoutMs: 10000, maxRetries: 5 }
    );
    await this.page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent?.trim().startsWith("Qty:")) {
          (el.closest('div[style*="cursor"]') as HTMLElement)?.click();
          return;
        }
      }
    });
    console.log("Clicked Quantity dropdown");
    await sleep(DELAYS.medium);

    // Step 2: Click "more"
    console.log('Waiting for "more" option ...');
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () =>
            [...document.querySelectorAll("div.css-146c3p1")].some(
              (el) => el.textContent?.trim() === "more"
            ),
          { timeout: 10000 }
        );
      },
      { label: '"more" option', timeoutMs: 10000, maxRetries: 5 }
    );
    await this.page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent?.trim() === "more") {
          (el.closest("div.r-1glkqn6") as HTMLElement)?.click();
          return;
        }
      }
    });
    console.log('Clicked "more"');
    await sleep(DELAYS.short);

    // Step 3: Enter quantity
    await clearAndType(
      this.page,
      'input[placeholder="Quantity"]',
      qty.toString(),
      "Quantity input"
    );
    await sleep(DELAYS.short);

    // Step 4: Click "APPLY"
    console.log('Waiting for "APPLY" button ...');
    await this.page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent?.trim() === "APPLY") {
          (el.closest("div.r-5kz9s3") as HTMLElement)?.click();
          return;
        }
      }
    });
    console.log('Clicked "APPLY"');
    await sleep(DELAYS.medium);
  }

  async proceedToCheckout(): Promise<void> {
    const currentUrl = this.page.url();

    // If already on checkout page, just wait for it to settle — never reload
    if (currentUrl.includes("/viewcheckout")) {
      console.log(`Already on checkout page (${currentUrl}) — waiting for content to render...`);
      // Wait for React to render the payment section (poll until body has enough text)
      for (let i = 0; i < 20; i++) {
        const bodyLen = await this.page.evaluate(() => (document.body?.innerText || "").length);
        if (bodyLen > 100) break;
        await sleep(500);
      }
      await sleep(300);
      console.log(`Checkout page ready: ${this.page.url()}`);
      return;
    }

    // Not on checkout page — navigate directly
    const checkoutUrl = "https://www.flipkart.com/viewcheckout";
    console.log(`On ${currentUrl} — navigating to checkout...`);
    await this.page.goto(checkoutUrl, { waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});

    // Wait for page to settle
    for (let i = 0; i < 20; i++) {
      const bodyLen = await this.page.evaluate(() => (document.body?.innerText || "").length);
      if (bodyLen > 100) break;
      await sleep(500);
    }
    await sleep(300);
    console.log(`Checkout page loaded: ${this.page.url()}`);
  }

  async isPaymentPage(): Promise<boolean> {
    try {
      const hasPaymentElements = await this.page.evaluate(() => {
        const text = document.body?.innerText || "";
        return (
          text.includes("PAYMENT OPTIONS") ||
          text.includes("Credit / Debit / ATM Card") ||
          text.includes("Net Banking") ||
          text.includes("Gift Card")
        );
      });
      return hasPaymentElements;
    } catch {
      return false;
    }
  }

  async addToCart(): Promise<void> {
    console.log("Waiting for Add to Cart button...");

    // Wait for either: SVG cart icon OR text-based "Add to Cart" button
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            // Check for SVG cart icon (by clipPath id)
            if (document.querySelector('clipPath[id*="AddToCart"]')) return true;
            // Check for SVG cart icon (by path d)
            const allPaths = document.querySelectorAll("path");
            for (const p of allPaths) {
              if ((p.getAttribute("d") || "").startsWith("M17 18.375H7.35116")) return true;
            }
            // Check for text-based "add to cart" button
            const labels = document.querySelectorAll("div.css-146c3p1");
            for (const label of labels) {
              const text = label.textContent?.trim().toLowerCase();
              if (text === "add to cart" || text === "add to bag") return true;
            }
            // Check for white gradient button (div with white linear-gradient inside css-g5y9jx with border-radius: 12px)
            const gradientDivs = document.querySelectorAll('div.css-g5y9jx[style*="border-radius: 12px"]');
            if (gradientDivs.length > 0) return true;
            return false;
          },
          { timeout: 10000 }
        );
      },
      { label: "Add to Cart button", timeoutMs: 10000, maxRetries: 5 }
    );

    // Step 1: Find the button coordinates — try all known patterns
    // Priority: SVG cart icon (most specific) → text-based → gradient (least specific)
    const btnCoords = await this.page.evaluate(() => {
      const logs: string[] = [];

      // --- Pattern 1: SVG cart icon (by AddToCart clipPath id) — most reliable ---
      const addToCartClip = document.querySelector('clipPath[id*="AddToCart"]');
      if (addToCartClip) {
        logs.push("Found SVG with AddToCart clipPath id");
        let best: HTMLElement = (addToCartClip.closest("svg") as unknown as HTMLElement) || (addToCartClip as unknown as HTMLElement);
        let el: HTMLElement | null = best;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          // Target the 44x44 border-radius:12px container
          if ((style.includes("width: 44px") || style.includes("width:44px")) && style.includes("border-radius")) {
            best = el;
            break;
          }
          if (style.includes("cursor") || el.getAttribute("role") === "button") {
            best = el;
            break;
          }
          el = el.parentElement;
        }
        best.scrollIntoView({ block: "center" });
        const rect = best.getBoundingClientRect();
        logs.push(`AddToCart clipPath button at (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "svg-clip", logs };
      }

      // --- Pattern 2: SVG cart icon (by path d attribute) ---
      const allPaths = document.querySelectorAll("path");
      for (const p of allPaths) {
        if ((p.getAttribute("d") || "").startsWith("M17 18.375H7.35116")) {
          logs.push("Found SVG cart icon by path d");
          let best: HTMLElement = p as unknown as HTMLElement;
          let el: HTMLElement | null = p as unknown as HTMLElement;
          while (el && el !== document.body) {
            const style = el.getAttribute("style") || "";
            if ((style.includes("width: 44px") || style.includes("width:44px")) && style.includes("border-radius")) {
              best = el;
              break;
            }
            if (style.includes("cursor") || el.getAttribute("role") === "button") {
              best = el;
              break;
            }
            el = el.parentElement;
          }
          best.scrollIntoView({ block: "center" });
          const rect = best.getBoundingClientRect();
          logs.push(`SVG path button at (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "svg", logs };
        }
      }

      // --- Pattern 3: Text-based "Add to Cart" / "Add to Bag" ---
      const labels = document.querySelectorAll("div.css-146c3p1");
      for (const label of labels) {
        const text = label.textContent?.trim().toLowerCase();
        if (text === "add to cart" || text === "add to bag") {
          logs.push(`Found text button: "${label.textContent?.trim()}"`);
          // Walk up to the outermost pressable container (usually has role or cursor style)
          let best: HTMLElement = label as HTMLElement;
          let el: HTMLElement | null = label as HTMLElement;
          while (el && el !== document.body) {
            const style = el.getAttribute("style") || "";
            if (style.includes("cursor") || el.getAttribute("role") === "button") {
              best = el;
            }
            // Stop at the bottom bar container (typically very wide)
            if (el.getBoundingClientRect().width > 300) break;
            el = el.parentElement;
          }
          best.scrollIntoView({ block: "center" });
          const rect = best.getBoundingClientRect();
          logs.push(`Text button at (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "text", logs };
        }
      }

      // --- Pattern 4: White gradient button (border-radius: 12px) — least specific, last resort ---
      const gradientContainers = document.querySelectorAll('div.css-g5y9jx[style*="border-radius: 12px"]');
      for (const gc of gradientContainers) {
        // Check it has a white gradient child
        const gradChild = gc.querySelector('div[style*="linear-gradient"]');
        if (gradChild) {
          logs.push("Found white gradient button (border-radius: 12px)");
          // The pressable container is a parent of this overlay
          let pressable: HTMLElement = gc.parentElement || gc as HTMLElement;
          // Walk up to find the container with cursor/role
          let el: HTMLElement | null = gc as HTMLElement;
          while (el && el !== document.body) {
            const style = el.getAttribute("style") || "";
            if (style.includes("cursor") || el.getAttribute("role") === "button") {
              pressable = el;
            }
            if (el.getBoundingClientRect().width > 300) break;
            el = el.parentElement;
          }
          pressable.scrollIntoView({ block: "center" });
          const rect = pressable.getBoundingClientRect();
          logs.push(`Gradient button at (${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}) ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, variant: "gradient", logs };
        }
      }

      logs.push("No Add to Cart button found");
      return { x: 0, y: 0, variant: "none", logs };
    });

    // Log
    console.log(`=== Add to Cart (variant: ${btnCoords.variant}) ===`);
    for (const line of btnCoords.logs) console.log(line);

    if (btnCoords.variant === "none") {
      try {
        await this.page.screenshot({ path: "error-screenshots/add-to-cart-debug.png" });
        console.log("Debug screenshot saved");
      } catch {}
      throw new Error("Add to Cart button not found");
    }

    // Step 2: Try multiple click strategies
    await sleep(300);

    // Strategy A: mouse.click (works for most elements including React Native Web)
    try {
      await this.page.mouse.click(btnCoords.x, btnCoords.y);
      console.log(`Mouse clicked Add to Cart at (${btnCoords.x.toFixed(0)}, ${btnCoords.y.toFixed(0)})`);
    } catch (err) {
      console.log(`Mouse click failed: ${(err as Error).message}`);
    }
    await sleep(800);

    // Check if cart was updated
    let cartChanged = await this.page.evaluate(() => {
      const badge = document.querySelector("span.m2YAMv");
      return badge?.textContent || "0";
    });
    console.log(`Cart badge after mouse click: ${cartChanged}`);

    // Strategy B: touchscreen.tap if mouse click didn't work
    if (cartChanged === "0") {
      console.log("Mouse click may not have worked, trying touchscreen.tap...");
      try {
        await this.page.touchscreen.tap(btnCoords.x, btnCoords.y);
        console.log(`Tapped Add to Cart at (${btnCoords.x.toFixed(0)}, ${btnCoords.y.toFixed(0)})`);
      } catch (err) {
        console.log(`Tap failed: ${(err as Error).message}`);
      }
      await sleep(800);
      cartChanged = await this.page.evaluate(() => {
        const badge = document.querySelector("span.m2YAMv");
        return badge?.textContent || "0";
      });
      console.log(`Cart badge after tap: ${cartChanged}`);
    }

    // Strategy C: Direct DOM click with full mouse event sequence on the element
    if (cartChanged === "0") {
      console.log("Tap may not have worked, trying direct DOM click...");
      const domClicked = await this.page.evaluate(() => {
        // Find the 44x44 AddToCart button container
        const clip = document.querySelector('clipPath[id*="AddToCart"]');
        let target: HTMLElement | null = clip?.closest("svg")?.parentElement?.parentElement as HTMLElement || null;
        if (!target) {
          // Fallback: find by path d
          const paths = document.querySelectorAll("path");
          for (const p of paths) {
            if ((p.getAttribute("d") || "").startsWith("M17 18.375H7.35116")) {
              target = p.closest('div[style*="border-radius"]') as HTMLElement || p.closest("div.css-g5y9jx") as HTMLElement;
              break;
            }
          }
        }
        if (!target) return false;
        target.scrollIntoView({ block: "center" });
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        // Full pointer event sequence for React Native Web Pressable
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, button: 0 }));
        target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, button: 0 }));
        return true;
      });
      if (domClicked) {
        console.log("Direct DOM click dispatched");
        await sleep(800);
        cartChanged = await this.page.evaluate(() => {
          const badge = document.querySelector("span.m2YAMv");
          return badge?.textContent || "0";
        });
        console.log(`Cart badge after DOM click: ${cartChanged}`);
      }
    }

    if (cartChanged === "0") {
      console.log("Tap may not have worked, trying React fiber handler...");
      const fiberResult = await this.page.evaluate(() => {
        if (typeof (globalThis as any).__name === "undefined") (globalThis as any).__name = (fn: any) => fn;

        // Helper: walk up from element, find React fiber handler, invoke it
        const invokeHandler = (startEl: HTMLElement): string | null => {
          let el: HTMLElement | null = startEl;
          while (el && el !== document.body) {
            const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
            if (fiberKey) {
              let fiber = (el as any)[fiberKey];
              let depth = 0;
              while (fiber && depth < 30) {
                const props = fiber.memoizedProps || fiber.pendingProps;
                if (props) {
                  const h = props.onPress || props.onClick || props.onPressIn;
                  if (typeof h === "function") {
                    try { h({ nativeEvent: {}, preventDefault: () => {}, stopPropagation: () => {} }); return "handler invoked"; } catch {}
                  }
                }
                fiber = fiber.return;
                depth++;
              }
            }
            el = el.parentElement;
          }
          return null;
        };

        // Try SVG first (most specific to Add to Cart)
        const allPaths = document.querySelectorAll("path");
        for (const p of allPaths) {
          if ((p.getAttribute("d") || "").startsWith("M17 18.375H7.35116")) {
            const result = invokeHandler(p as unknown as HTMLElement);
            if (result) return "svg " + result;
          }
        }

        // Try text button
        const labels = document.querySelectorAll("div.css-146c3p1, div, span");
        for (const label of labels) {
          const text = label.textContent?.trim().toLowerCase();
          if (text === "add to cart" || text === "add to bag") {
            const result = invokeHandler(label as HTMLElement);
            if (result) return "text " + result;
          }
        }

        // Try gradient button (least specific — last resort)
        const gradientContainers = document.querySelectorAll('div[style*="border-radius"]');
        for (const gc of gradientContainers) {
          if (gc.querySelector('div[style*="linear-gradient"]')) {
            const result = invokeHandler(gc as HTMLElement);
            if (result) return "gradient " + result;
          }
        }

        return "no handler found";
      });
      console.log(`React fiber fallback: ${fiberResult}`);
    }

    await sleep(DELAYS.medium);
  }

  async goToCart(): Promise<void> {
    console.log("Navigating to Flipkart cart...");
    await this.page.goto("https://www.flipkart.com/viewcart", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await sleep(DELAYS.long);

    // Wait for cart page to load
    await this.page.waitForFunction(
      () => {
        const text = document.body.innerText.toLowerCase();
        return text.includes("shopping cart") || text.includes("my cart") ||
               text.includes("place order") || text.includes("price details");
      },
      { timeout: 10000 }
    ).catch(() => {
      console.log("Cart page text not detected, continuing...");
    });
    console.log("Cart page loaded");
  }

  async setCartItemQuantity(itemIndex: number, qty: number): Promise<void> {
    // On Flipkart cart page, each item has a quantity section with +/- buttons
    // and a "Qty: X" display. We need to find the Nth item and adjust its quantity.
    console.log(`Setting quantity for cart item ${itemIndex + 1} to ${qty}...`);

    // Wait for the cart page to load with items
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            // Look for quantity displays in the cart (e.g., "Qty:" text)
            const qtyLabels = [...document.querySelectorAll("div")].filter((el) =>
              el.textContent?.trim().startsWith("Qty:")
            );
            return qtyLabels.length > 0;
          },
          { timeout: 10000 }
        );
      },
      { label: "Cart quantity controls", timeoutMs: 10000, maxRetries: 5 }
    );

    // Find all quantity controls in the cart and click the one at itemIndex
    // Step 1: Click "Qty: X" dropdown for the target item
    const clickedDropdown = await this.page.evaluate((idx: number) => {
      const qtyLabels = [...document.querySelectorAll("div.css-146c3p1")].filter(
        (el) => el.textContent?.trim().startsWith("Qty:")
      );
      if (idx < qtyLabels.length) {
        const el = qtyLabels[idx];
        const clickTarget = el.closest('div[style*="cursor"]') || el.parentElement;
        if (clickTarget) {
          (clickTarget as HTMLElement).scrollIntoView({ block: "center" });
          (clickTarget as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, itemIndex);

    if (!clickedDropdown) {
      console.log(`Warning: Qty dropdown for item ${itemIndex + 1} not found, skipping`);
      return;
    }
    console.log(`Clicked Qty dropdown for item ${itemIndex + 1}`);
    await sleep(DELAYS.medium);

    // Step 2: Click "more" to get the text input
    const clickedMore = await this.page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent?.trim() === "more") {
          const clickTarget = el.closest("div.r-1glkqn6") || el.parentElement;
          if (clickTarget) {
            (clickTarget as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    });

    if (clickedMore) {
      console.log('Clicked "more"');
      await sleep(DELAYS.short);

      // Step 3: Enter quantity in the input
      // Do NOT use clearAndType here — clearing to empty triggers Flipkart's
      // React handler which interprets qty="" as removal and deletes the item.
      // Instead, set the value directly via JS without an intermediate empty state.
      const qtySelector = 'input[placeholder="Quantity"]';
      await this.page.waitForSelector(qtySelector, { visible: true, timeout: 5000 });
      await this.page.evaluate((sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (el) {
          el.focus();
          // Use native setter to trigger React's internal state update
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          )?.set;
          nativeInputValueSetter?.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, qtySelector, qty.toString());
      await sleep(DELAYS.short);

      // Step 4: Click "APPLY"
      await this.page.evaluate(() => {
        const els = document.querySelectorAll("div.css-146c3p1");
        for (const el of els) {
          if (el.textContent?.trim() === "APPLY") {
            const clickTarget = el.closest("div.r-5kz9s3") || el.parentElement;
            if (clickTarget) {
              (clickTarget as HTMLElement).click();
              return;
            }
          }
        }
      });
      console.log(`Set quantity for item ${itemIndex + 1} to ${qty}`);
      await sleep(DELAYS.medium);
    } else {
      // Fallback: if "more" isn't available, use +/- buttons
      console.log(`"more" option not found, using +/- buttons for item ${itemIndex + 1}`);
      // Click + button (qty-1) times to increase from 1 to desired qty
      for (let i = 1; i < qty; i++) {
        const plusClicked = await this.page.evaluate((idx: number) => {
          // Find + buttons (SVG with "+" path or button with "+" text)
          const svgs = document.querySelectorAll("svg");
          const plusBtns: Element[] = [];
          for (const svg of svgs) {
            const paths = svg.querySelectorAll("path");
            for (const p of paths) {
              const d = p.getAttribute("d") || "";
              // "+" icon typically has horizontal and vertical lines
              if (d.includes("H") && d.includes("V") && !d.includes("M17 18.375")) {
                plusBtns.push(svg);
                break;
              }
            }
          }
          // Each cart item has a +/- pair, get the + for item at idx
          // + buttons are typically the second in each pair
          if (plusBtns.length > idx) {
            const target = plusBtns[idx].parentElement || plusBtns[idx];
            (target as HTMLElement).click();
            return true;
          }
          return false;
        }, itemIndex);
        if (plusClicked) {
          await sleep(300); // Wait for quantity update
        }
      }
      console.log(`Used +/- buttons to set item ${itemIndex + 1} to qty ${qty}`);
    }
  }

  async placeOrder(): Promise<void> {
    // Click "Place order" button: div.css-146c3p1 with text "Place order" inside a yellow bg container
    console.log("Waiting for Place Order button...");

    // Find the "Place order" button — div.css-146c3p1 with text "Place order"
    // inside the yellow container div.css-g5y9jx
    let placeBox: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      placeBox = await this.page.evaluate(() => {
        const labels = document.querySelectorAll("div.css-146c3p1");
        for (const label of labels) {
          const text = label.textContent?.trim().toLowerCase();
          if (text && (text === "place order" || text === "place order ")) {
            // Walk up to the yellow container (div.css-g5y9jx with background-color)
            let el: HTMLElement | null = label as HTMLElement;
            while (el) {
              const style = el.getAttribute("style") || "";
              if (el.classList.contains("css-g5y9jx") && style.includes("background-color")) {
                el.scrollIntoView({ block: "center" });
                const rect = el.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              }
              el = el.parentElement;
            }
            // Fallback: use the text label itself
            (label as HTMLElement).scrollIntoView({ block: "center" });
            const rect = label.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
        return null;
      });
      if (placeBox) break;
      if (attempt % 5 === 4) {
        console.log(`Still looking for Place Order button (attempt ${attempt + 1}/20)...`);
      }
      await sleep(500);
    }

    if (!placeBox) throw new Error("Place Order button not found after 10s");
    await sleep(300);
    await this.page.touchscreen.tap(placeBox.x, placeBox.y);
    console.log(`Tapped Place Order at (${placeBox.x.toFixed(0)}, ${placeBox.y.toFixed(0)})`);
    await sleep(DELAYS.long);
  }

  async isOrderConfirmationVisible(): Promise<boolean> {
    try {
      const result = await this.page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        const text = (document.body?.innerText || "").toLowerCase();

        // URL-based detection (most reliable)
        if (
          url.includes("orderresponse") ||
          url.includes("order-confirmed") ||
          url.includes("orderconfirmed") ||
          url.includes("/orderdetail") ||
          url.includes("order_id=") ||
          url.includes("reference_id=od")
        ) {
          return { confirmed: true, method: "url" };
        }

        // Text-based detection — Flipkart shows specific confirmation text
        if (
          text.includes("order confirmed") ||
          text.includes("order placed successfully") ||
          text.includes("your order has been placed") ||
          text.includes("order is confirmed") ||
          text.includes("order successful")
        ) {
          return { confirmed: true, method: "text" };
        }

        // Check for confirmation elements (green tick, order ID display)
        const orderIdEls = document.querySelectorAll("div.css-146c3p1");
        for (const el of orderIdEls) {
          const t = el.textContent?.trim() || "";
          if (/^OD\d{10,}/.test(t) || t.startsWith("Order ID")) {
            return { confirmed: true, method: "orderid" };
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

  async extractOrderDetails(): Promise<OrderDetails> {
    console.log("[extractOrderDetails] Extracting order details from Flipkart confirmation page...");
    try {
      const details = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        const allText = body.replace(/\s+/g, " ");

        // Extract Order ID (OD followed by digits)
        let orderId = "";
        const orderIdMatch = allText.match(/OD\d{10,}/);
        if (orderIdMatch) orderId = orderIdMatch[0];

        // Extract product model/name — look for the product title on confirmation page
        let model = "";
        const titleEls = document.querySelectorAll("div.css-146c3p1, span.css-146c3p1");
        for (const el of titleEls) {
          const text = (el.textContent || "").trim();
          // Product names are usually long (>20 chars) and contain brand keywords
          if (text.length > 20 && !text.startsWith("OD") && !text.toLowerCase().includes("order") &&
              !text.toLowerCase().includes("place") && !text.toLowerCase().includes("deliver")) {
            model = text;
            break;
          }
        }

        // Extract colour — look for common colour keywords in the product details
        let colour = "";
        const colourMatch = allText.match(/(?:colou?r|shade)[:\s]*([A-Za-z\s]+?)(?:,|\.|;|\s{2}|\n|$)/i);
        if (colourMatch) colour = colourMatch[1].trim();

        // Extract amount/price — look for ₹ or Rs followed by numbers
        let amount = "";
        const priceMatch = allText.match(/(?:₹|Rs\.?)\s*([\d,]+)/);
        if (priceMatch) amount = priceMatch[1].replace(/,/g, "");

        return { orderId, model, colour, amount };
      });

      const result: OrderDetails = {
        orderId: details.orderId,
        model: details.model,
        colour: details.colour,
        quantity: 0,
        pinCode: "",
        amount: details.amount,
        perPc: "",
        orderDate: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      };
      console.log(`[extractOrderDetails] Extracted: orderId=${result.orderId}, model=${result.model.slice(0, 50)}, amount=${result.amount}`);
      return result;
    } catch (err) {
      console.log(`[extractOrderDetails] Failed to extract: ${err instanceof Error ? err.message : err}`);
      return {
        orderId: "",
        model: "",
        colour: "",
        quantity: 0,
        pinCode: "",
        amount: "",
        perPc: "",
        orderDate: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      };
    }
  }

  async loginWithEmail(email: string, options?: InstaDdrLoginOptions): Promise<void> {
    console.log(`Logging in with email: ${email.substring(0, 3)}***`);

    // Step 1: Check if already logged in — if so, log out first
    if (await this.isLoggedIn()) {
      console.log("Already logged in. Logging out first...");
      await this.logout();
    }

    // Step 2: Navigate to Flipkart login page
    await navigateWithRetry(this.page, "https://www.flipkart.com/account/login?ret=/", {
      timeoutMs: 15000,
      maxRetries: 3,
    });
    await sleep(DELAYS.long);

    // Step 3: Wait for email input field
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            const inputs = document.querySelectorAll('input[type="text"], input[type="email"]');
            return inputs.length > 0;
          },
          { timeout: 10000 }
        );
      },
      { label: "Login email input", timeoutMs: 10000, maxRetries: 5 }
    );

    // Step 4: Enter email into login form
    console.log("Typing into login email input ...");

    const typed = await this.page.evaluate((emailToType: string) => {
      if (typeof (globalThis as any).__name === "undefined") (globalThis as any).__name = (fn: any) => fn;
      // Helper: type value into input using React-compatible keyboard events
      function typeIntoInput(input: HTMLInputElement, value: string): void {
        input.focus();
        input.value = "";
        for (const char of value) {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          nativeSetter?.call(input, input.value + char);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true, cancelable: true }));
        }
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      // Strategy 1: Find by label text containing "email" + "mobile"/"phone"
      const allSpans = document.querySelectorAll('label span, span');
      for (const el of allSpans) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (text.includes("email") && (text.includes("mobile") || text.includes("phone"))) {
          let input: HTMLInputElement | null = null;
          let curr: HTMLElement | null = el.closest('div');
          while (curr && curr !== document.body) {
            input = curr.querySelector('input[type="text"], input[type="email"]') as HTMLInputElement | null;
            if (input) break;
            curr = curr.parentElement;
          }
          if (input) {
            typeIntoInput(input, emailToType);
            return "label";
          }
        }
      }

      // Strategy 2: Find input near email/mobile/login text
      const inputs = document.querySelectorAll('input[type="text"], input[type="email"]');
      for (const inp of inputs) {
        const input = inp as HTMLInputElement;
        if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
          const placeholder = (input.placeholder || "").toLowerCase();
          const nearbyText = (input.closest("div")?.parentElement?.textContent || "").toLowerCase();
          if (
            placeholder.includes("email") || placeholder.includes("mobile") ||
            nearbyText.includes("email") || nearbyText.includes("mobile") ||
            nearbyText.includes("login") || nearbyText.includes("sign in")
          ) {
            typeIntoInput(input, emailToType);
            return "placeholder";
          }
        }
      }

      // Strategy 3: Fallback — first visible text input on the page
      for (const inp of inputs) {
        const input = inp as HTMLInputElement;
        if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
          typeIntoInput(input, emailToType);
          return "fallback";
        }
      }

      return null;
    }, email);

    if (!typed) {
      throw new Error("Could not find email input on login page");
    }
    console.log(`Email entered via ${typed} strategy`);
    await sleep(DELAYS.medium);

    // Step 5: Click "Request OTP" button
    console.log("Clicking Request OTP...");
    const otpRequested = await this.page.evaluate(() => {
      // Strategy 1: Find by exact class names
      const btn1 = document.querySelector('button.dSM5Ub.Kv3ekh.KcXDCU') as HTMLButtonElement | null;
      if (btn1) { btn1.click(); return "class"; }

      // Strategy 2: Find button by text content
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase() || "";
        if (text.includes("request otp") || text.includes("get otp") || text.includes("send otp")) {
          btn.click();
          return "text";
        }
      }

      // Strategy 3: Find any submit-like button near the login form
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase() || "";
        if (text.includes("continue") || text.includes("next") || text.includes("login") || text.includes("submit")) {
          btn.click();
          return "submit";
        }
      }

      return null;
    });

    if (!otpRequested) {
      throw new Error("Could not find Request OTP button");
    }
    console.log(`OTP request button clicked via ${otpRequested} strategy`);

    console.log("OTP requested on Flipkart");

    // Step 6: If InstaDDR is configured, auto-fetch and enter OTP
    if (options?.instaDdrService && options?.instaDdrAccount) {
      const { instaDdrService, instaDdrAccount } = options;

      // 6a: Login to InstaDDR in isolated context (no-op for Gmail)
      console.log("[OTP] Preparing OTP service…");
      await instaDdrService.login(instaDdrAccount.instaDdrId, instaDdrAccount.instaDdrPassword);

      // 6b: Wait for Flipkart to send the OTP. InstaDDR's legacy polling is
      // slow so defaults to 60s; Gmail typically receives within seconds and
      // supplies its own shorter hint (initialWaitMs).
      const waitMs = instaDdrService.initialWaitMs ?? 60000;
      console.log(`[OTP] Waiting ${Math.round(waitMs / 1000)}s for the OTP email to arrive...`);
      await sleep(waitMs);

      // 6c: Fetch OTP from InstaDDR inbox with retries — 2 minutes total
      // 24 attempts × 5s between retries = 120s (2 minutes)
      const MAX_OTP_ATTEMPTS = 24;
      const OTP_RETRY_DELAY = 5000;
      let otp: string | null = null;
      for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
        try {
          otp = await instaDdrService.fetchOtp({
            instaDdrId: instaDdrAccount.instaDdrId,
            instaDdrPassword: instaDdrAccount.instaDdrPassword,
            email: instaDdrAccount.email,
          });
          if (otp) break;
        } catch (err) {
          console.log(`[InstaDDR] OTP fetch attempt ${attempt}/${MAX_OTP_ATTEMPTS} failed: ${err instanceof Error ? err.message : err}`);
          if (attempt < MAX_OTP_ATTEMPTS) {
            console.log(`[InstaDDR] Retrying in ${OTP_RETRY_DELAY / 1000}s...`);
            await sleep(OTP_RETRY_DELAY);
          }
        }
      }

      if (!otp) {
        throw new Error(`Failed to fetch OTP from InstaDDR after ${MAX_OTP_ATTEMPTS} attempts (~2 minutes)`);
      }

      console.log(`[InstaDDR] OTP fetched: ${otp} — entering into Flipkart...`);

      // 6d: Enter OTP into Flipkart's OTP input field
      await this.enterOtpOnFlipkart(otp);

      // 6e: Wait for login to complete
      const loginSuccess = await this.waitForLoginCompletion(60000);
      if (!loginSuccess) {
        throw new Error("Login did not complete after entering OTP");
      }

      console.log("InstaDDR auto-login complete — logged into Flipkart");
    } else {
      console.log("OTP requested — waiting for human to enter OTP...");
    }
  }

  /**
   * Enter a 6-digit OTP into Flipkart's OTP input field after requesting OTP.
   */
  private async enterOtpOnFlipkart(otp: string): Promise<void> {
    // Wait for OTP input field(s) to appear
    await waitWithRetry(
      this.page,
      async () => {
        await this.page.waitForFunction(
          () => {
            // Flipkart may use individual digit inputs or a single input
            const otpInputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]');
            return otpInputs.length > 0;
          },
          { timeout: 10000 }
        );
      },
      { label: "OTP input field", timeoutMs: 10000, maxRetries: 3 }
    );

    await sleep(1000);

    // Try to enter OTP — Flipkart uses either individual digit inputs or a single field
    const entered = await this.page.evaluate((otpValue: string) => {
      // Strategy 1: Look for multiple single-character OTP input fields
      const allInputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]');
      const otpInputs: HTMLInputElement[] = [];
      for (const inp of allInputs) {
        const input = inp as HTMLInputElement;
        // OTP inputs are typically short maxlength (1-6) and in the OTP section
        if (input.maxLength === 1 || input.getAttribute("data-otp") !== null) {
          otpInputs.push(input);
        }
      }

      // If we found individual digit inputs (one per digit)
      if (otpInputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          const input = otpInputs[i];
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          nativeSetter?.call(input, otpValue[i]);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return "individual";
      }

      // Strategy 2: Look for a single OTP input field (maxLength 6 or nearby "otp"/"verify" text)
      for (const inp of allInputs) {
        const input = inp as HTMLInputElement;
        const parent = input.closest("div")?.parentElement;
        const nearbyText = parent?.textContent?.toLowerCase() || "";
        if (
          input.maxLength === 6 ||
          nearbyText.includes("otp") ||
          nearbyText.includes("verification code") ||
          nearbyText.includes("enter the otp")
        ) {
          input.focus();
          input.value = "";
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          nativeSetter?.call(input, otpValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("blur", { bubbles: true }));
          return "single";
        }
      }

      // Strategy 3: Fallback — type into the first focused/visible text input
      for (const inp of allInputs) {
        const input = inp as HTMLInputElement;
        if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
          input.focus();
          input.value = "";
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          nativeSetter?.call(input, otpValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return "fallback";
        }
      }

      return null;
    }, otp);

    if (!entered) {
      throw new Error("Could not find OTP input field on Flipkart");
    }

    console.log(`OTP entered via ${entered} strategy`);
    await sleep(500);

    // Click Verify/Submit OTP button
    const submitted = await this.page.evaluate(() => {
      // Look for verify/submit button
      const buttons = document.querySelectorAll("button, a[role='button']");
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase() || "";
        if (text.includes("verify") || text.includes("submit") || text.includes("login")) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      // Fallback: click the same class button used for Request OTP (Flipkart reuses it)
      const fallbackBtn = document.querySelector('button.dSM5Ub.Kv3ekh.KcXDCU') as HTMLButtonElement | null;
      if (fallbackBtn) {
        fallbackBtn.click();
        return true;
      }
      return false;
    });

    if (submitted) {
      console.log("OTP submit button clicked");
    } else {
      console.log("No explicit submit button found — OTP may auto-submit");
    }

    await sleep(2000);
  }

  async waitForLoginCompletion(timeoutMs = 300000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 2000;

    while (Date.now() < deadline) {
      try {
        const loggedIn = await this.page.evaluate(() => {
          const url = window.location.href.toLowerCase();
          // If we're no longer on the login page, login succeeded
          if (!url.includes("/account/login")) {
            return true;
          }
          // Check for logged-in indicators on the page
          const text = (document.body?.innerText || "").toLowerCase();
          if (text.includes("my account") || text.includes("my orders")) {
            return true;
          }
          return false;
        });

        if (loggedIn) {
          console.log("Login completed successfully");
          return true;
        }
      } catch {
        // Page might be navigating — that's a good sign
        await sleep(pollInterval);
        try {
          const url = this.page.url();
          if (!url.includes("/account/login")) {
            console.log("Login completed (detected via URL change)");
            return true;
          }
        } catch {
          // Still navigating
        }
      }

      await sleep(pollInterval);
    }

    console.log("Login timed out");
    return false;
  }

  async logout(): Promise<void> {
    console.log("Logging out...");
    await this.logoutViaUI();
    await this.clearSessionData();
    // Navigate to confirm logged-out state
    try {
      await this.page.goto("https://www.flipkart.com", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await sleep(DELAYS.long);
    } catch {
      console.log("Post-logout navigation failed, continuing...");
    }
    console.log("Logout complete");
  }

  private async isLoggedIn(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        if (url.includes("/account/login")) return false;
        const text = (document.body?.innerText || "").toLowerCase();
        return (
          text.includes("my account") ||
          text.includes("my orders") ||
          text.includes("logout") ||
          text.includes("sign out")
        );
      });
    } catch {
      return false;
    }
  }

  private async logoutViaUI(): Promise<void> {
    console.log("Performing UI-based logout...");

    // Step 1: Navigate to homepage to ensure header is loaded
    try {
      await this.page.goto("https://www.flipkart.com", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await sleep(DELAYS.medium);
    } catch { /* ignore */ }

    // Step 2: Click the account/avatar button in the header
    const menuOpened = await this.page.evaluate(() => {
      const allEls = document.querySelectorAll('a, div[role="button"], span');
      for (const el of allEls) {
        const text = el.textContent?.trim().toLowerCase();
        if (text === "my account" || text === "login") {
          (el as HTMLElement).click();
          return true;
        }
      }
      // Try clicking the avatar/account div if text not found
      const avatar =
        document.querySelector('div[class*="_3ko"]') ||
        document.querySelector('div[class*="_2no"]');
      if (avatar) { (avatar as HTMLElement).click(); return true; }
      return false;
    });

    if (!menuOpened) {
      console.log("Account menu not found, using cookie clear fallback");
      return;
    }

    await sleep(DELAYS.medium);

    // Step 3: Click "Logout" / "Sign Out" in the dropdown
    const loggedOut = await this.page.evaluate(() => {
      const allLinks = document.querySelectorAll('a, button, div[role="button"]');
      for (const el of allLinks) {
        const t = el.textContent?.trim().toLowerCase() || "";
        if (t === "logout" || t === "sign out" || t === "signout") {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (loggedOut) {
      console.log("UI-based logout succeeded");
      await sleep(DELAYS.long);
    } else {
      console.log("Sign out button not found in dropdown, falling back to cookie clear");
    }
  }

  private async clearSessionData(): Promise<void> {
    // Delete ONLY Flipkart cookies. `Network.clearBrowserCookies` nukes every
    // cookie in the entire browser profile — that signs out Gmail (and any
    // other open tab), detaches the Gmail execution context, and breaks OTP
    // fetching mid-run. We scope the delete to Flipkart hostnames so logout
    // has no effect on other origins.
    try {
      const flipkartCookies = await this.page.cookies(
        "https://www.flipkart.com",
        "https://flipkart.com",
        "https://m.flipkart.com",
      );
      for (const c of flipkartCookies) {
        await this.page.deleteCookie({
          name: c.name,
          domain: c.domain,
          path: c.path,
        });
      }
      console.log(`Cleared ${flipkartCookies.length} Flipkart cookie(s) — other origins untouched`);
    } catch { /* ignore */ }
    try {
      await this.page.evaluate(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      });
      console.log("Cleared Flipkart localStorage/sessionStorage");
    } catch { /* ignore */ }
  }

  async resetForNextIteration(): Promise<void> {
    console.log("Resetting browser state for next iteration...");

    // Step 1: Close ephemeral extra tabs (payment pop-ups, etc.) but keep the
    // Gmail OTP tab alive — it's reused across iterations, and killing it here
    // was dropping the Gmail session mid-job.
    try {
      const browser = this.page.browser();
      const pages = await browser.pages();
      for (const p of pages) {
        if (p === this.page) continue;
        let url = "";
        try { url = p.url(); } catch { /* ignore */ }
        // Preserve Gmail / Google Accounts tabs.
        if (/^https?:\/\/[^\/]*(mail\.google\.com|accounts\.google\.com)/i.test(url)) {
          continue;
        }
        await p.close().catch(() => {});
      }
    } catch {
      console.log("Tab cleanup skipped");
    }

    // Step 2: Dismiss any popups on current page (don't navigate yet — save time)
    await this.page.evaluate(() => {
      const closeButtons = document.querySelectorAll('button._2KpZ6l._2doB4z, span._30XB9F');
      closeButtons.forEach((btn) => (btn as HTMLElement).click());
    }).catch(() => {});

    console.log("Browser state reset complete");
  }

  /**
   * Verify and fix quantity, delivery address, and GST checkbox on the
   * order summary page (intermediate page after clicking Buy Now, before
   * the full checkout page). After all checks pass, clicks Continue to
   * proceed to the checkout page.
   *
   * This is the primary entry point for the order summary flow.
   */
  async verifyAddressOnOrderSummary(
    address: AddressDetails,
    expectedQty: number
  ): Promise<void> {
    const MAX_RETRIES = 3;

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      console.log(`Verifying order summary page${retry > 0 ? ` (retry ${retry}/${MAX_RETRIES - 1})` : ""}...`);

      // Track which steps completed so retries resume from the failure point
      let quantityDone = false;
      let addressDone = false;
      let gstDone = false;

      try {
        // Wait for any pending navigation to finish (Place Order / Buy Now triggers navigation)
        try {
          await this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        } catch { /* already navigated or no navigation pending */ }

        // Wait for the page to be fully loaded (document.body must exist and have content)
        let pageReady = false;
        for (let i = 0; i < 40; i++) {
          try {
            const ready = await this.page.evaluate(() =>
              document.body !== null && (document.body?.innerText || "").length > 100
            );
            if (ready) { pageReady = true; break; }
          } catch { /* page still loading / context destroyed */ }
          await sleep(500);
        }

        if (!pageReady) {
          console.log("WARNING: Page did not fully load within 20s, attempting verification anyway");
        }

        await this.ensurePageValid();
        const pageUrl = this.page.url();
        console.log(`Order summary page URL: ${pageUrl}`);

        // Step 1: Verify quantity on order summary
        await this.verifyQuantityOnOrderSummary(expectedQty);
        quantityDone = true;

        // Step 2: Verify delivery address
        await this.verifyDeliveryAddressOnSummary(address);
        addressDone = true;

        // Wait for address change to settle before verifying GST
        console.log("Waiting for address to settle...");
        await sleep(2000);
        await this.ensurePageValid();
        await sleep(500);

        // Step 3: Verify GST invoice checkbox
        await this.verifyGstCheckboxOnSummary(address);
        gstDone = true;

        // Step 4: Click Continue to proceed to checkout page
        await this.clickContinueToCheckout();

        console.log("Order summary verification complete");
        return; // success — exit retry loop
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const completedSteps = [
          quantityDone ? "quantity" : null,
          addressDone ? "address" : null,
          gstDone ? "GST" : null,
        ].filter(Boolean).join(", ");
        const failedStep = !quantityDone ? "quantity" : !addressDone ? "address" : !gstDone ? "GST" : "Continue";

        console.log(`Order summary verification failed at step "${failedStep}" (completed: ${completedSteps || "none"}): ${errMsg}`);

        if (retry < MAX_RETRIES - 1) {
          console.log(`Refreshing page and retrying from "${failedStep}" step...`);
          // Refresh the order summary page to get a clean state for the failed step
          try {
            await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
          } catch { /* reload may timeout but page might still load */ }
          await sleep(2000);

          // Wait for page body to be ready after refresh
          for (let i = 0; i < 20; i++) {
            try {
              const ready = await this.page.evaluate(() =>
                document.body !== null && (document.body?.innerText || "").length > 100
              );
              if (ready) break;
            } catch { /* context still loading */ }
            await sleep(500);
          }
          await sleep(500);
        } else {
          // Final retry exhausted — re-throw
          throw new Error(`Order summary verification failed after ${MAX_RETRIES} attempts at step "${failedStep}": ${errMsg}`);
        }
      }
    }
  }

  /**
   * Verify and fix GST invoice details on the checkout page.
   * Called AFTER verifyAddressOnOrderSummary() once on /viewcheckout.
   */
  async verifyAddressOnCheckout(
    address?: AddressDetails
  ): Promise<void> {
    if (!address) {
      console.log("No GST address provided — skipping address verification");
      return;
    }

    const pageUrl = this.page.url();
    console.log(`Verifying address on checkout: ${address.gstNumber} (${address.companyName})`);
    console.log(`Current page URL: ${pageUrl}`);

    if (!pageUrl.includes("flipkart.com")) {
      console.log("ERROR: Not on Flipkart! Cannot verify address.");
      throw new Error("Not on Flipkart checkout page");
    }

    // ----------------------------------------------------------------
    // Step 1: Verify and fix delivery address (should be no-op if set on summary)
    // ----------------------------------------------------------------
    await this.verifyDeliveryAddress(address);

    // Wait for address change to settle before verifying GST
    console.log("Waiting for address to settle...");
    await sleep(2000);
    await this.ensurePageValid();
    await sleep(500);

    // ----------------------------------------------------------------
    // Step 2: Verify and fix GST invoice details
    // ----------------------------------------------------------------
    await this.verifyGstInvoice(address);

    // ----------------------------------------------------------------
    // Step 3: Ensure GST invoice checkbox is ticked
    // ----------------------------------------------------------------
    await this.ensureGstCheckboxTicked();

    console.log("Address verification complete");
  }

  // ================================================================
  // ORDER SUMMARY PAGE METHODS
  // These run on the intermediate order summary page after Buy Now
  // ================================================================

  private async verifyQuantityOnOrderSummary(expectedQty: number): Promise<void> {
    console.log(`Verifying quantity on order summary: expected=${expectedQty}`);

    // Try to find the quantity displayed on the order summary page
    let displayedQty = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const qtyText = await this.page.evaluate(() => {
        // Look for quantity near "Qty" text or a number near product info
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          // Flipkart often shows "Qty: N" or just the number next to product
          if (/^[\d]+$/.test(txt) && d.offsetParent !== null) {
            // Check if this div is near a qty-related parent
            let el: HTMLElement | null = d.parentElement;
            let found = false;
            while (el && el !== document.body) {
              const parentTxt = (el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
              if (parentTxt.includes("qty")) {
                found = true;
                break;
              }
              el = el.parentElement;
            }
            if (found) return txt;
          }
          // Also try: look for a div where the text starts with "Qty"
          if (txt.toLowerCase().startsWith("qty")) {
            const match = txt.match(/qty[:\s]*(\d+)/i);
            if (match) return match[1];
          }
        }
        // Fallback: look for any number input or select with quantity
        const selects = document.querySelectorAll("select");
        for (const s of selects) {
          const parentTxt = ((s.closest("div")?.innerText) || "").toLowerCase();
          if (parentTxt.includes("qty")) {
            return (s as HTMLSelectElement).value;
          }
        }
        // Fallback: look for a visible quantity input
        const inputs = document.querySelectorAll("input");
        for (const inp of inputs) {
          const placeholder = (inp.getAttribute("placeholder") || "").toLowerCase();
          const name = (inp.getAttribute("name") || "").toLowerCase();
          if ((placeholder.includes("quantity") || name.includes("quantity")) && inp.value) {
            return inp.value;
          }
        }
        return null;
      });

      if (qtyText) {
        displayedQty = parseInt(qtyText, 10);
        if (!isNaN(displayedQty)) break;
      }
      await sleep(300);
    }

    if (displayedQty > 0) {
      console.log(`Current quantity on summary: ${displayedQty}`);
    } else {
      console.log("Could not detect quantity on order summary page — assuming correct");
      return;
    }

    if (displayedQty === expectedQty) {
      console.log("Quantity matches — no change needed");
      return;
    }

    console.log(`Quantity mismatch: ${displayedQty} vs ${expectedQty} — correcting...`);

    // Click the Qty selector to open the quantity dropdown/dialog
    // Pattern from setQuantity(): find div with class css-146c3p1 near "Qty"
    let qtyClicked = false;
    for (let attempt = 0; attempt < 3 && !qtyClicked; attempt++) {
      const result = await this.page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt.toLowerCase().startsWith("qty")) {
            // Walk up to find clickable parent
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
                el.scrollIntoView({ block: "center" });
                el.click();
                return "clicked";
              }
              el = el.parentElement;
            }
            // Fallback: click the div itself
            (d as HTMLElement).click();
            return "clicked_fallback";
          }
        }
        // Alternative: look for div with css-146c3p1 class that is near Qty text
        for (const d of allDivs) {
          const cls = d.className || "";
          if (cls.includes("css-146c3p1")) {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return "clicked_css_class";
              }
              el = el.parentElement;
            }
          }
        }
        return null;
      });

      if (result) {
        qtyClicked = true;
        console.log(`Qty selector clicked (${result})`);
        await sleep(300);
      } else {
        console.log(`Qty selector not found (attempt ${attempt + 1}/3)`);
        await sleep(300);
      }
    }

    if (!qtyClicked) {
      console.log("WARNING: Could not open quantity selector — proceeding anyway");
      return;
    }

    // Wait for the quantity dialog/dropdown to appear
    let dialogReady = false;
    for (let i = 0; i < 5 && !dialogReady; i++) {
      dialogReady = await this.page.evaluate(() => {
        return (
          !!document.querySelector('input[placeholder*="Quantity" i]') ||
          !!document.querySelector('input[placeholder*="Qty" i]') ||
          !!document.querySelector(".css-146c3p1") ||
          (document.body?.innerText || "").includes("APPLY")
        );
      });
      if (!dialogReady) await sleep(300);
    }

    if (!dialogReady) {
      console.log("WARNING: Quantity dialog did not appear — proceeding anyway");
      return;
    }

    // Type the desired quantity into the input
    await this.page.evaluate((qty: number) => {
      // Try to find the quantity input
      const selectors = [
        'input[placeholder*="Quantity" i]',
        'input[placeholder*="Qty" i]',
        'input[name*="quantity" i]',
      ];
      for (const sel of selectors) {
        const inp = document.querySelector(sel) as HTMLInputElement | null;
        if (inp) {
          inp.focus();
          // Clear and type
          inp.value = "";
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(inp, String(qty));
          else inp.value = String(qty);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return "typed";
        }
      }
      return null;
    }, expectedQty);
    await sleep(500);

    // Click APPLY button
    let applied = false;
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      const result = await this.page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toUpperCase();
          if (txt === "APPLY") {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
                el.scrollIntoView({ block: "center" });
                el.click();
                return "clicked";
              }
              el = el.parentElement;
            }
            (d as HTMLElement).click();
            return "clicked_fallback";
          }
        }
        // Also try button
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const txt = (btn.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
          if (txt === "APPLY") {
            (btn as HTMLElement).click();
            return "clicked_button";
          }
        }
        return null;
      });

      if (result) {
        applied = true;
        console.log(`Quantity APPLY clicked (${result})`);
        await sleep(500);
      } else {
        console.log(`APPLY button not found (attempt ${attempt + 1}/3)`);
        await sleep(300);
      }
    }

    if (!applied) {
      console.log("WARNING: Could not click APPLY — quantity may not be updated");
    } else {
      console.log(`Quantity updated to ${expectedQty} on order summary`);
    }
  }

  private async verifyDeliveryAddressOnSummary(address: AddressDetails): Promise<void> {
    const effectivePincode = (address.checkoutPincode || address.pincode).trim();
    console.log("Verifying delivery address on order summary...");
    console.log(`Looking for: city="${address.city}", pincode="${effectivePincode}"${address.checkoutPincode ? ` (checkout override, original: ${address.pincode})` : ""}`);

    // Wait for the order summary page to fully load the address section
    try {
      await this.page.waitForFunction(
        () => {
          const body = document.body?.innerText || "";
          return body.includes("Deliver to") || body.includes("Delivery Address");
        },
        { timeout: 15000 }
      );
      console.log("Address section loaded on order summary");
    } catch {
      console.log("WARNING: Address section not found on order summary page");
    }
    await sleep(300);

    // Read current address text
    const currentText = await this.page.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll("div"));
      for (const d of allDivs) {
        const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
        if (txt.startsWith("Deliver to:")) {
          return d.innerText || "";
        }
      }
      // Fallback: look for any div containing address-relevant text
      for (const d of allDivs) {
        const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
        if (txt.includes("Deliver to")) {
          return d.innerText || "";
        }
      }
      return "";
    });

    console.log(`Current address text: "${(currentText || "").slice(0, 150)}"`);

    const matchScore = this.scoreAddressMatch(currentText, address);
    const hasPincode = (currentText || "").includes(effectivePincode);
    const hasCity = (currentText || "").toLowerCase().includes(address.city.trim().toLowerCase());
    const hasName = (currentText || "").toLowerCase().includes((address.companyName || address.name || "").trim().toLowerCase());
    console.log(`Address match score: ${matchScore}/6, pincode=${hasPincode}, city=${hasCity}, name=${hasName}`);

    // Accept if any 2 of: pincode, city, name match — the address is already correct
    if (matchScore >= 2 || (hasPincode && hasCity) || (hasCity && hasName) || (hasPincode && hasName)) {
      console.log("Delivery address matches on order summary — no change needed");
      return;
    }

    // Address mismatch — click "Change" near the address section
    console.log("Delivery address mismatch on order summary — clicking Change...");
    await this.clickAddressChangeButton();
    await sleep(500);

    // Wait for address list/modal to appear
    let addressListLoaded = false;
    for (let i = 0; i < 8 && !addressListLoaded; i++) {
      await sleep(300);
      addressListLoaded = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        return (
          body.includes("Deliver to") ||
          body.includes("Select Delivery") ||
          body.includes("Saved Address") ||
          body.includes("Delivery Address") ||
          body.includes("ADD A NEW ADDRESS")
        );
      });
      if (addressListLoaded) {
        console.log(`Address list loaded (${(i + 1) * 1000}ms)`);
        break;
      }
    }

    if (!addressListLoaded) {
      console.log("WARNING: Address list did not appear after Change click");
    }

    await sleep(300);

    // Try to select the address from the existing saved list — never add a new one
    const found = await this.selectAddressFromList(address);
    if (found) {
      console.log("Selected address from existing list on order summary");
    } else {
      console.log("WARNING: Could not find matching address in saved list — continuing with current address");
    }

    // Wait for modal to close
    let modalClosed = false;
    for (let i = 0; i < 8 && !modalClosed; i++) {
      await sleep(300);
      try {
        const stillOpen = await this.page.evaluate(() => {
          const body = document.body?.innerText || "";
          return (
            body.includes("Select Delivery Address") ||
            body.includes("Edit Address") ||
            body.includes("ADD A NEW ADDRESS")
          );
        });
        if (!stillOpen) {
          modalClosed = true;
          console.log(`Address modal closed after ~${(i + 1) * 1000}ms`);
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("detached") || msg.includes("Frame")) {
          modalClosed = true;
        }
      }
    }
  }

  private async verifyGstCheckboxOnSummary(address: AddressDetails): Promise<void> {
    console.log("Verifying GST checkbox on order summary...");
    const gstNumber = address.gstNumber.trim();
    const companyName = address.companyName.trim();
    console.log(`Target GST: ${gstNumber} / ${companyName}`);

    // Wait for GST section to be visible (up to 10s for slower pages / multi-tab flows)
    let gstSectionVisible = false;
    for (let i = 0; i < 20; i++) {
      const visible = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        return body.includes("Use GST Invoice") || body.includes("GST Invoice") || body.includes("GST invoice");
      });
      if (visible) { gstSectionVisible = true; break; }
      await sleep(500);
    }
    if (!gstSectionVisible) {
      console.log("WARNING: GST section not found on page after 10s wait");
    }

    // Helper: check if the GST checkbox is ticked (multiple detection strategies)
    const isGstChecked = async (): Promise<boolean> => {
      return this.page.evaluate(() => {
        // Strategy 1: r-d045u9 class with checked image
        const checkboxDivs = Array.from(document.querySelectorAll("div")).filter(d =>
          d.className.includes("r-d045u9")
        );
        for (const cbDiv of checkboxDivs) {
          const imgs = cbDiv.querySelectorAll("img");
          for (const img of imgs) {
            const srcset = img.getAttribute("srcset") || "";
            const src = img.getAttribute("src") || "";
            if (srcset.includes("checked") || src.includes("checked")) return true;
          }
        }
        // Strategy 2: Look for checked image near "Use GST Invoice" text
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt.includes("Use GST Invoice") || txt.includes("GST Invoice")) {
            const imgs = d.querySelectorAll("img");
            for (const img of imgs) {
              const srcset = img.getAttribute("srcset") || "";
              const src = img.getAttribute("src") || "";
              if (srcset.includes("checked") || src.includes("checked")) return true;
            }
          }
        }
        // Strategy 3: ARIA checkbox
        const ariaCheckboxes = document.querySelectorAll('[role="checkbox"][aria-checked="true"]');
        for (const cb of ariaCheckboxes) {
          const parent = cb.closest("div");
          if (parent && (parent.innerText || "").includes("GST")) return true;
        }
        return false;
      });
    };

    // Helper: click the GST checkbox (multiple strategies)
    const clickGstCheckbox = async (): Promise<boolean> => {
      return this.page.evaluate(() => {
        // Strategy 1: r-d045u9 class div inside cursor:pointer container
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const className = d.className || "";
          if (className.includes("r-d045u9")) {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement;
            }
            d.scrollIntoView({ block: "center" });
            d.click();
            return true;
          }
        }
        // Strategy 2: Find "Use GST Invoice" text and click the clickable area near it
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt === "Use GST Invoice" || txt === "Use GST invoice") {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement;
            }
            // Click the parent that likely contains the checkbox
            const parent = d.parentElement;
            if (parent) {
              parent.scrollIntoView({ block: "center" });
              parent.click();
              return true;
            }
          }
        }
        // Strategy 3: ARIA checkbox role
        const ariaCheckboxes = document.querySelectorAll('[role="checkbox"]');
        for (const cb of ariaCheckboxes) {
          const parent = cb.closest("div");
          if (parent && (parent.innerText || "").includes("GST")) {
            (cb as HTMLElement).scrollIntoView({ block: "center" });
            (cb as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
    };

    // Helper: click "Confirm and Save" or "Confirm and Use"
    const clickConfirmButton = async (): Promise<boolean> => {
      return this.page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt === "Confirm and Save" || txt === "Confirm and Use") {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement;
            }
            d.scrollIntoView({ block: "center" });
            d.click();
            return true;
          }
        }
        return false;
      });
    };

    // Helper: click "Add new GST Details"
    const clickAddNewGst = async (): Promise<boolean> => {
      return this.page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt === "Add new GST Details") {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement;
            }
            el = d.parentElement;
            while (el && el !== document.body) {
              const cls = el.className || "";
              if (cls.includes("css-g5y9jx")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement;
            }
            d.scrollIntoView({ block: "center" });
            d.click();
            return true;
          }
        }
        return false;
      });
    };

    // Helper: wait for GST form inputs to appear (max 10s)
    const waitForGstForm = async (): Promise<boolean> => {
      for (let i = 0; i < 20; i++) {
        try {
          const ready = await this.page.evaluate(() => {
            const gst = document.querySelector('input[maxlength="15"]');
            const company = document.querySelector('input[maxlength="60"]');
            return gst !== null || company !== null;
          });
          if (ready) return true;
        } catch {}
        await sleep(500);
      }
      return false;
    };

    // Helper: fill GST form using page.keyboard.type (most reliable for React)
    const fillGstFormViaKeyboard = async (gstNum: string, compName: string): Promise<void> => {
      console.log("Filling GST form via keyboard...");
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const gstInput = await this.page.$('input[maxlength="15"]');
          if (gstInput) {
            await gstInput.click({ clickCount: 3 });
            await this.page.keyboard.type(gstNum, { delay: 80 });
            console.log(`GSTIN entered: ${gstNum.slice(0, 2)}***${gstNum.slice(-2)}`);

            const companyInput = await this.page.$('input[maxlength="60"]');
            if (companyInput) {
              await companyInput.click({ clickCount: 3 });
              await this.page.keyboard.type(compName, { delay: 80 });
              console.log(`Company name entered: ${compName}`);
            }
            return;
          }
        } catch (e) {
          console.log(`Fill attempt ${attempt + 1} failed: ${(e as Error).message}`);
          await sleep(500);
        }
      }
      await this.fillGstForm(gstNum, compName);
    };

    // === Main logic ===

    // Check if the TARGET GST number is already on the page (not just any GSTIN)
    const targetGstOnPage = await this.page.evaluate((targetGst: string) => {
      const body = document.body?.innerText || "";
      return body.includes(targetGst);
    }, gstNumber);

    if (targetGstOnPage) {
      console.log(`Target GST number found on page: ${gstNumber}`);
      if (await isGstChecked()) {
        console.log("GST checkbox already ticked with correct GST");
        return;
      }
      const clicked = await clickGstCheckbox();
      if (!clicked) {
        throw new Error("Could not click GST checkbox — cannot proceed");
      }
      await sleep(1000);
      if (await isGstChecked()) {
        console.log("GST checkbox ticked successfully");
        return;
      }
      // If "Select GST Details" form opened, handle it
      const formOpened = await this.page.evaluate(() =>
        (document.body?.innerText || "").includes("Select GST Details")
      );
      if (formOpened) {
        console.log("GST selection form opened — selecting target GST entry...");
        const selected = await this.page.evaluate((gst: string) => {
          const allDivs = Array.from(document.querySelectorAll("div"));
          for (const d of allDivs) {
            if ((d.innerText || "").includes(gst)) {
              let el = d as HTMLElement | null;
              while (el && el !== document.body) {
                const style = el.getAttribute("style") || "";
                if (style.includes("cursor: pointer")) {
                  el.scrollIntoView({ block: "center" });
                  el.click();
                  return true;
                }
                el = el.parentElement;
              }
              (d as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, gstNumber);
        if (selected) {
          await sleep(500);
          await clickConfirmButton();
          await sleep(1000);
        }
        if (await isGstChecked()) {
          console.log("GST checkbox ticked after selecting target entry");
          return;
        }
      }
      await clickGstCheckbox();
      await sleep(1000);
      if (await isGstChecked()) {
        console.log("GST checkbox ticked successfully");
        return;
      }
      throw new Error("GST invoice checkbox is not ticked after all attempts — cannot proceed to payment");
    }

    // === No GST on page — "Use GST Invoice" case ===
    console.log("No GST on page — clicking checkbox to open GST form...");
    const clicked = await clickGstCheckbox();
    if (!clicked) {
      throw new Error("Could not click GST checkbox — cannot proceed");
    }
    await sleep(1000);

    // Wait for form inputs to appear
    const formReady = await waitForGstForm();
    if (!formReady) {
      const modalOpen = await this.page.evaluate(() =>
        (document.body?.innerText || "").includes("Select GST Details")
      );
      if (modalOpen) {
        console.log("GST selection modal opened...");
        const exists = await this.page.evaluate((gst) =>
          (document.body?.innerText || "").includes(gst)
        , gstNumber);
        if (exists) {
          console.log("GST found in saved list — selecting...");
          await this.page.evaluate((gst) => {
            const allDivs = Array.from(document.querySelectorAll("div"));
            for (const d of allDivs) {
              if ((d.innerText || "").includes(gst)) {
                let el = d as HTMLElement | null;
                while (el && el !== document.body) {
                  const style = el.getAttribute("style") || "";
                  if (style.includes("cursor: pointer")) {
                    el.scrollIntoView({ block: "center" });
                    el.click();
                    return true;
                  }
                  el = el.parentElement;
                }
                return true;
              }
            }
            return false;
          }, gstNumber);
          await sleep(500);
          await clickConfirmButton();
          await sleep(1000);
          if (await isGstChecked()) {
            console.log("GST checkbox ticked");
            return;
          }
        }
        console.log("GST not in list — clicking Add new GST Details...");
        await clickAddNewGst();
        await sleep(1000);
        const inputsReady = await waitForGstForm();
        if (!inputsReady) {
          throw new Error("GST form inputs never appeared — cannot enter GST details");
        }
      } else {
        throw new Error("GST form never appeared after clicking checkbox — cannot enter GST details");
      }
    }

    // Form is open — fill GST details via keyboard
    console.log("GST form open — entering details...");
    await fillGstFormViaKeyboard(gstNumber, companyName);
    await sleep(500);

    console.log("Clicking Confirm and Save...");
    await clickConfirmButton();
    await this.ensurePageValid();
    await sleep(1500);

    if (await isGstChecked()) {
      console.log("GST checkbox ticked successfully");
      return;
    }

    await clickGstCheckbox();
    await sleep(1000);
    if (await isGstChecked()) {
      console.log("GST checkbox ticked successfully");
      return;
    }

    throw new Error("GST invoice checkbox is not ticked after all attempts — cannot proceed to payment");
  }

  private async clickContinueToCheckout(): Promise<void> {
    console.log("Clicking Continue to proceed to checkout...");

    // Wait for the Continue button to appear
    let buttonFound = false;
    for (let attempt = 0; attempt < 3 && !buttonFound; attempt++) {
      try {
        await this.page.waitForFunction(
          () => {
            const allDivs = Array.from(document.querySelectorAll("div"));
            for (const d of allDivs) {
              const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
              // Flipkart Continue button often has "continue" text with green styling
              if (txt === "continue" || txt === "continue ") {
                return true;
              }
            }
            // Also check buttons
            const buttons = Array.from(document.querySelectorAll("button"));
            for (const b of buttons) {
              const txt = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
              if (txt === "continue" || txt === "continue ") return true;
            }
            return false;
          },
          { timeout: 15000 }
        );
        buttonFound = true;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("detached") || msg.includes("Frame")) {
          console.log("Frame detached while waiting for Continue (attempt " + (attempt + 1) + "/3)");
          await sleep(500);
        } else {
          console.log("WARNING: Continue button not found: " + msg);
          return;
        }
      }
    }

    if (!buttonFound) {
      console.log("WARNING: Continue button never appeared");
      return;
    }

    // Click the Continue button
    let result: string | null = null;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      result = await this.page.evaluate(() => {
        // Try buttons first (most reliable)
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          const txt = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (txt === "continue" || txt === "continue ") {
            (b as HTMLElement).click();
            return "clicked_button";
          }
        }
        // Try divs
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (txt === "continue" || txt === "continue ") {
            // Walk up to find clickable parent
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
                el.scrollIntoView({ block: "center" });
                el.click();
                return "clicked_div";
              }
              el = el.parentElement;
            }
            // Fallback: click div itself
            (d as HTMLElement).click();
            return "clicked_div_fallback";
          }
        }
        return null;
      });

      if (result) {
        console.log(`Continue clicked (${result})`);
        break;
      } else {
        console.log(`Continue not found (attempt ${attempt + 1}/3)`);
        await sleep(300);
      }
    }

    if (!result) {
      console.log("WARNING: Could not click Continue button");
      return;
    }

    // Wait for navigation away from order summary to payment page.
    // After clicking Continue, the URL changes FROM /viewcheckout TO the payment page.
    // We wait for the URL to NOT contain /viewcheckout, then wait for it to stabilize.
    console.log("Waiting for Continue navigation...");
    const startUrl = this.page.url();
    let paymentPageReached = false;

    for (let i = 0; i < 30; i++) { // 30 * 200ms = 6s max
      await sleep(200);
      try {
        const url = this.page.url();
        // Payment page URL patterns: does NOT contain /viewcheckout
        if (url !== startUrl && !url.includes("/viewcheckout")) {
          console.log(`Navigated away from order summary: ${url}`);
          // Now wait for the page to fully load (networkidle2 equivalent via polling)
          for (let j = 0; j < 30; j++) { // 30 * 200ms = 6s max
            await sleep(200);
            try {
              const bodyLen = await this.page.evaluate(() => (document.body?.innerText || "").length);
              const currentUrl = this.page.url();
              // Check we're still on the same page (not redirected back)
              if (currentUrl === url && bodyLen > 100) {
                paymentPageReached = true;
                console.log(`Payment page loaded: ${url}, body length: ${bodyLen}`);
                break;
              }
            } catch {
              // Page still loading, continue
            }
          }
          break;
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("detached") || msg.includes("Frame") || msg.includes("Session closed")) {
          console.log("Frame detached during Continue navigation — waiting...");
        }
      }
    }

    if (!paymentPageReached) {
      const finalUrl = this.page.url();
      console.log(`WARNING: Payment page may not have loaded. URL: ${finalUrl}`);
    } else {
      console.log("Continue navigation complete — on payment page");
    }
  }

  private async verifyDeliveryAddress(address: AddressDetails): Promise<void> {
    const effectivePincode = (address.checkoutPincode || address.pincode).trim();
    console.log("Checking delivery address...");
    console.log(`Looking for: city="${address.city}", pincode="${effectivePincode}", locality="${address.locality}"`);

    // Wait for the checkout page to load
    try {
      await this.page.waitForFunction(
        () => {
          const divs = document.querySelectorAll("div");
          for (const d of divs) {
            const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
            if (txt.startsWith("Deliver to:")) return true;
          }
          return false;
        },
        { timeout: 15000 }
      );
      console.log("Checkout page loaded, checking address...");
    } catch {
      console.log("WARNING: Checkout page did not load within 15s");
    }

    // Get the current address text to check if it matches
    const currentText = await this.page.evaluate(() => {
      const divs = document.querySelectorAll("div");
      for (const d of divs) {
        const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
        if (txt.startsWith("Deliver to:")) return d.innerText || "";
      }
      return "";
    });
    console.log(`Current address: "${currentText.slice(0, 150)}"`);

    const hasPincode = currentText.includes(effectivePincode);
    const hasCity = currentText.toLowerCase().includes(address.city.trim().toLowerCase());
    const matchScore = this.scoreAddressMatch(currentText, address);

    console.log(`Pincode match: ${hasPincode}, City match: ${hasCity}, Score: ${matchScore}/6`);

    if (hasPincode && hasCity) {
      console.log("Delivery address matches — no change needed");
      return;
    }

    // ----------------------------------------------------------------
    // Step 1: Click "Change" button to open address list
    // There are TWO "Change" buttons on checkout: one for address, one for GST.
    // We need to find the one inside/near the "Deliver to:" section specifically.
    // ----------------------------------------------------------------
    console.log("Delivery address mismatch — clicking Change to open address list...");
    await this.clickAddressChangeButton();

    // Wait for the address list/modal to appear
    let addressListLoaded = false;
    for (let i = 0; i < 8; i++) {
      await sleep(300);
      const listVisible = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        return (
          body.includes("Deliver to") ||
          body.includes("Select Delivery") ||
          body.includes("Edit Address") ||
          body.includes("Saved Address") ||
          body.includes("Delivery Address") ||
          body.includes("ADD A NEW ADDRESS")
        );
      });
      if (listVisible) {
        console.log(`Address list loaded (${(i + 1) * 1000}ms)`);
        addressListLoaded = true;
        break;
      }
    }

    if (!addressListLoaded) {
      console.log("WARNING: Address list did not appear, taking screenshot");
      // Dump page content to understand what happened
      const dump = await this.page.evaluate(() => {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        return body.slice(0, 800);
      });
      console.log(`[verifyDeliveryAddress] Page text after Change click: "${dump}"`);
    }

    // Give the address list a moment to fully render
    await sleep(300);

    // ----------------------------------------------------------------
    // Step 2: Try to select the address from the list
    // ----------------------------------------------------------------
    // Step 2: Try to select the address from the list
    // ----------------------------------------------------------------
    const found = await this.selectAddressFromList(address);
    if (found) {
      console.log("Selected address from existing list");
      // Wait for address modal to close (indicates return to checkout)
      console.log("Waiting for address modal to close...");
      let modalClosed = false;
      for (let i = 0; i < 8 && !modalClosed; i++) {
        await sleep(300);
        try {
          const isModalOpen = await this.page.evaluate(() => {
            const body = document.body?.innerText || "";
            return (
              body.includes("Select Delivery Address") ||
              body.includes("Edit Address") ||
              body.includes("ADD A NEW ADDRESS")
            );
          });
          if (!isModalOpen) {
            console.log(`Address modal closed after ~${(i + 1) * 1000}ms`);
            modalClosed = true;
          } else {
            console.log(`Address modal still open (${(i + 1) * 1000}ms)...`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("detached") || msg.includes("Frame")) {
            console.log(`[verifyDeliveryAddress] Frame detached — modal likely closed`);
            modalClosed = true;
          } else {
            console.log(`[verifyDeliveryAddress] Error checking modal state: ${msg}`);
          }
        }
      }

      if (modalClosed) {
        console.log("Address selected successfully — proceeding with checkout");
        await sleep(300);
        return;
      }

      // Modal is still open — the click may not have actually selected the address
      console.log("WARNING: Modal still open after click — selection may have failed");
      console.log("Refreshing page to check state...");
      try {
        await this.page.reload({ waitUntil: "networkidle2", timeout: 15000 });
      } catch {}
      await sleep(500);

      // Check if the address is now correctly set on the checkout page
      const stillWrong = await this.page.evaluate((addr: AddressDetails) => {
        const body = document.body?.innerText || "";
        return !body.includes(addr.pincode.trim());
      }, address);

      if (stillWrong) {
        console.log("WARNING: Address not correctly set — continuing with current address");
      } else {
        console.log("Address appears correct after refresh — proceeding");
      }
    }
  }

  private async verifyGstInvoice(address: AddressDetails): Promise<void> {
    console.log("Checking GST invoice details...");

    // Wait for the GST section to be visible on the checkout page
    // Look for the "GST Invoice" or "Tax Invoice" section with "Change" button
    let gstSectionVisible = false;
    for (let attempt = 0; attempt < 5 && !gstSectionVisible; attempt++) {
      gstSectionVisible = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        return (
          body.includes("GST Invoice") ||
          body.includes("Tax Invoice") ||
          body.includes("Use GST Invoice") ||
          body.includes("GST invoice") ||
          /\d{2}[A-Z]{3}[A-Z0-9]{10}/.test(body) // GST number pattern 15 chars
        );
      });
      if (!gstSectionVisible) {
        console.log(`GST section not visible yet (attempt ${attempt + 1}/5), waiting...`);
        await sleep(500);
      }
    }

    if (!gstSectionVisible) {
      console.log("No GST section found on this page — skipping GST verification");
      return;
    }
    console.log("GST section found on page, checking current details...");

    // Extract all text from the page to search for GST number
    const pageText = await this.page.evaluate(() => document.body?.innerText || "");

    const gstNumberClean = address.gstNumber.trim().replace(/\s/g, "");
    const companyNameClean = address.companyName.trim().toLowerCase();

    // Primary check: GST number appears anywhere on the page
    const hasGstNumber = gstNumberClean.length >= 15 && pageText.includes(gstNumberClean);

    // Secondary check: company name appears in GST context
    const hasCompanyName = companyNameClean.length >= 3 && pageText.includes(companyNameClean);

    console.log(`GST number "${gstNumberClean}" on page: ${hasGstNumber}`);
    console.log(`Company name "${companyNameClean}" on page: ${hasCompanyName}`);

    // If GST number is found, consider it a match (company name may be abbreviated on checkout)
    if (hasGstNumber) {
      console.log("GST invoice details match — no change needed");
      return;
    }

    console.log("GST invoice mismatch or missing — updating GST details");

    // Find the GST-specific "Change" button — look for it inside the GST invoice section
    // Strategy: find a "Change" button that is near GST-related text
    let gstChangeClicked = false;
    for (let attempt = 0; attempt < 3 && !gstChangeClicked; attempt++) {
      const result = await this.page.evaluate(() => {
        // Find the GST invoice section first
        const allDivs = Array.from(document.querySelectorAll("div"));
        let gstSectionDiv: HTMLElement | null = null;

        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (
            txt.includes("GST Invoice") ||
            txt.includes("Tax Invoice") ||
            txt.includes("Use GST Invoice") ||
            txt.includes("GST invoice")
          ) {
            // Make sure this is a substantial div (not a tiny element)
            if ((d.innerText || "").length > 20) {
              gstSectionDiv = d;
              break;
            }
          }
        }

        if (!gstSectionDiv) return "no_section";

        // Now find the "Change" button inside or near the GST section
        const changeButtons = Array.from(
          gstSectionDiv.querySelectorAll("div, span")
        ) as HTMLElement[];
        for (const btn of changeButtons) {
          const txt = (btn.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (txt === "change") {
            // Walk up to find clickable parent
            let el: HTMLElement | null = btn;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              if (
                style.includes("cursor: pointer") ||
                el.getAttribute("role") === "button" ||
                el.tagName === "BUTTON"
              ) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return "clicked";
              }
              el = el.parentElement;
            }
            // Fallback: click btn itself
            btn.scrollIntoView({ block: "center" });
            btn.click();
            return "clicked";
          }
        }
        return "no_button";
      });

      if (result === "clicked") {
        gstChangeClicked = true;
        console.log("GST 'Change' button clicked");
        break;
      } else if (result === "no_section") {
        console.log(`GST section not found in DOM (attempt ${attempt + 1}/3)`);
      } else {
        console.log(`GST 'Change' button not found in section (attempt ${attempt + 1}/3)`);
      }
      await sleep(300);
    }

    if (!gstChangeClicked) {
      // Fallback: try the general text button approach
      console.log("Trying general 'Change' button approach...");
      await this.clickTextButton("Change");
      await sleep(500);
    }

    // Wait for GST form or "Add new GST Details" to appear
    let gstFormReady = false;
    for (let i = 0; i < 5 && !gstFormReady; i++) {
      gstFormReady = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        return (
          body.includes("Add new GST Details") ||
          document.querySelector('input[maxlength="15"]') !== null ||
          document.querySelector('input[maxlength="60"]') !== null
        );
      });
      if (!gstFormReady) {
        await sleep(300);
      }
    }

    // Check if "Add new GST Details" button is visible and click it
    const hasAddNewGst = await this.page.evaluate(() => {
      return (document.body?.innerText || "").includes("Add new GST Details");
    });

    if (hasAddNewGst) {
      console.log("Clicking 'Add new GST Details'...");
      await this.clickTextButton("Add new GST Details");
      await sleep(500);
    } else {
      console.log("'Add new GST Details' not found — form may already be open");
    }

    // Wait for form inputs to appear
    for (let i = 0; i < 5; i++) {
      const hasInputs = await this.page.evaluate(() => {
        return (
          document.querySelector('input[maxlength="15"]') !== null ||
          document.querySelector('input[maxlength="60"]') !== null
        );
      });
      if (hasInputs) break;
      await sleep(300);
    }

    // Fill GST number and company name
    await this.fillGstForm(address.gstNumber, address.companyName);

    // Click Confirm and Save
    await this.clickConfirmAndSave();
    await sleep(500);
  }

  private async ensureGstCheckboxTicked(): Promise<void> {
    console.log("Checking GST invoice checkbox...");

    // Wait for GST section to be visible first
    for (let i = 0; i < 5; i++) {
      const visible = await this.page.evaluate(() => {
        const body = document.body?.innerText || "";
        return body.includes("Use GST Invoice") || body.includes("GST Invoice");
      });
      if (visible) break;
      await sleep(300);
    }

    // Check if GST checkbox is already ticked
    const isChecked = await this.page.evaluate(() => {
      // Flipkart uses img tags for checkbox states
      const checkedImgs = document.querySelectorAll('img[src*="checked"]');
      // Also check for any checkbox-like element that is checked
      const checkboxes = document.querySelectorAll('[role="checkbox"]');
      for (const cb of checkboxes) {
        if (cb.getAttribute("aria-checked") === "true") return true;
      }
      // Check if any img near "Use GST Invoice" is checked
      const allDivs = Array.from(document.querySelectorAll("div"));
      for (const d of allDivs) {
        if ((d.innerText || "").replace(/\s+/g, " ").trim().includes("Use GST Invoice")) {
          // Look for checked img inside this div's container
          let el: HTMLElement | null = d.parentElement;
          while (el && el !== document.body) {
            const imgs = el.querySelectorAll('img[src*="checked"]');
            if (imgs.length > 0) return true;
            el = el.parentElement;
          }
        }
      }
      return checkedImgs.length > 0;
    });

    if (isChecked) {
      console.log("GST invoice checkbox is already ticked");
      return;
    }

    console.log("GST invoice checkbox not ticked — clicking it");

    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      const result = await this.page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt.includes("Use GST Invoice")) {
            // Find the checkbox-like element within the GST section
            // Look for clickable elements near this text
            let el: HTMLElement | null = d.parentElement;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              const role = el.getAttribute("role") || "";
              if (
                style.includes("cursor: pointer") ||
                role === "checkbox" ||
                el.tagName === "INPUT" ||
                el.tagName === "IMG"
              ) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement;
            }
            // Fallback: click the nearest cursor:pointer parent of d
            let parentEl: HTMLElement | null = d;
            while (parentEl && parentEl !== document.body) {
              const pStyle = parentEl.getAttribute("style") || "";
              if (pStyle.includes("cursor: pointer")) {
                parentEl.scrollIntoView({ block: "center" });
                parentEl.click();
                return true;
              }
              parentEl = parentEl.parentElement;
            }
            // Last resort: click the div itself
            (d as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (result) {
        clicked = true;
        console.log("GST checkbox clicked");
      } else {
        console.log(`GST checkbox click failed (attempt ${attempt + 1}/3)`);
        await sleep(300);
      }
    }

    await sleep(300);
    const stillUnchecked = await this.page.evaluate(() => {
      const checkedImgs = document.querySelectorAll('img[src*="checked"]');
      return checkedImgs.length === 0;
    });

    if (stillUnchecked) {
      console.log("Warning: GST invoice checkbox may not have ticked — proceeding anyway");
    } else {
      console.log("GST invoice checkbox ticked successfully");
    }
  }

  private async clickTextButton(text: string, page?: import("puppeteer-core").Page): Promise<void> {
    const targetPage = page || this.page;
    const normalized = text.replace(/\s+/g, " ").trim();

    await waitWithRetry(
      targetPage,
      async () => {
        await targetPage.waitForFunction(
          (lbl: string) => {
            const allDivs = document.querySelectorAll("div");
            for (const d of allDivs) {
              const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
              if (txt.includes(lbl.toLowerCase())) return true;
            }
            return false;
          },
          { timeout: 5000 },
          normalized
        );
      },
      { label: `Button: ${text}`, timeoutMs: 8000, maxRetries: 5 }
    );

    await targetPage.evaluate(
      (lbl: string) => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        const matches = allDivs.filter((d) => {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
          return txt.includes(lbl.toLowerCase());
        });

        for (const d of matches) {
          let el: HTMLElement | null = d;
          while (el && el !== document.body) {
            const style = el.getAttribute("style") || "";
            if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
              el.scrollIntoView({ block: "center" });
              el.click();
              return;
            }
            el = el.parentElement as HTMLElement | null;
          }
          // Fallback: use parent if it has cursor
          const parent = d.parentElement;
          if (parent && (parent.getAttribute("style") || "").includes("cursor")) {
            parent.scrollIntoView({ block: "center" });
            parent.click();
            return;
          }
          d.scrollIntoView({ block: "center" });
          (d as HTMLElement).click();
          return;
        }
      },
      normalized
    );
    console.log(`Clicked: ${text}`);
  }

  /**
   * Click the "Change" button specifically for the delivery address section.
   * On the checkout page, there are multiple "Change" buttons (address + GST).
   * This method finds the one inside or adjacent to the "Deliver to:" section.
   */
  private async clickAddressChangeButton(): Promise<void> {
    // Wait for the address "Change" button to appear — handle detached frame errors
    let buttonFound = false;
    for (let attempt = 0; attempt < 3 && !buttonFound; attempt++) {
      try {
        await this.page.waitForFunction(
          () => {
            const divs = Array.from(document.querySelectorAll("div"));
            for (const d of divs) {
              const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
              if (txt === "Change " || txt === "Change") return true;
            }
            return false;
          },
          { timeout: 15000 }
        );
        buttonFound = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("detached") || msg.includes("Frame")) {
          console.log(`[clickAddressChangeButton] Frame detached (attempt ${attempt + 1}/3), retrying...`);
          await sleep(500);
        } else {
          console.log(`WARNING: Address 'Change' button never appeared: ${msg}`);
          return;
        }
      }
    }

    if (!buttonFound) {
      console.log("WARNING: Address 'Change' button never appeared");
      return;
    }

    // Find all "Change" buttons and pick the one near the "Deliver to:" section
    let result: string;
    try {
      result = await this.page.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll("div")) as HTMLElement[];

      // Find the "Deliver to:" section container first
      let deliverToSection: HTMLElement | null = null;
      for (const d of allDivs) {
        const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
        if (txt.startsWith("Deliver to:")) {
          deliverToSection = d;
          break;
        }
      }

      if (!deliverToSection) {
        // Fallback: click the first "Change" div we find
        for (const d of allDivs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt === "Change " || txt === "Change") {
            // Walk up to find clickable parent
            let el: HTMLElement | null = d;
            let bestEl: HTMLElement | null = null;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              const cls = el.className || "";
              if (cls.includes("css-g5y9jx") && style.includes("cursor")) {
                bestEl = el;
              }
              if (style.includes("cursor: pointer")) {
                bestEl = el;
              }
              el = el.parentElement as HTMLElement | null;
            }
            if (bestEl) {
              bestEl.scrollIntoView({ block: "center" });
              bestEl.click();
              return "clicked_first_change";
            }
            (d as HTMLElement).click();
            return "clicked_first_change_fallback";
          }
        }
        return "no_change_button_found";
      }

      // Find "Change" buttons inside or near the "Deliver to:" section
      // Walk through siblings of deliverToSection
      const parent = deliverToSection.parentElement;
      if (parent) {
        const siblings = Array.from(parent.querySelectorAll(":scope > *")) as HTMLElement[];
        for (const sibling of siblings) {
          const siblingText = (sibling.innerText || "").replace(/\s+/g, " ").trim();
          if (siblingText === "Change " || siblingText === "Change") {
            sibling.scrollIntoView({ block: "center" });
            sibling.click();
            return "clicked_deliver_section_sibling";
          }
        }
      }

      // Search within the deliverToSection and nearby DOM for "Change"
      const innerDivs = Array.from(
        deliverToSection.querySelectorAll("div, span, button")
      ) as HTMLElement[];
      for (const d of innerDivs) {
        const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
        if (txt === "Change " || txt === "Change") {
          let el: HTMLElement | null = d;
          while (el && el !== document.body) {
            const style = el.getAttribute("style") || "";
            if (style.includes("cursor: pointer")) {
              el.scrollIntoView({ block: "center" });
              el.click();
              return "clicked_inside_deliver_section";
            }
            el = el.parentElement;
          }
          (d as HTMLElement).click();
          return "clicked_inside_deliver_fallback";
        }
      }

      // Check if "Change" is in the parent's siblings' children
      if (parent && parent.parentElement) {
        const gpChildren = Array.from(
          parent.parentElement.querySelectorAll(":scope > *")
        ) as HTMLElement[];
        for (const child of gpChildren) {
          if (child === parent) continue;
          const childText = (child.innerText || "").replace(/\s+/g, " ").trim();
          if (childText === "Change " || childText === "Change") {
            child.scrollIntoView({ block: "center" });
            child.click();
            return "clicked_gp_sibling";
          }
          // Look in grandchildren
          const gc = Array.from(
            child.querySelectorAll("div, span, button")
          ) as HTMLElement[];
          for (const gcEl of gc) {
            const gcText = (gcEl.innerText || "").replace(/\s+/g, " ").trim();
            if (gcText === "Change " || gcText === "Change") {
              let el: HTMLElement | null = gcEl;
              while (el && el !== document.body) {
                if ((el.getAttribute("style") || "").includes("cursor: pointer")) {
                  el.scrollIntoView({ block: "center" });
                  el.click();
                  return "clicked_gc";
                }
                el = el.parentElement;
              }
            }
          }
        }
      }

      // Last resort: scan ALL divs and prefer the one closest to "Deliver to:"
      let bestDist = Infinity;
      let bestEl: HTMLElement | null = null;
      const dtRect = deliverToSection.getBoundingClientRect();
      for (const d of allDivs) {
        const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
        if (txt === "Change " || txt === "Change") {
          const r = d.getBoundingClientRect();
          const dist = Math.abs(r.top - dtRect.top) + Math.abs(r.left - dtRect.left);
          if (dist < bestDist) {
            bestDist = dist;
            bestEl = d;
          }
        }
      }
      if (bestEl) {
        bestEl.scrollIntoView({ block: "center" });
        bestEl.click();
        return `clicked_nearest_change_dist=${bestDist.toFixed(0)}`;
      }

      return "no_change_button_found";
    });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("detached") || msg.includes("Frame")) {
        console.log("[clickAddressChangeButton] Frame detached during evaluation — page likely navigated, proceeding...");
      } else {
        console.log(`[clickAddressChangeButton] Evaluate error: ${msg}`);
      }
      return;
    }

    console.log(`[clickAddressChangeButton] Result: ${result}`);
  }

  /** Click a button by text — finds divs matching the text, then clicks the outermost clickable parent */
  private async clickDivButton(label: string): Promise<void> {
    // Normalize the label: collapse all whitespace to single spaces, trim
    const normalizedLabel = label.replace(/\s+/g, " ").trim().toLowerCase();

    // Wait for the button to appear using waitForFunction with regex matching
    try {
      await this.page.waitForFunction(
        (lbl: string) => {
          const allDivs = document.querySelectorAll("div");
          for (const d of allDivs) {
            const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (txt.includes(lbl.toLowerCase())) return true;
          }
          return false;
        },
        { timeout: 15000 },
        label.replace(/\s+/g, " ").trim()
      );
      console.log(`Button found: ${label}`);
    } catch {
      // Debug: show what's on the page
      const pageText = await this.page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll("div"));
        const results: { text: string; style: string }[] = [];
        for (const d of divs) {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          if (txt.length > 2 && txt.length < 100) {
            results.push({ text: txt, style: (d.getAttribute("style") || "").slice(0, 100) });
          }
        }
        return results.slice(0, 30);
      });
      console.log(`WARNING: Could not find button "${label}". Page divs:`);
      pageText.forEach((d) => console.log(`  "${d.text}" | style="${d.style}"`));
      return;
    }

    // Find and click using page.evaluate
    const clicked = await this.page.evaluate(
      (lbl: string) => {
        // Find ALL divs containing the label text (case-insensitive, whitespace-normalized)
        const allDivs = Array.from(document.querySelectorAll("div"));
        const matchingDivs = allDivs.filter((d) => {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          return txt.toLowerCase().includes(lbl.toLowerCase());
        });

        console.log(`Found ${matchingDivs.length} div(s) with text containing "${lbl}"`);

        for (const d of matchingDivs) {
          // Walk UP to find the best clickable parent (css-g5y9jx with cursor)
          let bestEl: HTMLElement | null = null;
          let el: HTMLElement | null = d;
          let depth = 0;
          while (el && el !== document.body && depth < 10) {
            const cls = el.className || "";
            const style = el.getAttribute("style") || "";
            if (cls.includes("css-g5y9jx") && style.includes("cursor")) {
              bestEl = el;
            }
            // Also capture any element with cursor: pointer
            if (style.includes("cursor: pointer")) {
              bestEl = el;
            }
            el = el.parentElement as HTMLElement | null;
            depth++;
          }

          if (bestEl) {
            bestEl.scrollIntoView({ block: "center" });
            bestEl.click();
            return true;
          }

          // Fallback: click the text div itself
          (d as HTMLElement).click();
          return true;
        }
        return false;
      },
      label.replace(/\s+/g, " ").trim()
    );

    if (clicked) {
      console.log(`Clicked: ${label}`);
    } else {
      console.log(`WARNING: Could not click: ${label}`);
    }
  }

  /** Click the "ADD A NEW ADDRESS" button on the addresses page */
  private async clickAddNewAddressButton(page: import("puppeteer-core").Page): Promise<void> {
    const label = "ADD A NEW ADDRESS";

    // Wait for the button to appear
    try {
      await page.waitForFunction(
        (lbl: string) => {
          // Method 1: Find by class cv8zZS
          const byClass = document.querySelectorAll(".cv8zZS") as NodeListOf<HTMLElement>;
          for (const b of byClass) {
            const txt = (b.innerText || "").toUpperCase();
            if (txt.includes(lbl)) return true;
          }
          // Method 2: Find any div containing the text
          const allDivs = document.querySelectorAll("div") as NodeListOf<HTMLElement>;
          for (const d of allDivs) {
            const txt = (d.innerText || "").toUpperCase();
            if (txt.includes(lbl)) return true;
          }
          return false;
        },
        { timeout: 10000 },
        label
      );
      console.log(`Button found: ${label}`);
    } catch {
      console.log(`WARNING: Could not find button "${label}"`);
      return;
    }

    // Find and click: target div.cv8zZS that contains the text
    const clicked = await page.evaluate(
      (lbl: string) => {
        // Strategy 1: Find div.cv8zZS that has the text
        const byClass = document.querySelectorAll(".cv8zZS") as NodeListOf<HTMLElement>;
        for (const d of byClass) {
          const txt = (d.innerText || "").toUpperCase();
          if (txt.includes(lbl)) {
            d.scrollIntoView({ block: "center" });
            d.click();
            return true;
          }
        }
        // Strategy 2: Find any div with the text, then walk up to cv8zZS
        const allDivs = Array.from(document.querySelectorAll("div")) as HTMLElement[];
        for (const d of allDivs) {
          const txt = (d.innerText || "").toUpperCase();
          if (txt.includes(lbl)) {
            let el: HTMLElement | null = d;
            while (el && el !== document.body) {
              if (el.className && el.className.includes("cv8zZS")) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return true;
              }
              el = el.parentElement as HTMLElement | null;
            }
            // Fallback: click the div
            d.scrollIntoView({ block: "center" });
            (d as HTMLElement).click();
            return true;
          }
        }
        return false;
      },
      label
    );

    if (clicked) {
      console.log("Clicked: ADD A NEW ADDRESS");
    } else {
      console.log("WARNING: Could not click ADD A NEW ADDRESS");
    }
  }

  /** Click the Save button on the address form */
  private async clickSaveButton(page: import("puppeteer-core").Page): Promise<void> {
    // Wait for a Save button to appear — search by text content, not class name
    let buttonFound = false;
    for (let attempt = 0; attempt < 10 && !buttonFound; attempt++) {
      try {
        buttonFound = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const btn of buttons) {
            const txt = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (txt === "save" || txt === "save address" || txt === "save and deliver here") {
              return true;
            }
          }
          return false;
        });
        if (buttonFound) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("detached") || msg.includes("Frame")) {
          console.log(`[clickSaveButton] Frame detached during wait (attempt ${attempt + 1}/10), retrying...`);
        }
      }
      await sleep(500);
    }

    if (!buttonFound) {
      console.log("WARNING: Save button never appeared");
      return;
    }
    console.log("Save button found");

    // Click the Save button by text content with mouse events for React compatibility
    let clicked = false;
    try {
      clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const btn of buttons) {
          const txt = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (txt === "save" || txt === "save address" || txt === "save and deliver here") {
            btn.scrollIntoView({ block: "center" });
            const rect = btn.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, button: 0 }));
            btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
            btn.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, button: 0 }));
            return true;
          }
        }
        return false;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("detached") || msg.includes("Frame")) {
        console.log(`[clickSaveButton] Frame detached — page navigated, save likely succeeded`);
        return;
      }
      console.log(`[clickSaveButton] Click error: ${msg}`);
    }

    if (clicked) console.log("Clicked: Save button");
    else console.log("WARNING: Could not click Save button");
  }

  /** Click the "Confirm and Save" button in the GST form — div.css-g5y9jx with grey background */
  private async clickConfirmAndSave(): Promise<void> {
    const label = "Confirm and Save";

    // Wait for the button to appear
    try {
      await this.page.waitForFunction(
        (lbl: string) => {
          const allDivs = document.querySelectorAll("div");
          for (const d of allDivs) {
            const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
            if (txt === lbl || txt.includes(lbl)) return true;
          }
          return false;
        },
        { timeout: 10000 },
        label
      );
      console.log("Confirm and Save button found");
    } catch {
      console.log("WARNING: Could not find Confirm and Save button");
      return;
    }

    // Click: find the div containing the text, then walk up to the clickable parent
    const clicked = await this.page.evaluate(
      (lbl: string) => {
        const allDivs = Array.from(document.querySelectorAll("div"));
        const matches = allDivs.filter((d) => {
          const txt = (d.innerText || "").replace(/\s+/g, " ").trim();
          return txt.includes(lbl);
        });

        for (const d of matches) {
          // Walk up to find the best clickable element
          let el: HTMLElement | null = d;
          let bestEl: HTMLElement | null = null;
          while (el && el !== document.body) {
            const style = el.getAttribute("style") || "";
            const cls = el.className || "";
            // Prefer the grey-background div (css-g5y9jx)
            if (cls.includes("css-g5y9jx") && style.includes("cursor")) {
              bestEl = el;
            }
            if (style.includes("cursor: pointer")) {
              bestEl = el;
            }
            el = el.parentElement as HTMLElement | null;
          }
          if (bestEl) {
            bestEl.scrollIntoView({ block: "center" });
            bestEl.click();
            return true;
          }
          // Fallback: click the text div itself
          (d as HTMLElement).click();
          return true;
        }
        return false;
      },
      label
    );

    if (clicked) console.log("Clicked: Confirm and Save");
    else console.log("WARNING: Could not click Confirm and Save");
  }

  /**
   * Scans the saved-addresses modal for a card matching the target address
   * by company name + city + locality. Falls back to false if no match found.
   * Saved address cards show: company name (bold) + "locality, city" text.
   */
  private async selectAddressFromList(address: AddressDetails): Promise<boolean> {
    const targetName = (address.companyName || address.name || "").trim().toLowerCase();
    const targetCity = address.city.trim().toLowerCase();
    const targetLocality = (address.locality || "").trim().toLowerCase();
    console.log(`[SelectAddress] Looking for saved address: name="${targetName}", city="${targetCity}", locality="${targetLocality}"`);

    // Wait for the address modal to appear
    let modalFound = false;
    for (let attempt = 0; attempt < 8 && !modalFound; attempt++) {
      try {
        modalFound = await this.page.evaluate(() => {
          const body = document.body?.innerText || "";
          return (
            body.includes("Deliver to") ||
            body.includes("Select Delivery Address") ||
            body.includes("Saved Address") ||
            body.includes("Delivery Address") ||
            body.includes("ADD A NEW ADDRESS")
          );
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("detached") || msg.includes("Frame")) {
          console.log(`[SelectAddress] Frame detached (attempt ${attempt + 1}/8), waiting...`);
          await sleep(500);
          continue;
        }
        throw err;
      }
      if (!modalFound) await sleep(300);
    }

    if (!modalFound) {
      console.log("[SelectAddress] Address modal never appeared");
      return false;
    }
    console.log("[SelectAddress] Address modal detected");
    await sleep(500);

    // Find all address card candidates — Flipkart uses cDeXU9 for clickable address cards
    // Each card contains company name div + locality/city text div
    let result: {
      x: number;
      y: number;
      cardText: string;
      score: number;
    } | null = null;

    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        result = await this.page.evaluate(
          (addr: AddressDetails) => {
            const targetName = (addr.companyName || addr.name || "").trim().toLowerCase();
            const targetCity = addr.city.trim().toLowerCase();
            const targetLocality = (addr.locality || "").trim().toLowerCase();

            const cards: {
              el: HTMLElement;
              name: string;
              text: string;
              rect: DOMRect;
            }[] = [];

            // Strategy 1: Find by cDeXU9 class (the address card class from the DOM)
            const cdexu9 = document.querySelectorAll(".cDeXU9");
            for (const el of cdexu9) {
              // cDeXU9 cards have cursor:pointer and contain address text
              const text = (el as HTMLElement).innerText || "";
              const style = (el as HTMLElement).getAttribute("style") || "";
              if (
                style.includes("cursor") &&
                text.trim().length > 5 &&
                !text.toLowerCase().includes("add a new address")
              ) {
                const r = (el as HTMLElement).getBoundingClientRect();
                cards.push({ el: el as HTMLElement, name: "", text, rect: r });
              }
            }

            // Strategy 2: Find all divs with cursor:pointer that look like address cards
            if (cards.length === 0) {
              const allDivs = document.querySelectorAll("div[style*='cursor']");
              for (const el of allDivs) {
                const style = (el as HTMLElement).getAttribute("style") || "";
                const text = (el as HTMLElement).innerText || "";
                if (
                  style.includes("pointer") &&
                  text.trim().length > 10 &&
                  !text.toLowerCase().includes("add a new address") &&
                  (text.toLowerCase().includes("deliver") ||
                    text.toLowerCase().includes(targetCity) ||
                    text.toLowerCase().includes("address"))
                ) {
                  const r = (el as HTMLElement).getBoundingClientRect();
                  cards.push({ el: el as HTMLElement, name: "", text, rect: r });
                }
              }
            }

            // Strategy 3: Find any visible divs containing address-like text
            if (cards.length === 0) {
              const allEls = document.querySelectorAll("div");
              for (const el of allEls) {
                const text = (el as HTMLElement).innerText || "";
                const style = (el as HTMLElement).getAttribute("style") || "";
                if (
                  (style.includes("cursor") || style.includes("pointer")) &&
                  text.trim().length > 20 &&
                  !text.toLowerCase().includes("add a new address") &&
                  (text.toLowerCase().includes(targetCity) || text.toLowerCase().includes(targetName))
                ) {
                  const r = (el as HTMLElement).getBoundingClientRect();
                  cards.push({ el: el as HTMLElement, name: "", text, rect: r });
                }
              }
            }

            console.log(`[SelectAddress] Found ${cards.length} address card candidates`);

            if (cards.length === 0) {
              // Last resort: scan all visible clickable divs with city or name text
              const allDivs = Array.from(document.querySelectorAll("div")) as HTMLElement[];
              for (const d of allDivs) {
                const style = d.getAttribute("style") || "";
                const text = d.innerText || "";
                const cls = d.className || "";
                if (
                  (style.includes("cursor") || cls.includes("css-g5y9jx")) &&
                  text.trim().length > 15 &&
                  !text.toLowerCase().includes("add a new address") &&
                  text.toLowerCase().includes(targetCity)
                ) {
                  const r = d.getBoundingClientRect();
                  if (r.width > 50 && r.height > 30) {
                    cards.push({ el: d, name: "", text, rect: r });
                  }
                }
              }
            }

            // Score each card
            let bestScore = -1;
            let bestCard: { el: HTMLElement; name: string; text: string; rect: DOMRect } | null = null;

            for (const card of cards) {
              const cardText = card.text.toLowerCase();
              const cardName = card.name.toLowerCase();
              let score = 0;

              // Name match (highest weight — company names are unique per address)
              if (targetName && (cardText.includes(targetName) || cardName.includes(targetName))) {
                score += 4;
              }

              // City match
              if (targetCity && cardText.includes(targetCity)) {
                score += 2;
              }

              // Locality keyword match
              if (targetLocality) {
                const localityParts = targetLocality.split(/\s+/).filter((p) => p.length > 3);
                for (const part of localityParts) {
                  if (cardText.includes(part)) {
                    score += 1;
                    break;
                  }
                }
              }

              console.log(
                `[SelectAddress] Card score=${score} name="${targetName}" city="${targetCity}" | text="${card.text.replace(
                  /\s+/g,
                  " "
                ).trim().slice(0, 100)}"`
              );

              if (score > bestScore) {
                bestScore = score;
                bestCard = card;
              }
            }

            if (!bestCard || bestScore < 1) {
              console.log(`[SelectAddress] No matching address card found (bestScore=${bestScore})`);
              // Log all card texts for debugging
              for (const card of cards) {
                console.log(`[SelectAddress]   candidate: "${card.text.replace(/\s+/g, " ").trim().slice(0, 120)}"`);
              }
              return null;
            }

            console.log(`[SelectAddress] Best match: score=${bestScore} text="${bestCard.text.replace(/\s+/g, " ").trim().slice(0, 100)}"`);

            // Walk up to find the most appropriate clickable ancestor
            let clickableEl: HTMLElement | null = bestCard.el;
            let el: HTMLElement | null = bestCard.el;
            while (el && el !== document.body) {
              const style = el.getAttribute("style") || "";
              const cls = el.className || "";
              if ((style.includes("cursor") || cls.includes("cDeXU9") || cls.includes("css-g5y9jx")) && style.includes("cursor")) {
                clickableEl = el;
                break;
              }
              el = el.parentElement;
            }

            const rect = clickableEl!.getBoundingClientRect();
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              cardText: bestCard.text.replace(/\s+/g, " ").trim().slice(0, 120),
              score: bestScore,
            };
          },
          address
        );
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("detached") || msg.includes("Frame")) {
          console.log(`[SelectAddress] Frame detached (attempt ${attempt + 1}/3), retrying...`);
          await sleep(500);
          continue;
        }
        console.log(`[SelectAddress] Evaluate error: ${msg}`);
        return false;
      }
    }

    if (!result) {
      console.log("[SelectAddress] Could not locate any address card — returning false");
      return false;
    }

    console.log(`[SelectAddress] Best match (score=${result.score}): "${result.cardText}"`);
    console.log(`[SelectAddress] Clicking at (${result.x.toFixed(0)}, ${result.y.toFixed(0)})`);

    try {
      await this.page.mouse.move(result.x, result.y);
      await sleep(100);
      await this.page.mouse.click(result.x, result.y);
      console.log("[SelectAddress] Mouse click succeeded");
      return true;
    } catch (err) {
      console.log(`[SelectAddress] Mouse click failed: ${(err as Error).message}`);
      try {
        await this.page.evaluate(
          (coords: { x: number; y: number }) => {
            const el = document.elementFromPoint(coords.x, coords.y);
            if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: coords.x, clientY: coords.y }));
          },
          { x: result.x, y: result.y }
        );
        console.log("[SelectAddress] Clicked via elementFromPoint");
        return true;
      } catch (e) {
        console.log(`[SelectAddress] All click methods failed: ${(e as Error).message}`);
        return false;
      }
    }
  }


  private async fillAddressForm(
    page: import("puppeteer-core").Page,
    address: AddressDetails
  ): Promise<void> {
    const pincodeToUse = address.checkoutPincode || address.pincode;

    // Fill using name attributes — Flipkart uses standard HTML name attributes on inputs
    await this.fillByName(page, "name", address.name, "Name");
    await this.fillByName(page, "phone", address.mobile, "Mobile");
    await this.fillByName(page, "pincode", pincodeToUse, "Pincode");
    await this.fillByName(page, "addressLine2", address.locality, "Locality");
    await this.fillTextareaByName(page, "addressLine1", address.addressLine1, "Address");
    await this.fillByName(page, "city", address.city, "City");

    // Select state from dropdown
    let stateSet = false;
    for (let attempt = 0; attempt < 5 && !stateSet; attempt++) {
      const result = await page.evaluate((stateVal: string) => {
        const select = document.querySelector('select[name="state"]') as HTMLSelectElement | null;
        if (!select) return "not_found";
        const options = Array.from(select.querySelectorAll("option"));
        const found = options.find((opt) => opt.value === stateVal);
        if (found) {
          select.value = stateVal;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return "found";
        }
        return "not_found";
      }, address.state);
      if (result === "found") {
        console.log(`Selected state: ${address.state}`);
        stateSet = true;
        await sleep(300);
      } else {
        console.log(`State "${address.state}" not found in dropdown (attempt ${attempt + 1}/5)`);
        await sleep(300);
      }
    }

    // Click Home or Work radio — radio inputs are readonly, so click the <label> instead
    const radioId = address.addressType === "Home" ? "HOME" : "WORK";
    let typeSet = false;
    for (let attempt = 0; attempt < 5 && !typeSet; attempt++) {
      const result = await page.evaluate((id: string) => {
        // Strategy 1: Click the <label> for the radio (most reliable since input is readonly)
        const label = document.querySelector(`label[for="${id}"]`) as HTMLLabelElement | null;
        if (label) {
          label.scrollIntoView({ block: "center" });
          label.click();
          return "label";
        }
        // Strategy 2: Click the radio input directly + set checked property
        const radio = document.getElementById(id) as HTMLInputElement | null;
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          radio.dispatchEvent(new Event("click", { bubbles: true }));
          return "radio";
        }
        // Strategy 3: Find by text content "Home" or "Work"
        const targetText = id === "HOME" ? "home" : "work";
        const allLabels = Array.from(document.querySelectorAll("label"));
        for (const l of allLabels) {
          if ((l.textContent || "").trim().toLowerCase() === targetText) {
            l.scrollIntoView({ block: "center" });
            l.click();
            return "text";
          }
        }
        return "not_found";
      }, radioId);
      if (result !== "not_found") {
        console.log(`Selected address type: ${address.addressType} (via ${result})`);
        typeSet = true;
        await sleep(300);
      } else {
        await sleep(500);
      }
    }
  }

  /** Type into an input by its name attribute */
  private async fillByName(
    page: import("puppeteer-core").Page,
    name: string,
    value: string,
    label: string
  ): Promise<void> {
    let found = false;
    for (let attempt = 0; attempt < 5 && !found; attempt++) {
      const result = await page.evaluate(
        (n: string, val: string) => {
          const input = document.querySelector(`input[name="${n}"]`) as HTMLInputElement | null;
          if (!input) return "not_found";
          input.focus();
          // Clear existing value
          input.value = "";
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, val);
          else input.value = val;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return "found";
        },
        name,
        value
      );
      if (result === "found") {
        console.log(`Filled ${label}`);
        found = true;
        await sleep(300);
      } else {
        console.log(`${label} (name="${name}") not found (attempt ${attempt + 1}/5)`);
        await sleep(300);
      }
    }
  }

  /** Type into a textarea by its name attribute */
  private async fillTextareaByName(
    page: import("puppeteer-core").Page,
    name: string,
    value: string,
    label: string
  ): Promise<void> {
    let found = false;
    for (let attempt = 0; attempt < 5 && !found; attempt++) {
      const result = await page.evaluate(
        (n: string, val: string) => {
          const textarea = document.querySelector(`textarea[name="${n}"]`) as HTMLTextAreaElement | null;
          if (!textarea) return "not_found";
          textarea.focus();
          textarea.value = "";
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(textarea, val);
          else textarea.value = val;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
          return "found";
        },
        name,
        value
      );
      if (result === "found") {
        console.log(`Filled ${label}`);
        found = true;
        await sleep(300);
      } else {
        console.log(`${label} (textarea[name="${name}"]) not found (attempt ${attempt + 1}/5)`);
        await sleep(300);
      }
    }
  }

  private async fillGstForm(gstNumber: string, companyName: string): Promise<void> {
    console.log("Filling GST form...");

    let filled = false;
    for (let attempt = 0; attempt < 5 && !filled; attempt++) {
      const result = await this.page.evaluate((gst: string, company: string) => {
        // Find GST number input: maxlength=15
        const gstEl = document.querySelector('input[maxlength="15"]') as HTMLInputElement | null;
        // Find company name input: maxlength=60
        const companyEl = document.querySelector('input[maxlength="60"]') as HTMLInputElement | null;

        const filledGst = gstEl !== null;
        const filledCompany = companyEl !== null;

        if (gstEl) {
          gstEl.focus();
          gstEl.value = "";
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(gstEl, gst);
          else gstEl.value = gst;
          gstEl.dispatchEvent(new Event("input", { bubbles: true }));
          gstEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (companyEl) {
          companyEl.focus();
          companyEl.value = "";
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(companyEl, company);
          else companyEl.value = company;
          companyEl.dispatchEvent(new Event("input", { bubbles: true }));
          companyEl.dispatchEvent(new Event("change", { bubbles: true }));
        }

        return { filledGst, filledCompany };
      }, gstNumber, companyName);

      if (result.filledGst) {
        console.log(`Entered GST number: ${gstNumber.slice(0, 2)}***${gstNumber.slice(-2)}`);
      } else {
        console.log(`WARNING: GST input [maxlength="15"] not found (attempt ${attempt + 1}/5)`);
      }
      if (result.filledCompany) {
        console.log(`Entered company name: ${companyName}`);
      } else {
        console.log(`WARNING: Company input [maxlength="60"] not found (attempt ${attempt + 1}/5)`);
      }

      if (result.filledGst && result.filledCompany) {
        filled = true;
      } else {
        await sleep(300);
      }
    }

    await sleep(500);
  }

  /**
   * Determine if the delivery address on the page matches the saved address.
   * Uses pincode + city as the primary anchor (most reliable on Flipkart).
   * Falls back to the overall text content search for partial matches.
   */
  private scoreAddressMatch(text: string, address: AddressDetails): number {
    if (!text) return 0;

    const lowerText = text.toLowerCase();
    const pincode = (address.checkoutPincode || address.pincode).trim();
    const city = address.city.trim().toLowerCase();
    const locality = address.locality.trim().toLowerCase();
    const name = address.name.trim().toLowerCase();
    const addrLine = address.addressLine1.trim().toLowerCase();

    let score = 0;

    // Pincode is the most reliable — if it matches, that's strong confirmation
    if (pincode.length === 6 && lowerText.includes(pincode)) {
      score += 2;
    }

    // City name match
    if (city.length >= 3 && lowerText.includes(city)) {
      score += 1;
    }

    // Locality — use first 2 significant words
    const localityKey = locality.split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(" ");
    if (localityKey.length > 0 && lowerText.includes(localityKey)) {
      score += 1;
    }

    // Name — flipkart may show just first name or full name
    if (name.length >= 3) {
      const nameParts = name.split(/\s+/);
      const nameMatch = nameParts.some((part) => part.length > 2 && lowerText.includes(part));
      if (nameMatch) score += 1;
    }

    // Address line — first 2 significant words
    const addrKey = addrLine.split(/\s+/).filter((w) => w.length > 3).slice(0, 2).join(" ");
    if (addrKey.length > 0 && lowerText.includes(addrKey)) {
      score += 1;
    }

    return score;
  }
}

