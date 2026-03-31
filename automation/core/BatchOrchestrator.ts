import { Browser, BrowserContext, Page } from "puppeteer-core";
import { BasePlatform, InstaDdrLoginOptions } from "../platforms/BasePlatform";
import { FlipkartPlatform } from "../platforms/FlipkartPlatform";
import { AmazonPlatform } from "../platforms/AmazonPlatform";
import { BasePayment } from "../payments/BasePayment";
import { CardPayment } from "../payments/CardPayment";
import { GiftCardPayment } from "../payments/GiftCardPayment";
import { RTGSPayment } from "../payments/RTGSPayment";
import { InstaDdrService } from "../services/InstaDdrService";
import { sleep, sendMessage } from "./helpers";
import type { JobConfig, ProductItem, CardDetails } from "../../src/types";

interface InventoryCode {
  codeIndex: number;
  code: string;
  pin: string;
  balance?: number;
}

export class BatchOrchestrator {
  private shouldStopFlag = false;
  private isMultiUrl = false;
  private cards: CardDetails[] | null = null;
  private accounts: string[] | null = null;
  private giftCardInventoryId: string | null = null;
  private inventoryCodes: InventoryCode[] = [];
  private inventoryIndex = 0;
  private inventoryBaseUrl: string;
  private instaDdrService: InstaDdrService | null = null;
  private instaDdrAccounts: Array<{ instaDdrId: string; instaDdrPassword: string; email: string }> | null = null;

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

    // Store gift card inventory for code rotation
    if (config.giftCardInventoryId) {
      this.giftCardInventoryId = config.giftCardInventoryId;
    }

    // Create InstaDDR service with its own isolated browser context
    // to prevent InstaDDR login/logout from affecting Flipkart's session
    if (config.instaDdrAccounts && config.instaDdrAccounts.length > 0) {
      if (!(this.platform instanceof FlipkartPlatform)) {
        throw new Error("InstaDDR OTP automation is only supported for Flipkart");
      }
      this.instaDdrAccounts = config.instaDdrAccounts;

      // Note: isolated context is created lazily in run() — cannot await in constructor

      sendMessage({
        type: "log",
        level: "info",
        message: `InstaDDR configured with ${config.instaDdrAccounts.length} account(s) — emails: ${config.instaDdrAccounts.map(a => a.email.substring(0, 3) + "***").join(", ")}`,
      });
    } else {
      sendMessage({
        type: "log",
        level: "warn",
        message: `No InstaDDR accounts in config (instaDdrAccounts: ${JSON.stringify(config.instaDdrAccounts ?? "undefined")})`,
      });
    }

    // Log configuration summary
    sendMessage({
      type: "log",
      level: "info",
      message: `Login config: accounts=${this.accounts?.length ?? 0}, instaDDR=${this.instaDdrAccounts?.length ?? 0}, needsLogin=${!!(this.accounts || this.instaDdrAccounts)}`,
    });

    // Determine base URL for inventory API calls
    this.inventoryBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      "http://localhost:3000";

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
    let totalIterations = Math.ceil(
      this.config.totalQuantity / this.config.perOrderQuantity
    );

    const isRTGS = this.config.paymentMethod === "rtgs";

    // For RTGS: ALWAYS use the multi-tab flow (new tab after each Place Order click).
    // maxConcurrentTabs controls how many tabs to open per batch.
    // Default: if user didn't set it, use totalIterations (one new tab per iteration).
    let maxConcurrentTabs = this.config.maxConcurrentTabs ?? 1;
    if (isRTGS) {
      if (maxConcurrentTabs <= 1) {
        // User didn't explicitly set tabs — default to totalIterations
        maxConcurrentTabs = totalIterations;
      }
      // Ensure totalIterations >= maxConcurrentTabs
      if (totalIterations < maxConcurrentTabs) {
        totalIterations = maxConcurrentTabs;
      }
    }

    sendMessage({
      type: "log",
      level: "info",
      message: isRTGS
        ? `Starting RTGS flow: ${totalIterations} iterations, ${maxConcurrentTabs} tabs per batch (new tab after each Place Order)`
        : this.isMultiUrl
        ? `Starting multi-URL batch: ${totalIterations} iterations, ${this.config.products.length} products`
        : `Starting batch: ${totalIterations} iterations (${this.config.totalQuantity} total qty, ${this.config.perOrderQuantity} per order)`,
    });

