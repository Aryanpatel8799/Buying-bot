import { Browser, Page } from "puppeteer-core";
import { BasePlatform } from "../platforms/BasePlatform";
import { FlipkartPlatform } from "../platforms/FlipkartPlatform";
import { AmazonPlatform } from "../platforms/AmazonPlatform";
import { BasePayment } from "../payments/BasePayment";
import { CardPayment } from "../payments/CardPayment";
import { GiftCardPayment } from "../payments/GiftCardPayment";
import { RTGSPayment } from "../payments/RTGSPayment";
import { sleep, sendMessage } from "./helpers";
import type { JobConfig, ProductItem, CardDetails } from "../../src/types";

export class BatchOrchestrator {
  private shouldStopFlag = false;
  private isMultiUrl = false;
  private cards: CardDetails[] | null = null;
  private accounts: string[] | null = null;

  constructor(
    private page: Page,
    private platform: BasePlatform,
    private payment: BasePayment,
    private config: JobConfig
  ) {
    // Determine if this is a multi-URL job
    this.isMultiUrl = config.products && config.products.length > 1;

    // Store cards for rotation
    if (config.cards && config.cards.length > 0) {
      this.cards = config.cards;
    }

    // Store accounts for rotation
    if (config.accounts && config.accounts.length > 0) {
      this.accounts = config.accounts;

      // Defensive check: account rotation only works for Flipkart
      if (!(this.platform instanceof FlipkartPlatform)) {
        throw new Error("Account rotation is only supported for Flipkart");
      }
    }

    // Listen for stop signal (use once to prevent listener stacking)
    process.once("SIGTERM", () => {
      console.log("Received SIGTERM — stopping after current iteration...");
      this.shouldStopFlag = true;
    });
    process.once("SIGINT", () => {
      this.shouldStopFlag = true;
    });
  }