    if (isRTGS) {
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
        // ── Login block: handle account rotation, InstaDDR, or both ──
        // Determine if login is needed and which email/InstaDDR account to use
        const needsLogin = !!(this.accounts || this.instaDdrAccounts);

        if (needsLogin) {
          // Determine the email to use for Flipkart login and the InstaDDR account (if any)
          let loginEmail: string;
          let instaDdrAccount: { instaDdrId: string; instaDdrPassword: string; email: string } | undefined;

          if (this.accounts) {
            // Account rotation mode: use Flipkart account email
            const accountIndex = i % this.accounts.length;
            loginEmail = this.accounts[accountIndex];
            // If InstaDDR is also configured, pair with the corresponding InstaDDR account
            instaDdrAccount = this.instaDdrAccounts?.[accountIndex % this.instaDdrAccounts.length];

            sendMessage({
              type: "log",
              level: "info",
              message: `Account rotation: using account ${accountIndex + 1}/${this.accounts.length}` +
                (instaDdrAccount ? ` with InstaDDR` : ` (manual OTP)`),
              iteration: i + 1,
            });
          } else {
            // InstaDDR-only mode: use InstaDDR email as the Flipkart login email
            const accountIndex = i % this.instaDdrAccounts!.length;
            instaDdrAccount = this.instaDdrAccounts![accountIndex];
            loginEmail = instaDdrAccount.email;

            sendMessage({
              type: "log",
              level: "info",
              message: `InstaDDR-only mode: using InstaDDR account ${accountIndex + 1}/${this.instaDdrAccounts!.length}`,
              iteration: i + 1,
            });
          }

          // Lazily create InstaDDR service with isolated browser context
          if (instaDdrAccount && !this.instaDdrService) {
            sendMessage({ type: "log", level: "info", message: "Creating isolated InstaDDR browser context..." });
            const browser = this.page.browser() as Browser;
            const instaDdrContext = await browser.createBrowserContext();
            const instaDdrPage = await instaDdrContext.newPage();
            this.instaDdrService = new InstaDdrService(instaDdrPage, "https://m.kuku.lu", instaDdrContext);
          }

          // Build InstaDDR options
          const instaOptions: InstaDdrLoginOptions | undefined =
            this.instaDdrService && instaDdrAccount
              ? { instaDdrService: this.instaDdrService, instaDdrAccount }
              : undefined;

          sendMessage({
            type: "log",
            level: "info",
            message: `Logging in to Flipkart with email: ${loginEmail.substring(0, 3)}***` +
              (instaOptions ? ` (InstaDDR will auto-fetch OTP)` : ` (manual OTP)`),
            iteration: i + 1,
          });

          // loginWithEmail handles:
          // 1. Logout from Flipkart if already logged in
          // 2. Navigate to Flipkart login page
          // 3. Enter email
          // 4. Click "Request OTP"
          // 5. If InstaDDR: login to InstaDDR → fetch OTP → enter OTP → wait for login completion
          // 6. If no InstaDDR: return (we wait for manual OTP below)
          await this.platform.loginWithEmail(loginEmail, instaOptions);

          if (instaOptions) {
            // InstaDDR handled everything — login is complete
            sendMessage({
              type: "log",
              level: "info",
              message: `InstaDDR auto-login complete`,
              iteration: i + 1,
            });
          } else {
            // No InstaDDR — wait for manual OTP entry
            const maskedEmail = `${loginEmail[0]}${"*".repeat(Math.max(loginEmail.indexOf("@") - 2, 1))}${loginEmail.substring(loginEmail.indexOf("@") - 1)}`;
            sendMessage({
              type: "waiting_for_otp",
              email: maskedEmail,
              iteration: i + 1,
            } as any);
            const loginSuccess = await this.platform.waitForLoginCompletion(300000);
            if (!loginSuccess) {
              throw new Error(`Login timed out for ${maskedEmail}`);
            }
            sendMessage({
              type: "log",
              level: "info",
              message: `Manual login successful`,
              iteration: i + 1,
            });
          }
        } else {
          sendMessage({
            type: "log",
            level: "info",
            message: `No account rotation or InstaDDR configured — using existing browser session`,
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
    if (this.accounts || this.instaDdrAccounts) {
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

    // Close the isolated InstaDDR browser context
    if (this.instaDdrService) {
      await this.instaDdrService.close();
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

      // ── Login block for RTGS batch (once per batch — all tabs share the same session) ──
      const needsLoginRTGS = !!(this.accounts || this.instaDdrAccounts);
      if (needsLoginRTGS) {
        const batchIndex = Math.floor(batchStart / maxConcurrentTabs);
        let loginEmail: string;
        let instaDdrAccount: { instaDdrId: string; instaDdrPassword: string; email: string } | undefined;

        if (this.accounts) {
          const accountIndex = batchIndex % this.accounts.length;
          loginEmail = this.accounts[accountIndex];
          instaDdrAccount = this.instaDdrAccounts?.[accountIndex % this.instaDdrAccounts.length];
        } else {
          const accountIndex = batchIndex % this.instaDdrAccounts!.length;
          instaDdrAccount = this.instaDdrAccounts![accountIndex];
          loginEmail = instaDdrAccount.email;
        }

        // Lazily create InstaDDR service
        if (instaDdrAccount && !this.instaDdrService) {
          const browser = this.page.browser() as Browser;
          const instaDdrContext = await browser.createBrowserContext();
          const instaDdrPage = await instaDdrContext.newPage();
          this.instaDdrService = new InstaDdrService(instaDdrPage, "https://m.kuku.lu", instaDdrContext);
        }

        const instaOptions = this.instaDdrService && instaDdrAccount
          ? { instaDdrService: this.instaDdrService, instaDdrAccount }
          : undefined;

        sendMessage({
          type: "log",
          level: "info",
          message: `RTGS batch login: ${loginEmail.substring(0, 3)}***` +
            (instaOptions ? ` (InstaDDR auto-OTP)` : ` (manual OTP)`),
        });

        await this.platform.loginWithEmail(loginEmail, instaOptions);

        if (instaOptions) {
          sendMessage({ type: "log", level: "info", message: `InstaDDR auto-login complete for RTGS batch` });
        } else {
          const maskedEmail = `${loginEmail[0]}${"*".repeat(Math.max(loginEmail.indexOf("@") - 2, 1))}${loginEmail.substring(loginEmail.indexOf("@") - 1)}`;
          sendMessage({
            type: "waiting_for_otp",
            email: maskedEmail,
            iteration: batchStart + 1,
          } as any);
          const loginSuccess = await this.platform.waitForLoginCompletion(300000);
          if (!loginSuccess) {
            throw new Error(`Login timed out for RTGS batch`);
          }
          sendMessage({ type: "log", level: "info", message: "RTGS batch login successful" });
        }
      }

      // ── Run RTGS flow sequentially: one tab at a time ──
      // Flow: run full purchase on current tab → click Place Order → wait 2s → open NEW tab → repeat
      // All previous tabs stay open so user can complete bank auth in each one.
      const tabPages: Page[] = [];
      const MAX_RTGS_RETRIES = 3;
      const RETRYABLE_PATTERNS = [
        "RTGS button not found",
        "Place Order button not found",
        "Place Order not found",
        "Failed to click Place Order",
      ];

      for (let tabIndex = 0; tabIndex < batchSize; tabIndex++) {
        if (this.shouldStopFlag) break;

        const iterNum = batchStart + tabIndex + 1;

        sendMessage({
          type: "log",
          level: "info",
          message: `--- Tab ${tabIndex + 1}/${batchSize}: Iteration ${iterNum}/${totalIterations} ---`,
          iteration: iterNum,
        });

        // ── Retry loop: each tab gets up to MAX_RTGS_RETRIES attempts ──
        let tabSuccess = false;
        let tabPage: Page | null = null;
        let retryCount = 0;

        for (let attempt = 0; attempt < MAX_RTGS_RETRIES && !tabSuccess; attempt++) {
          retryCount = attempt;

          // Close previous attempt's tab (if any) before retrying with a fresh one
          if (tabPage !== null && tabIndex > 0) {
            try { await tabPage.close(); } catch { /* ignore */ }
            tabPage = null;
          }

          // For the first tab in a batch, always use the main page.
          // For subsequent tabs, open a NEW tab (previous tab stays on poll page).
          const isFirstAttempt = attempt === 0;
          if (tabIndex === 0) {
            // Always use main page for tab 0
            if (tabPage === null) {
              tabPage = this.page;
              tabPages.push(tabPage);
            }
          } else if (tabPage === null) {
            // Open a new tab for retry or for subsequent tab
            sendMessage({
              type: "log",
              level: "info",
              message: `Opening new tab for iteration ${iterNum}${attempt > 0 ? ` (retry ${attempt + 1}/${MAX_RTGS_RETRIES})` : ""}...`,
            });
            tabPage = await browser.newPage();
            tabPages.push(tabPage);
          }

          try {
            const productUrl = this.getProductUrlForIteration(iterNum);

            // Create fresh platform + payment instances for this attempt
            const tabPlatform =
              this.platform instanceof FlipkartPlatform
                ? new FlipkartPlatform(tabPage, productUrl)
                : new AmazonPlatform(tabPage, productUrl);
            const tabPayment = this.createPaymentForTab(tabPage);

            sendMessage({
              type: "log",
              level: "info",
              message: `Tab ${tabIndex + 1}: running full RTGS flow for product: ${productUrl}${attempt > 0 ? ` [attempt ${attempt + 1}]` : ""}`,
            });

            // Run the FULL purchase flow on this tab:
            // navigate → addToCart → setQuantity → goToCart → placeOrder → verifyAddress → selectPayment
            await this.runRTGSTabIteration(tabPage, tabPlatform, tabPayment, iterNum);

            // Click "Place Order" — this navigates to /payments/rtgs/poll
            const rtgsTab = tabPayment as unknown as RTGSPayment;
            const pollReached = await rtgsTab.confirmPayment();

            if (pollReached) {
              sendMessage({
                type: "log",
                level: "info",
                message: `Tab ${tabIndex + 1}: ✅ Place Order clicked — RTGS poll page reached${attempt > 0 ? ` (succeeded on retry ${attempt + 1})` : ""}`,
                iteration: iterNum,
              });
              tabSuccess = true;
            } else {
              sendMessage({
                type: "log",
                level: "warn",
                message: `Tab ${tabIndex + 1}: ⚠ Place Order clicked but poll page not yet detected${attempt > 0 ? ` (succeeded on retry ${attempt + 1})` : ""}`,
                iteration: iterNum,
              });
              // Even without explicit poll detection, consider it a success
              // The bank auth might take a moment — polling phase will handle it
              tabSuccess = true;
            }

            tabResults[batchStart + tabIndex] = "success-pending";
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isRetryable = RETRYABLE_PATTERNS.some((p) => errMsg.includes(p));

            if (isRetryable && attempt < MAX_RTGS_RETRIES - 1) {
              sendMessage({
                type: "log",
                level: "warn",
                message: `Tab ${tabIndex + 1}: ⚠ ${errMsg} — retrying in 5s (${attempt + 1}/${MAX_RTGS_RETRIES})`,
                iteration: iterNum,
              });
              await sleep(5000);
              // tabPage stays null → loop opens a fresh tab
              tabPage = null;
              continue;
            }

            // All retries exhausted or non-retryable error
            tabResults[batchStart + tabIndex] = "failed";
            sendMessage({
              type: "log",
              level: "error",
              message: `Tab ${tabIndex + 1} failed after ${attempt + 1} attempt(s): ${errMsg}`,
              iteration: iterNum,
            });
            sendMessage({
              type: "progress",
              iteration: iterNum,
              total: totalIterations,
              status: "failed",
            });

            // Close the failed tab (keep main page open for tab 0)
            if (tabPage !== null && tabIndex > 0) {
              try { await tabPage.close(); } catch { /* ignore */ }
              tabPage = null;
            }
            tabSuccess = true; // exit retry loop
          }
        }

        // Wait 2 seconds before opening the next tab
        if (tabIndex < batchSize - 1) {
          sendMessage({
            type: "log",
            level: "info",
            message: `Waiting 2 seconds before opening next tab...`,
          });
          await sleep(2000);
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
    if (this.accounts || this.instaDdrAccounts) {
      try {
        await this.platform.logout();
      } catch { /* ignore */ }
    }

    // Close the isolated InstaDDR browser context
    if (this.instaDdrService) {
      await this.instaDdrService.close();
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

    // Place order from cart — triggers navigation to order summary / checkout
    await tabPlatform.placeOrder();

    // Wait for the page to stabilize after the navigation
    try {
      await tabPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    } catch { /* already navigated */ }
    await sleep(500);

    // Verify order summary (address + GST) — only if page is on a verifiable URL
    if (this.config.address && tabPlatform instanceof FlipkartPlatform) {
      try {
        const currentUrl = tabPage.url();
        // Only attempt verification if we're on order summary or checkout page
        if (currentUrl.includes("/vieworder") || currentUrl.includes("/checkout") || currentUrl.includes("/viewcheckout") || currentUrl.includes("flipkart.com")) {
          await tabPlatform.verifyAddressOnOrderSummary(this.config.address, qty);
        } else {
          sendMessage({
            type: "log",
            level: "info",
            message: `Skipping order summary verification — page already at: ${currentUrl}`,
            iteration: iterationNum,
          });
        }
      } catch (err) {
        const warnMsg = err instanceof Error ? err.message : String(err);
        // Don't warn for expected navigation errors — these are normal on fast pages
        if (warnMsg.includes("context") || warnMsg.includes("destroyed") || warnMsg.includes("navigation")) {
          sendMessage({
            type: "log",
            level: "info",
            message: `Order summary verification skipped — page navigated away (this is normal)`,
            iteration: iterationNum,
          });
        } else {
          sendMessage({
            type: "log",
            level: "warn",
            message: `Order summary verification issue (continuing): ${warnMsg}`,
            iteration: iterationNum,
          });
        }
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
      // Still need to click Continue on order summary to get to payment page
      if (this.platform instanceof FlipkartPlatform) {
        for (let i = 0; i < 20; i++) {
          try {
            const bodyLen = await this.page.evaluate(() => document.body.innerText.length);
            if (bodyLen > 100) break;
          } catch { /* ignore */ }
          await sleep(500);
        }
        await sleep(500);
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
            console.log("Continue clicked on multi-URL order summary");
            for (let i = 0; i < 30; i++) {
              await sleep(500);
              const url = this.page.url();
              if (!url.includes("/viewcheckout")) break;
            }
          }
        } catch { /* ignore navigation errors */ }
      }
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

    // Gift card inventory code rotation
    let currentCode: InventoryCode | null = null;
    if (this.giftCardInventoryId && this.payment instanceof GiftCardPayment) {
      try {
        currentCode = await this.fetchNextInventoryCode();
        if (currentCode) {
          const masked = currentCode.code.length > 8
            ? currentCode.code.slice(0, 4) + "****" + currentCode.code.slice(-4)
            : currentCode.code.slice(0, 2) + "****" + currentCode.code.slice(-2);
          paymentDetailsForIteration = {
            code: currentCode.code,
            pin: currentCode.pin || "",
          };
          sendMessage({
            type: "log",
            level: "info",
            message: `Using inventory code ${masked} (${this.inventoryIndex}/${this.inventoryCodes.length} pre-fetched)`,
            iteration: iterationNum,
          });
        } else {
          sendMessage({
            type: "log",
            level: "error",
            message: "No available codes in gift card inventory",
            iteration: iterationNum,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendMessage({
          type: "log",
          level: "warn",
          message: `Could not fetch inventory code: ${msg}`,
          iteration: iterationNum,
        });
      }
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
        if (currentCode) {
          await this.updateInventoryCodeStatus(currentCode, "used");
        }
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
          // Mark inventory code as failed before throwing
          if (currentCode) {
            await this.updateInventoryCodeStatus(currentCode, "failed", errMsg);
          }
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

  /**
   * Fetch the next available code from the gift card inventory.
   * Uses a local cache to avoid excessive API calls — pre-fetches up to 5 codes.
   */
  private async fetchNextInventoryCode(): Promise<InventoryCode | null> {
    if (!this.giftCardInventoryId) return null;

    // Refill cache if running low (keep at least 2 ahead)
    if (this.inventoryIndex >= this.inventoryCodes.length - 2) {
      await this.refillInventoryCache();
    }

    if (this.inventoryIndex < this.inventoryCodes.length) {
      return this.inventoryCodes[this.inventoryIndex++];
    }
    return null;
  }

  private async refillInventoryCache(): Promise<void> {
    if (!this.giftCardInventoryId) return;

    try {
      const url = `${this.inventoryBaseUrl}/api/giftcards/inventory/${this.giftCardInventoryId}/next`;
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        console.log(`[Inventory] No more codes available (status ${res.status})`);
        return;
      }

      const data = await res.json();
      this.inventoryCodes.push({
        codeIndex: data.codeIndex,
        code: data.code,
        pin: data.pin || "",
        balance: data.balance,
      });
      console.log(`[Inventory] Cached code (total: ${this.inventoryCodes.length})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Inventory] Failed to fetch next code: ${msg}`);
    }
  }

  private async updateInventoryCodeStatus(
    code: InventoryCode,
    status: "used" | "failed",
    errorMsg?: string
  ): Promise<void> {
    if (!this.giftCardInventoryId) return;

    try {
      const url = `${this.inventoryBaseUrl}/api/giftcards/inventory/${this.giftCardInventoryId}/codes/${code.codeIndex}/status`;
      await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          ...(errorMsg ? { errorMessage: errorMsg } : {}),
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Inventory] Failed to update code status: ${msg}`);
    }
  }
}