  async run(): Promise<void> {
    const totalIterations = Math.ceil(
      this.config.totalQuantity / this.config.perOrderQuantity
    );

    const maxConcurrentTabs = this.config.maxConcurrentTabs ?? 1;
    const isRTGSMultiTab =
      this.config.paymentMethod === "rtgs" && maxConcurrentTabs > 1;

    sendMessage({
      type: "log",
      level: "info",
      message: isRTGSMultiTab
        ? `Starting RTGS multi-tab batch: ${totalIterations} iterations, ${maxConcurrentTabs} tabs at a time`
        : this.isMultiUrl
        ? `Starting multi-URL batch: ${totalIterations} iterations, ${this.config.products.length} products`
        : `Starting batch: ${totalIterations} iterations (${this.config.totalQuantity} total qty, ${this.config.perOrderQuantity} per order)`,
    });

    if (isRTGSMultiTab) {
      await this.runRTGSBatched(totalIterations, maxConcurrentTabs);
      return;
    }

    let completed = 0;
    let failed = 0;

    for (let i = 0; i < totalIterations; i++) {
      if (this.shouldStopFlag) {
        sendMessage({
          type: "log",
          level: "warn",
          message: `Stopped by user after iteration ${i}`,
        });
        break;
      }

      sendMessage({
        type: "log",
        level: "info",
        message: `--- Iteration ${i + 1}/${totalIterations} ---`,
        iteration: i + 1,
      });

      try {
        // Account rotation: logout previous account and login next one
        if (this.accounts) {
          const accountIndex = i % this.accounts.length;
          const email = this.accounts[accountIndex];

          // Login with this iteration's account
          sendMessage({
            type: "log",
            level: "info",
            message: `Logging in with account ${accountIndex + 1}/${this.accounts.length}...`,
            iteration: i + 1,
          });
          await this.platform.loginWithEmail(email);

          // Notify frontend that OTP is needed
          const maskedEmail = `${email[0]}${"*".repeat(Math.max(email.indexOf("@") - 2, 1))}${email.substring(email.indexOf("@") - 1)}`;
          sendMessage({
            type: "waiting_for_otp",
            email: maskedEmail,
            iteration: i + 1,
          } as any);

          // Wait for human to enter OTP
          const loginSuccess = await this.platform.waitForLoginCompletion(300000);
          if (!loginSuccess) {
            throw new Error(`Login timed out for account ${accountIndex + 1}`);
          }

          sendMessage({
            type: "log",
            level: "info",
            message: `Login successful for account ${accountIndex + 1}`,
            iteration: i + 1,
          });
        }

        if (this.isMultiUrl) {
          await this.runMultiUrlIteration(i + 1);
        } else {
          await this.runSingleIteration(i + 1);
        }

        // Wait for payment to complete
        const success = await this.waitForPaymentCompletion();

        if (success) {
          completed++;
          sendMessage({
            type: "progress",
            iteration: i + 1,
            total: totalIterations,
            status: "success",
          });
        } else {
          failed++;
          sendMessage({
            type: "progress",
            iteration: i + 1,
            total: totalIterations,
            status: "failed",
          });
          await this.takeScreenshot(i + 1);
        }
      } catch (err) {
        failed++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        sendMessage({
          type: "log",
          level: "error",
          message: `Iteration ${i + 1} failed: ${errorMsg}`,
          iteration: i + 1,
        });
        sendMessage({
          type: "progress",
          iteration: i + 1,
          total: totalIterations,
          status: "failed",
        });
        await this.takeScreenshot(i + 1);
      }

      // Reset browser state and wait interval before next iteration (skip after last)
      if (i < totalIterations - 1 && !this.shouldStopFlag) {
        // Reset: navigate to homepage, clear cart, dismiss popups
        sendMessage({
          type: "log",
          level: "info",
          message: "Resetting browser for next iteration...",
        });
        try {
          await this.platform.resetForNextIteration();
        } catch (resetErr) {
          sendMessage({
            type: "log",
            level: "warn",
            message: `Reset warning: ${resetErr instanceof Error ? resetErr.message : resetErr}`,
          });
          // If reset fails, try to at least verify the page is still responsive
          try {
            await this.page.evaluate(() => document.readyState);
          } catch {
            sendMessage({
              type: "log",
              level: "warn",
              message: "Page unresponsive after reset, attempting recovery...",
            });
            // Try to recover by opening a new page in the browser
            try {
              const browser = this.page.browser();
              const pages = await browser.pages();
              if (pages.length > 0) {
                this.page = pages[0];
              }
            } catch {
              sendMessage({
                type: "log",
                level: "error",
                message: "Browser recovery failed, stopping iterations",
              });
              break;
            }
          }
        }

        sendMessage({
          type: "log",
          level: "info",
          message: `Waiting ${this.config.intervalSeconds}s before next order...`,
        });
        await sleep(this.config.intervalSeconds * 1000);
      }
    }

    // Logout the last account after all iterations
    if (this.accounts) {
      try {
        sendMessage({
          type: "log",
          level: "info",
          message: "Logging out final account...",
        });
        await this.platform.logout();
      } catch (err) {
        sendMessage({
          type: "log",
          level: "warn",
          message: `Final logout warning: ${err instanceof Error ? err.message : err}`,
        });
      }
    }

    sendMessage({
      type: "done",
      completed,
      failed,
    });
  }

  // ─── RTGS Multi-Tab Batched Flow ────────────────────────────────────────────

  /**
   * Runs RTGS iterations in batches of up to `maxConcurrentTabs` parallel tabs.
   * Each batch opens multiple tabs, runs the purchase flow on each, waits for
   * bank authentication on all tabs in parallel, then closes tabs and proceeds
   * to the next batch.
   */
  private async runRTGSBatched(
    totalIterations: number,
    maxConcurrentTabs: number
  ): Promise<void> {
    const browser = this.page.browser();
    const tabResults: Array<"success" | "failed" | "skipped" | "success-pending"> = new Array(
      totalIterations
    ).fill("skipped");

    for (
      let batchStart = 0;
      batchStart < totalIterations;
      batchStart += maxConcurrentTabs
    ) {
      if (this.shouldStopFlag) {
        sendMessage({ type: "log", level: "warn", message: "Stopped by user" });
        break;
      }

      const batchEnd = Math.min(batchStart + maxConcurrentTabs, totalIterations);
      const batchSize = batchEnd - batchStart;
      sendMessage({
        type: "log",
        level: "info",
        message: `RTGS batch ${Math.floor(batchStart / maxConcurrentTabs) + 1}: iterations ${batchStart + 1}–${batchEnd} (${batchSize} tabs)`,
      });

      // ── Account rotation (once per batch — all tabs in a batch share the same session) ──
      if (this.accounts) {
        const batchIndex = Math.floor(batchStart / maxConcurrentTabs);
        const accountIndex = batchIndex % this.accounts.length;
        const email = this.accounts[accountIndex];

        sendMessage({
          type: "log",
          level: "info",
          message: `Logging in with account ${accountIndex + 1}/${this.accounts.length} for batch...`,
        });
        await this.platform.loginWithEmail(email);

        const maskedEmail = `${email[0]}${"*".repeat(Math.max(email.indexOf("@") - 2, 1))}${email.substring(email.indexOf("@") - 1)}`;
        sendMessage({
          type: "waiting_for_otp",
          email: maskedEmail,
          iteration: batchStart + 1,
        } as any);

        const loginSuccess = await this.platform.waitForLoginCompletion(300000);
        if (!loginSuccess) {
          throw new Error(`Login timed out for account ${accountIndex + 1}`);
        }
        sendMessage({ type: "log", level: "info", message: "Login successful" });
      }

      // ── Open tabs for this batch ──
      // Tab 0 processes iterNum=batchStart+1 (navigated below), Tab 1=batchStart+2, etc.
      // The sequential loop (tabIndex) uses: iterNum = batchStart + tabIndex + 1
      // So Tab t (t>=1) should load: iterNum = batchStart + t + 1
      const tabPages: Page[] = [this.page]; // Tab 0 is the main page
      for (let t = 1; t < batchSize; t++) {
        const iterNum = batchStart + t + 1;
        const productUrl = this.getProductUrlForIteration(iterNum);
        const newPage = await browser.newPage();
        tabPages.push(newPage);
        // Navigate new tab to its product URL immediately
        await newPage.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(500);
      }
      sendMessage({
        type: "log",
        level: "info",
        message: `Opened ${batchSize} tabs for batch`,
      });

      // ── Run flow on each tab SEQUENTIALLY ──
      // Each tab: navigate → add to cart → place order → select RTGS → wait for poll URL → move to next tab
      // The user manually completes bank auth in each tab's popup. After poll URL is detected,
      // we immediately move to the next tab while the user completes auth in background.
      for (let tabIndex = 0; tabIndex < tabPages.length; tabIndex++) {
        const tabPage = tabPages[tabIndex];
        // Tab 0 = iteration batchStart+1 (first in batch), Tab 1 = batchStart+2, etc.
        const iterNum = batchStart + tabIndex + 1;

        sendMessage({
          type: "log",
          level: "info",
          message: `--- Tab ${tabIndex + 1}/${batchSize}: Iteration ${iterNum}/${totalIterations} ---`,
          iteration: iterNum,
        });

        try {
          // Get the product URL for this tab's iteration
          const productUrl = this.getProductUrlForIteration(iterNum);

          // Create a fresh platform instance for this tab with its correct product URL
          const tabPlatform =
            this.platform instanceof FlipkartPlatform
              ? new FlipkartPlatform(tabPage, productUrl)
              : new AmazonPlatform(tabPage, productUrl);
          const tabPayment = this.createPaymentForTab(tabPage);

          // For Tab 0 (main page), navigate to ensure we start on the right product.
          // This handles cases where Tab 0 is reused from a previous batch.
          // Tabs 1+ were pre-loaded with the correct product before the sequential loop.
          if (tabIndex === 0) {
            sendMessage({
              type: "log",
              level: "info",
              message: `Tab 0: navigating to product ${iterNum}: ${productUrl}`,
            });
            await tabPlatform.navigateToProduct();
          }

          // Run the purchase flow on this tab
          await this.runRTGSTabIteration(tabPage, tabPlatform, tabPayment, iterNum);

          // confirmPayment() clicks "Place Order", polls for /payments/rtgs/poll for up to 30s,
          // and returns true if the poll URL was reached, false if timed out.
          // Either way, mark the tab as pending — the parallel polling phase below will
          // continue checking each tab for order confirmation (bank auth may take time).
          const rtgsTab = tabPayment as unknown as RTGSPayment;
          const pollReached = await rtgsTab.confirmPayment();

          if (pollReached) {
            sendMessage({
              type: "log",
              level: "info",
              message: `Tab ${tabIndex + 1}: RTGS poll page confirmed — waiting for bank auth`,
              iteration: iterNum,
            });
          } else {
            sendMessage({
              type: "log",
              level: "warn",
              message: `Tab ${tabIndex + 1}: Poll URL not yet detected — orchestrator will poll during bank auth phase`,
              iteration: iterNum,
            });
          }
          // Always mark pending — bank auth may still complete in the parallel polling phase
          tabResults[batchStart + tabIndex] = "success-pending";

          // Immediately move to the next tab — don't wait for bank auth here
          // The user handles all bank auth in the popup tabs in the background
        } catch (err) {
          tabResults[batchStart + tabIndex] = "failed";
          const errMsg = err instanceof Error ? err.message : String(err);
          sendMessage({
            type: "log",
            level: "error",
            message: `Tab ${tabIndex + 1} failed: ${errMsg}`,
            iteration: iterNum,
          });
          sendMessage({
            type: "progress",
            iteration: iterNum,
            total: totalIterations,
            status: "failed",
          });
        }
      }

      // ── Wait for ALL bank authentications to complete ──
      // After starting all tabs, go back and poll each tab's poll page for confirmation
      sendMessage({
        type: "log",
        level: "info",
        message: `All tabs started — waiting for ${batchSize} bank authentications to complete...`,
      });

      const timeout = 5 * 60 * 1000; // 5 min per tab
      const deadline = Date.now() + timeout;
      const confirmedTabs = new Set<number>();
      const failedTabs = new Set<number>();

      while (confirmedTabs.size + failedTabs.size < batchSize && Date.now() < deadline) {
        for (let tabIndex = 0; tabIndex < tabPages.length; tabIndex++) {
          if (confirmedTabs.has(tabIndex) || failedTabs.has(tabIndex)) continue;
          if (tabResults[batchStart + tabIndex] === "failed") {
            failedTabs.add(tabIndex);
            continue;
          }

          const tabPage = tabPages[tabIndex];
          const iterNum = batchStart + tabIndex + 1;

          try {
            const url = tabPage.url();
            const isPollPage = url.includes("/payments/rtgs/poll");

            if (isPollPage) {
              const confirmed = await tabPage.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return (
                  text.includes("order placed") ||
                  text.includes("order confirmed") ||
                  text.includes("thank you") ||
                  text.includes("payment successful") ||
                  text.includes("order success")
                );
              });

              if (confirmed) {
                confirmedTabs.add(tabIndex);
                tabResults[batchStart + tabIndex] = "success";
                sendMessage({
                  type: "progress",
                  iteration: iterNum,
                  total: totalIterations,
                  status: "success",
                });
                sendMessage({
                  type: "log",
                  level: "info",
                  message: `Tab ${tabIndex + 1}: Order confirmed!`,
                  iteration: iterNum,
                });
              }
            } else if (url.includes("flipkart.com") && !url.includes("/payments/")) {
              // Navigated away from poll — check for confirmation
              const confirmed = await tabPage.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return (
                  text.includes("order placed") ||
                  text.includes("order confirmed") ||
                  text.includes("thank you")
                );
              });
              if (confirmed) {
                confirmedTabs.add(tabIndex);
                tabResults[batchStart + tabIndex] = "success";
                sendMessage({
                  type: "progress",
                  iteration: iterNum,
                  total: totalIterations,
                  status: "success",
                });
                sendMessage({
                  type: "log",
                  level: "info",
                  message: `Tab ${tabIndex + 1}: Order confirmed!`,
                  iteration: iterNum,
                });
              }
            }
          } catch {
            // Tab may be in transition — keep waiting
          }
        }

        if (confirmedTabs.size + failedTabs.size < batchSize) {
          await sleep(2000);
        }
      }

      // Mark remaining tabs as failed (timed out)
      for (let tabIndex = 0; tabIndex < batchSize; tabIndex++) {
        if (!confirmedTabs.has(tabIndex) && tabResults[batchStart + tabIndex] !== "success") {
          tabResults[batchStart + tabIndex] = "failed";
          const iterNum = batchStart + tabIndex + 1;
          sendMessage({
            type: "log",
            level: "warn",
            message: `Tab ${tabIndex + 1}: Bank auth timed out`,
            iteration: iterNum,
          });
          sendMessage({
            type: "progress",
            iteration: iterNum,
            total: totalIterations,
            status: "failed",
          });
        }
      }

      sendMessage({
        type: "log",
        level: "info",
        message: `Batch complete — closing ${batchSize} tabs`,
      });

      // ── Close extra tabs (keep tab 0 / main page open) ──
      for (let t = 1; t < tabPages.length; t++) {
        try {
          await tabPages[t].close();
        } catch {
          // Tab may have navigated away — ignore close errors
        }
      }
      tabPages.length = 0;

      // Return to Flipkart/Amazon homepage on main page to reset state
      try {
        await this.page.goto("https://www.flipkart.com", {
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });
      } catch { /* ignore */ }

      sendMessage({
        type: "log",
        level: "info",
        message: `Waiting ${this.config.intervalSeconds}s before next batch...`,
      });
      await sleep(this.config.intervalSeconds * 1000);
    }

    // Logout the last account after all batches
    if (this.accounts) {
      try {
        await this.platform.logout();
      } catch { /* ignore */ }
    }

    const completed = tabResults.filter((r) => r === "success").length;
    const failed = tabResults.filter((r) => r === "failed").length;
    sendMessage({ type: "done", completed, failed });
  }

  /**
   * Returns the product URL for a given iteration number.
   * Multi-URL: cycles through the products array (one per iteration).
   * Single-URL: returns the configured productUrl.
   */
  private getProductUrlForIteration(iterationNum: number): string {
    if (this.config.products && this.config.products.length > 0) {
      const index = (iterationNum - 1) % this.config.products.length;
      return this.config.products[index].url;
    }
    return this.config.productUrl;
  }

  /**
   * Creates a fresh payment instance for a given tab page.
   */
  private createPaymentForTab(tabPage: Page): BasePayment {
    switch (this.config.paymentMethod) {
      case "card":
        return new CardPayment(tabPage, this.config.platform);
      case "giftcard":
        return new GiftCardPayment(tabPage, this.config.platform);
      case "rtgs":
        return new RTGSPayment(tabPage, this.config.platform);
      default:
        throw new Error(`Unknown payment method: ${this.config.paymentMethod}`);
    }
  }

  /**
   * Runs the purchase flow for a single RTGS tab iteration:
   * navigate → add to cart → set quantity → go to cart → place order → verify order summary → select RTGS.
   * Does NOT wait for bank auth — that's handled by the caller in runRTGSBatched.
   */
  private async runRTGSTabIteration(
    tabPage: Page,
    tabPlatform: BasePlatform,
    tabPayment: BasePayment,
    iterationNum: number
  ): Promise<void> {
    const qty =
      this.config.products?.length === 1
        ? this.config.products[0].quantity
        : this.config.perOrderQuantity;

    // Navigate to product
    await tabPlatform.navigateToProduct();

    // Add to cart
    await tabPlatform.addToCart();

    // Set quantity (platform-dependent)
    if (tabPlatform.quantityBeforeBuy) {
      await tabPlatform.setQuantity(qty);
    }

    // Go to cart
    await tabPlatform.goToCart();

    // Set quantity in cart (Flipkart does qty in cart, Amazon already set it)
    if (!tabPlatform.quantityBeforeBuy && this.config.products?.length === 1) {
      await tabPlatform.setCartItemQuantity(0, qty);
    } else if (!tabPlatform.quantityBeforeBuy && this.config.products && this.config.products.length > 1) {
      for (let p = 0; p < this.config.products.length; p++) {
        await tabPlatform.setCartItemQuantity(p, this.config.products[p].quantity);
      }
    }

    // Place order from cart
    await tabPlatform.placeOrder();

    // Verify order summary (address + GST) if address is configured
    if (this.config.address && tabPlatform instanceof FlipkartPlatform) {
      try {
        await tabPlatform.verifyAddressOnOrderSummary(this.config.address, qty);
      } catch (err) {
        const warnMsg = err instanceof Error ? err.message : String(err);
        sendMessage({
          type: "log",
          level: "warn",
          message: `Order summary verification skipped (continuing): ${warnMsg}`,
          iteration: iterationNum,
        });
      }
    }

    // Select RTGS payment method on this tab
    await tabPayment.selectPaymentMethod();

    // fillDetails is a no-op for RTGS.
    // confirmPayment is NOT called here — the orchestrator calls it after runRTGSTabIteration
    // so it can properly handle the poll URL detection and move to the next tab.
    await tabPayment.fillDetails(this.config.paymentDetails);
  }

  /**
   * Multi-URL flow:
   * Amazon:   navigate → set quantity on product page → add to cart → repeat → go to cart → proceed to checkout → payment
   * Flipkart: navigate → add to cart → repeat → go to cart → set quantities in cart → place order → payment
   */
  private async runMultiUrlIteration(iterationNum: number): Promise<void> {
    const products = this.config.products;
    const setQtyBeforeCart = this.platform.quantityBeforeBuy; // Amazon = true, Flipkart = false

    // Step 1: For each product — navigate, (optionally set qty), add to cart
    for (let p = 0; p < products.length; p++) {
      const product = products[p];
      sendMessage({
        type: "log",
        level: "info",
        message: `Adding product ${p + 1}/${products.length} to cart...`,
        iteration: iterationNum,
      });

      // Set the current product URL on the platform
      this.platform.setProductUrl(product.url);

      // Navigate to this product
      await this.platform.navigateToProduct();

      // Amazon: set quantity on product page BEFORE adding to cart
      if (setQtyBeforeCart && product.quantity > 1) {
        sendMessage({
          type: "log",
          level: "info",
          message: `Setting quantity to ${product.quantity} on product page...`,
          iteration: iterationNum,
        });
        await this.platform.setQuantity(product.quantity);
      }

      // Add to cart
      await this.platform.addToCart();

      sendMessage({
        type: "log",
        level: "info",
        message: `Product ${p + 1} added to cart`,
        iteration: iterationNum,
      });
    }

    // Step 2: Go to cart
    sendMessage({
      type: "log",
      level: "info",
      message: "All products added. Opening cart...",
      iteration: iterationNum,
    });
    await this.platform.goToCart();

    // Step 3: Flipkart — set quantity for each product in the cart page
    // (Amazon already set quantity on product page, skip this)
    if (!setQtyBeforeCart) {
      for (let p = 0; p < products.length; p++) {
        const product = products[p];
        if (product.quantity > 1) {
          sendMessage({
            type: "log",
            level: "info",
            message: `Setting quantity for item ${p + 1} to ${product.quantity}...`,
            iteration: iterationNum,
          });
          await this.platform.setCartItemQuantity(p, product.quantity);
        }
      }
    }

    // Step 4: Place order / proceed to checkout from cart
    await this.platform.placeOrder();

    // Step 5: Verify order summary page (Flipkart only) — handles address, GST, then Continue to checkout.
    // verifyAddressOnOrderSummary() clicks Continue which navigates to the payment page.
    // DO NOT call proceedToCheckout() here — it would reload /viewcheckout and destroy the payment page.
    if (this.config.address && this.platform instanceof FlipkartPlatform) {
      try {
        const totalQty = this.config.products?.reduce((sum, p) => sum + p.quantity, 0) ?? this.config.perOrderQuantity;
        await this.platform.verifyAddressOnOrderSummary(this.config.address, totalQty);
      } catch (err) {
        const warnMsg = err instanceof Error ? err.message : String(err);
        sendMessage({
          type: "log",
          level: "warn",
          message: `Order summary verification failed (continuing): ${warnMsg}`,
          iteration: iterationNum,
        });
      }
    } else {
      sendMessage({
        type: "log",
        level: "warn",
        message: "No GST address configured for this job — skipping order summary address/GST verification.",
        iteration: iterationNum,
      });
    }

    // At this point we're on the payment page. proceedToCheckout() is NOT called —
    // verifyAddressOnOrderSummary() already handled the navigation via the Continue button.
    // The URL is now the payment page, NOT /viewcheckout.
    // verifyAddressOnCheckout() is skipped because address + GST were already verified
    // on the order summary page (verifyAddressOnOrderSummary).

    // Step 6: Payment flow with retry
    await this.runPaymentFlow(iterationNum);

    sendMessage({
      type: "log",
      level: "info",
      message: `Iteration ${iterationNum}: Payment submitted, verifying...`,
      iteration: iterationNum,
    });
  }

  private async runSingleIteration(iterationNum: number): Promise<void> {
    // For single-URL jobs, use the first product if products array exists, else use productUrl
    if (this.config.products && this.config.products.length === 1) {
      this.platform.setProductUrl(this.config.products[0].url);
    }

    // Step 1: Navigate to product
    await this.platform.navigateToProduct();

    // Step 2 & 3: Quantity before or after Buy Now depends on platform
    const qty = this.config.products?.length === 1
      ? this.config.products[0].quantity
      : this.config.perOrderQuantity;

    if (this.platform.quantityBeforeBuy) {
      await this.platform.setQuantity(qty);
      await this.platform.clickBuyNow();
    } else {
      await this.platform.clickBuyNow();
      await this.platform.setQuantity(qty);
    }

    // Step 4: Verify order summary page (Flipkart only) — handles quantity, address, GST, then Continue to checkout
    if (this.config.address && this.platform instanceof FlipkartPlatform) {
      // verifyAddressOnOrderSummary() handles address + GST + clicks Continue → navigates to payment page
      try {
        await this.platform.verifyAddressOnOrderSummary(this.config.address, qty);
      } catch (err) {
        const warnMsg = err instanceof Error ? err.message : String(err);
        sendMessage({
          type: "log",
          level: "warn",
          message: `Order summary verification failed (continuing): ${warnMsg}`,
          iteration: iterationNum,
        });
      }
    } else {
      sendMessage({
        type: "log",
        level: "warn",
        message: "No GST address configured — skipping order summary address/GST verification.",
        iteration: iterationNum,
      });
      // Still need to: click Continue on order summary to get to payment page
      // proceedToCheckout() must NOT be called — it navigates away from the payment page.
      if (this.platform instanceof FlipkartPlatform) {
        sendMessage({
          type: "log",
          level: "info",
          message: "Waiting for order summary page to load...",
          iteration: iterationNum,
        });
        // Wait for order summary content (react renders async)
        for (let i = 0; i < 20; i++) {
          try {
            const bodyLen = await this.page.evaluate(() => document.body.innerText.length);
            if (bodyLen > 100) break;
          } catch { /* ignore */ }
          await sleep(500);
        }
        await sleep(500);
        // Click Continue to navigate to payment page
        sendMessage({ type: "log", level: "info", message: "Clicking Continue to proceed to payment...", iteration: iterationNum });
        try {
          const clicked = await this.page.evaluate(() => {
            const allDivs = Array.from(document.querySelectorAll("div"));
            for (const d of allDivs) {
              const txt = (d.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
              if (txt === "continue" || txt === "continue ") {
                let el: HTMLElement | null = d;
                while (el && el !== document.body) {
                  const style = el.getAttribute("style") || "";
                  if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
                    el.scrollIntoView({ block: "center" });
                    el.click();
                    return true;
                  }
                  el = el.parentElement;
                }
              }
            }
            return false;
          });
          if (clicked) {
            console.log("Continue clicked — waiting for payment page...");
            for (let i = 0; i < 30; i++) {
              await sleep(500);
              const url = this.page.url();
              if (!url.includes("/viewcheckout")) {
                console.log(`Navigated away from viewcheckout: ${url}`);
                break;
              }
            }
          } else {
            sendMessage({ type: "log", level: "warn", message: "Continue button not found — may already be on payment page", iteration: iterationNum });
          }
        } catch (err) {
          sendMessage({ type: "log", level: "warn", message: `Continue click error: ${(err as Error).message}`, iteration: iterationNum });
        }
      }
    }

    // At this point: payment page is shown. DO NOT call proceedToCheckout() — it reloads and destroys the payment page.
    // Step 5: Payment flow with retry
    await this.runPaymentFlow(iterationNum);

    sendMessage({
      type: "log",
      level: "info",
      message: `Iteration ${iterationNum}: Payment submitted, verifying...`,
      iteration: iterationNum,
    });
  }

  private async runPaymentFlow(iterationNum: number): Promise<void> {
    // Pick the card for this iteration (rotate through cards array)
    let paymentDetailsForIteration = this.config.paymentDetails as unknown as Record<string, string>;
    if (this.cards && this.cards.length > 0) {
      const cardIndex = (iterationNum - 1) % this.cards.length;
      const card = this.cards[cardIndex];
      paymentDetailsForIteration = {
        cardNumber: card.cardNumber,
        expiry: card.expiry,
        cvv: card.cvv,
      };
      sendMessage({
        type: "log",
        level: "info",
        message: `Using card ${cardIndex + 1}/${this.cards.length} (ending ${card.cardNumber.slice(-4)})`,
        iteration: iterationNum,
      });
    }

    const maxPaymentRetries = 3;
    for (let payAttempt = 1; payAttempt <= maxPaymentRetries; payAttempt++) {
      try {
        // Step 5: Select payment method
        await this.payment.selectPaymentMethod();

        // Step 6: Fill payment details
        await this.payment.fillDetails(paymentDetailsForIteration);

        // Step 7: Confirm payment
        await this.payment.confirmPayment();

        // Step 7b: For RTGS, wait for manual bank authentication
        if (this.payment instanceof RTGSPayment) {
          const bankAuthDone = await this.payment.waitForBankAuthCompletion();
          if (!bankAuthDone) {
            throw new Error("Bank authentication timed out");
          }
        }

        // Payment flow completed successfully
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (payAttempt < maxPaymentRetries) {
          sendMessage({
            type: "log",
            level: "warn",
            message: `Payment step failed (attempt ${payAttempt}/${maxPaymentRetries}): ${errMsg}. Restarting payment flow...`,
            iteration: iterationNum,
          });
          await sleep(1000);
        } else {
          throw new Error(
            `Payment failed after ${maxPaymentRetries} attempts: ${errMsg}`
          );
        }
      }
    }
  }

  private async waitForPaymentCompletion(): Promise<boolean> {
    const baseTimeout = 120_000; // 2 minutes base
    const maxTimeout = 300_000; // 5 minutes max (extended for OTP/bank pages)
    const absoluteMax = Date.now() + maxTimeout; // Hard ceiling
    let deadline = Date.now() + baseTimeout;
    let lastState = "";

    while (Date.now() < deadline) {
      // Check for order confirmation
      if (await this.platform.isOrderConfirmationVisible()) {
        sendMessage({ type: "log", level: "info", message: "Order confirmed!" });
        return true;
      }

      // Check for payment failure
      if (await this.payment.isPaymentFailed()) {
        sendMessage({ type: "log", level: "error", message: "Payment failed" });
        return false;
      }

      // Check if we're on an intermediate page (OTP, bank redirect, payment gateway)
      // If so, extend the timeout — the user/system is still processing
      const currentState = await this.detectPageState();
      if (currentState !== lastState && currentState !== "unknown") {
        sendMessage({
          type: "log",
          level: "info",
          message: `Payment in progress: ${currentState}`,
        });
        lastState = currentState;
      }

      if (
        currentState === "bank_redirect" ||
        currentState === "otp_page" ||
        currentState === "payment_gateway"
      ) {
        // Extend deadline while payment is actively being processed
        const remaining = deadline - Date.now();
        if (remaining < 60_000) {
          deadline = Math.min(Date.now() + 120_000, absoluteMax);
          sendMessage({
            type: "log",
            level: "info",
            message: "Extended timeout — payment gateway still active",
          });
        }
      }

      await sleep(500);
    }

    sendMessage({
      type: "log",
      level: "warn",
      message: "Payment verification timed out",
    });
    return false;
  }

  /**
   * Detect what state the browser page is in during payment.
   * Returns a hint about whether we're on a bank/OTP/gateway page.
   */
  private async detectPageState(): Promise<string> {
    try {
      return await this.page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        const text = document.body.innerText.toLowerCase();

        // Bank redirect pages
        if (
          url.includes("securepay") ||
          url.includes("secure.") ||
          url.includes("3dsecure") ||
          url.includes("acs.") ||
          url.includes("netbanking") ||
          url.includes("billdesk") ||
          url.includes("payu") ||
          url.includes("razorpay") ||
          url.includes("ccavenue") ||
          url.includes("juspay")
        ) {
          return "bank_redirect";
        }

        // OTP page detection
        if (
          text.includes("enter otp") ||
          text.includes("one time password") ||
          text.includes("enter the otp") ||
          text.includes("verification code") ||
          text.includes("otp sent")
        ) {
          return "otp_page";
        }

        // Payment gateway / processing
        if (
          text.includes("processing your payment") ||
          text.includes("please wait") ||
          text.includes("do not press back") ||
          text.includes("transaction is being processed") ||
          text.includes("authenticating")
        ) {
          return "payment_gateway";
        }

        // Still on payment method selection
        if (
          text.includes("payment method") ||
          text.includes("payment options") ||
          text.includes("select a payment")
        ) {
          return "payment_page";
        }

        return "unknown";
      });
    } catch {
      return "unknown";
    }
  }

  private async takeScreenshot(iteration: number): Promise<void> {
    try {
      const path = `error-screenshots/job-${this.config.jobId}-iter-${iteration}.png`;
      await this.page.screenshot({ path, fullPage: true });
      sendMessage({
        type: "log",
        level: "info",
        message: `Screenshot saved: ${path}`,
        screenshot: path,
        iteration,
      });
    } catch {
      // Screenshot failed, not critical
    }
  }
}
