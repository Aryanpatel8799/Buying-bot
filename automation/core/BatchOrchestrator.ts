import { Browser, BrowserContext, Page } from "puppeteer-core";
import { BasePlatform, InstaDdrLoginOptions } from "../platforms/BasePlatform";
import { FlipkartPlatform } from "../platforms/FlipkartPlatform";
import { AmazonPlatform } from "../platforms/AmazonPlatform";
import { BasePayment } from "../payments/BasePayment";
import { CardPayment } from "../payments/CardPayment";
import { GiftCardPayment } from "../payments/GiftCardPayment";
import { RTGSPayment } from "../payments/RTGSPayment";
import { InstaDdrService } from "../services/InstaDdrService";
import { GmailOtpService } from "../services/GmailOtpService";
import type { InstaDdrServiceLike } from "../platforms/BasePlatform";
import { sleep, sendMessage } from "./helpers";
import { CardDeclinedError } from "./errors";
import type { JobConfig, ProductItem, CardDetails } from "../../src/types";
import type { OrderDetails } from "../platforms/BasePlatform";
import * as fs from "fs";
import * as path from "path";

// Where appendOrderToCsv writes per-day CSV files. Mirrors src/lib/orderReports
// — kept inline because the runner is spawned by tsx and avoids src/ imports.
function getOrderReportsDir(): string {
  return process.env.ORDER_REPORTS_DIR || path.join(process.cwd(), "order-reports");
}

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
  private amazonAccounts: { email: string; password: string }[] | null = null;
  private giftCardInventoryId: string | null = null;
  private inventoryCodes: InventoryCode[] = [];
  private inventoryIndex = 0;
  private inventoryBaseUrl: string;
  private otpService: InstaDdrServiceLike | null = null;
  private otpServiceCleanup: (() => Promise<void>) | null = null;
  private instaDdrAccounts: Array<{ instaDdrId: string; instaDdrPassword: string; email: string }> | null = null;
  // Last visible "Total" / "Amount Paid" we've seen on a Flipkart page during
  // the current iteration. Used as the fallback amount when an iteration is
  // declined/failed and we never reach the order-confirmation page.
  private lastSeenAmount = "";

  constructor(
    private page: Page,
    private platform: BasePlatform,
    private payment: BasePayment,
    private config: JobConfig
  ) {
    // Determine if this job should use cart flow:
    // - Multiple product URLs (any platform), OR
    // - Amazon with quantity > 1 for any product
    const hasMultipleUrls = config.products && config.products.length > 1;
    const isAmazon = platform instanceof AmazonPlatform;
    const amazonMultiQty = isAmazon && (
      config.products?.some(p => p.quantity > 1) ||
      config.perOrderQuantity > 1
    );
    this.isMultiUrl = !!(hasMultipleUrls || amazonMultiQty);

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

    // Store Amazon accounts (email + password) for rotation
    if (config.amazonAccounts && config.amazonAccounts.length > 0) {
      this.amazonAccounts = config.amazonAccounts;
      if (!(this.platform instanceof AmazonPlatform)) {
        throw new Error("Amazon account rotation is only supported for Amazon");
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

  /**
   * Lazily build the OTP service used during Flipkart login.
   *
   * - If the Chrome profile has a linked Gmail (config.gmailAddress), open a
   *   new page in the MAIN browser context (cookies carry over, so Gmail is
   *   already signed in) and use GmailOtpService.
   * - Otherwise fall back to InstaDdrService inside an isolated context,
   *   which logs into m.kuku.lu and scrapes the inbox there.
   */
  private async ensureOtpService(): Promise<void> {
    if (this.otpService) return;
    const browser = this.page.browser() as Browser;

    if (this.config.gmailAddress) {
      // Pick the correct Gmail sender filter for this job's platform.
      const sender = this.platform instanceof AmazonPlatform ? "amazon" : "flipkart";
      sendMessage({ type: "log", level: "info", message: `Opening Gmail tab for OTP (${this.config.gmailAddress}, sender=${sender})` });
      const gmailPage = await browser.newPage();
      const svc = new GmailOtpService(gmailPage, sender);
      // Warm up in the background so Gmail is ready by the time the
      // platform asks for the OTP. Errors surface later in fetchOtp.
      svc.init().catch((err) => {
        sendMessage({ type: "log", level: "warn", message: `[Gmail] warm-up issue: ${(err as Error).message}` });
      });
      this.otpService = svc;
      this.otpServiceCleanup = async () => { /* page is closed by GmailOtpService.close() */ };
      return;
    }

    sendMessage({ type: "log", level: "info", message: "Creating isolated InstaDDR browser context..." });
    const instaDdrContext = await browser.createBrowserContext();
    const instaDdrPage = await instaDdrContext.newPage();
    this.otpService = new InstaDdrService(instaDdrPage, "https://m.kuku.lu", instaDdrContext);
    // InstaDdrService.close() also closes the context, so no extra cleanup needed.
    this.otpServiceCleanup = null;
  }

  async run(): Promise<{ completed: number; failed: number }> {
    let totalIterations = Math.ceil(
      this.config.totalQuantity / this.config.perOrderQuantity
    );

    sendMessage({
      type: "log",
      level: "info",
      message: this.isMultiUrl
        ? `Starting multi-URL batch: ${totalIterations} iterations, ${this.config.products.length} products`
        : `Starting batch: ${totalIterations} iterations (${this.config.totalQuantity} total qty, ${this.config.perOrderQuantity} per order)`,
    });

    // Always logout from any previous session at the start of a new job
    // to ensure a clean state, regardless of payment method or login mode.
    if (this.platform instanceof FlipkartPlatform) {
      try {
        sendMessage({ type: "log", level: "info", message: "Logging out previous Flipkart session (if any)..." });
        await this.platform.logout();
        sendMessage({ type: "log", level: "info", message: "Previous session cleared" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendMessage({ type: "log", level: "warn", message: `Logout at job start failed (continuing): ${msg}` });
      }
    } else if (this.platform instanceof AmazonPlatform && this.amazonAccounts) {
      // Only run for Amazon jobs that are using auto-login. If no
      // amazonAccounts were selected, we don't want to disturb the
      // user's manual session.
      try {
        sendMessage({ type: "log", level: "info", message: "Logging out previous Amazon session (if any)..." });
        await this.platform.logout();
        sendMessage({ type: "log", level: "info", message: "Previous Amazon session cleared" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendMessage({ type: "log", level: "warn", message: `Amazon logout at job start failed (continuing): ${msg}` });
      }
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

      // Reset per-iteration captured state (price seen on cart/checkout) so
      // a successful Iter N's price doesn't leak into Iter N+1's failed row.
      this.lastSeenAmount = "";

      sendMessage({
        type: "log",
        level: "info",
        message: `--- Iteration ${i + 1}/${totalIterations} ---`,
        iteration: i + 1,
      });

      try {
        // ── Amazon login (separate from Flipkart's email-only flow) ──
        if (this.amazonAccounts && this.platform instanceof AmazonPlatform) {
          const idx = i % this.amazonAccounts.length;
          const { email, password } = this.amazonAccounts[idx];
          if (!this.otpService) {
            await this.ensureOtpService();
          }
          const instaOptions = this.otpService
            ? { instaDdrService: this.otpService, instaDdrAccount: { instaDdrId: "", instaDdrPassword: "", email } }
            : undefined;
          sendMessage({
            type: "log",
            level: "info",
            message: `Amazon login: account ${idx + 1}/${this.amazonAccounts.length} (${email.substring(0, 4)}***)` +
              (instaOptions ? " — Gmail will auto-fetch OTP if asked" : " — manual OTP if asked"),
            iteration: i + 1,
          });
          await this.platform.loginWithEmailPassword(email, password, instaOptions);
          sendMessage({
            type: "log",
            level: "info",
            message: "Amazon login complete",
            iteration: i + 1,
          });
        }

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

          // Lazily create the OTP service (Gmail if the profile has one linked,
          // otherwise fall back to the InstaDDR isolated-context scraper).
          if (instaDdrAccount && !this.otpService) {
            await this.ensureOtpService();
          }

          // Build OTP options (interface shape is unchanged; service can be
          // either GmailOtpService or InstaDdrService — both implement the same
          // InstaDdrServiceLike contract).
          const instaOptions: InstaDdrLoginOptions | undefined =
            this.otpService && instaDdrAccount
              ? { instaDdrService: this.otpService, instaDdrAccount }
              : undefined;

          const otpSource = this.config.gmailAddress ? "Gmail" : "InstaDDR";
          sendMessage({
            type: "log",
            level: "info",
            message: `Logging in to Flipkart with email: ${loginEmail.substring(0, 3)}***` +
              (instaOptions ? ` (${otpSource} will auto-fetch OTP)` : ` (manual OTP)`),
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

        // ── Pre-flight: per-account mobile + saved-address verification ──
        // After login, scrape THIS account's registered mobile from
        // /account and ensure /account/addresses contains the job's
        // selected address with that exact number. This guarantees each
        // account ships with its own mobile rather than the static one
        // baked into job config.
        if (
          this.platform instanceof FlipkartPlatform &&
          this.config.address &&
          needsLogin
        ) {
          try {
            const mobile = await this.platform.fetchAccountMobile();
            if (mobile) {
              // Override the mobile we'll feed into downstream verification
              // so the checkout-page address match keys on the right number.
              const normalised = mobile.replace(/\D/g, "").slice(-10);
              if (normalised) {
                this.config.address.mobile = normalised;
              }
              await this.platform.ensureAddressForAccount(this.config.address, mobile);
              sendMessage({
                type: "log",
                level: "info",
                message: `Pre-flight done: account mobile ending ${normalised.slice(-4)} ensured on saved address`,
                iteration: i + 1,
              });
            } else {
              sendMessage({
                type: "log",
                level: "warn",
                message: "Pre-flight: could not read mobile from /account — falling back to job config mobile",
                iteration: i + 1,
              });
            }
          } catch (err) {
            sendMessage({
              type: "log",
              level: "warn",
              message: `Pre-flight skipped: ${err instanceof Error ? err.message : err}`,
              iteration: i + 1,
            });
          }
        }

        if (this.isMultiUrl) {
          await this.runMultiUrlIteration(i + 1);
        } else {
          await this.runSingleIteration(i + 1);
        }

        // Wait for payment to complete
        const paymentResult = await this.waitForPaymentCompletion();

        if (!paymentResult.ok && paymentResult.declineReason) {
          // Card was declined (Flipkart side OR bank/PSP side). Throw a typed
          // error so the iteration's catch can log "Card ending XXXX declined"
          // and the next iteration's loginWithEmail naturally logs out the
          // current account and signs in the next one.
          const cardLast4 =
            this.cards && this.cards.length > 0
              ? this.cards[i % this.cards.length].cardNumber.slice(-4)
              : "????";
          throw new CardDeclinedError(cardLast4, paymentResult.declineReason);
        }

        const totalQty = this.config.products?.reduce((sum, p) => sum + p.quantity, 0) ?? this.config.perOrderQuantity;
        const pinCode = this.config.address?.checkoutPincode || this.config.address?.pincode || "";
        const gstName = this.config.address?.companyName || "";

        if (paymentResult.ok) {
          completed++;
          let extracted: OrderDetails | undefined;
          try {
            extracted = await this.platform.extractOrderDetails();
          } catch (csvErr) {
            console.log(`extractOrderDetails warning: ${csvErr instanceof Error ? csvErr.message : csvErr}`);
          }
          // Always synthesize so URL fallbacks fill any blanks left by the
          // confirmation-page extractor.
          const order = this.synthesizeOrderDetails({
            qty: totalQty,
            pinCode,
            extracted,
          });

          try {
            this.appendOrderRow({
              iteration: i + 1,
              status: "completed",
              accountEmail: this.emailForIteration(i),
              gstName,
              pinCode,
              qty: totalQty,
              order,
            });
          } catch (csvErr) {
            console.log(`CSV export warning: ${csvErr instanceof Error ? csvErr.message : csvErr}`);
          }

          sendMessage({
            type: "progress",
            iteration: i + 1,
            total: totalIterations,
            status: "success",
          });
        } else {
          failed++;
          // Generic timeout (no specific decline phrase). Log a row with
          // status=failed so the per-job CSV still has a complete record.
          // Synthesize from URL + lastSeenAmount so model/colour/amount/per-pc
          // are populated even though we never reached the confirmation page.
          const order = this.synthesizeOrderDetails({
            qty: totalQty,
            pinCode,
          });
          try {
            this.appendOrderRow({
              iteration: i + 1,
              status: "failed",
              accountEmail: this.emailForIteration(i),
              gstName,
              pinCode,
              qty: totalQty,
              note: "payment verification timed out",
              order,
            });
          } catch (csvErr) {
            console.log(`CSV export warning: ${csvErr instanceof Error ? csvErr.message : csvErr}`);
          }
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
        // Always record the iteration in the CSV with the right status.
        const totalQtyForRow = this.config.products?.reduce((sum, p) => sum + p.quantity, 0) ?? this.config.perOrderQuantity;
        const pinCodeForRow = this.config.address?.checkoutPincode || this.config.address?.pincode || "";
        const gstNameForRow = this.config.address?.companyName || "";
        // Synthesize model/colour/amount from URL + lastSeenAmount so the row
        // is fully populated even on declined/failed iterations that never
        // reached the order-confirmation page.
        const orderForRow = this.synthesizeOrderDetails({
          qty: totalQtyForRow,
          pinCode: pinCodeForRow,
        });
        try {
          this.appendOrderRow({
            iteration: i + 1,
            status: err instanceof CardDeclinedError ? "declined" : "failed",
            accountEmail: this.emailForIteration(i),
            gstName: gstNameForRow,
            pinCode: pinCodeForRow,
            qty: totalQtyForRow,
            note: err instanceof CardDeclinedError
              ? `card ending ${err.cardLast4}: ${err.reason}`
              : (err instanceof Error ? err.message : String(err)).slice(0, 300),
            order: orderForRow,
          });
        } catch (csvErr) {
          console.log(`CSV export warning: ${csvErr instanceof Error ? csvErr.message : csvErr}`);
        }

        if (err instanceof CardDeclinedError) {
          sendMessage({
            type: "log",
            level: "error",
            message: `Card ending ${err.cardLast4} declined: ${err.reason}`,
            iteration: i + 1,
          });
          // Card decline leaves the browser stranded on a bank/3DS page with
          // the Flipkart session still alive. The next iteration's
          // loginWithEmail() can't find Request OTP because Flipkart auto-
          // signs the user back in. Force-recover: go to flipkart.com home,
          // then explicit logout. Best effort — never let this throw.
          if (this.platform instanceof FlipkartPlatform) {
            try {
              sendMessage({
                type: "log",
                level: "info",
                message: "Recovering: navigating to Flipkart home and logging out…",
                iteration: i + 1,
              });
              await this.page.goto("https://www.flipkart.com/", {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });
              await sleep(800);
              await this.platform.logout();
            } catch (recoverErr) {
              const msg = recoverErr instanceof Error ? recoverErr.message : String(recoverErr);
              sendMessage({
                type: "log",
                level: "warn",
                message: `Post-decline recovery failed (continuing): ${msg}`,
                iteration: i + 1,
              });
            }
          }
          sendMessage({
            type: "log",
            level: "info",
            message: `Skipping iteration ${i + 1} — moving to next account`,
            iteration: i + 1,
          });
        } else {
          const errorMsg = err instanceof Error ? err.message : String(err);
          sendMessage({
            type: "log",
            level: "error",
            message: `Iteration ${i + 1} failed: ${errorMsg}`,
            iteration: i + 1,
          });
        }
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

    // Intentionally NO tab cleanup: the user wants every tab (Flipkart,
    // Gmail, any payment popup) to stay open throughout the whole process,
    // so they can watch the OTP arrive, inspect failures, or continue
    // manually. We also skip the post-run logout — it navigates the Flipkart
    // tab away from the result page. Orphan Chrome instances are reclaimed
    // by BrowserManager.launch() at the start of the next job.
    sendMessage({
      type: "log",
      level: "info",
      message: "Leaving all tabs open (Flipkart + Gmail + any popups). Close the Chrome window when you're done.",
    });

    sendMessage({
      type: "done",
      completed,
      failed,
    });

    return { completed, failed };
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

        // Lazily create OTP service (Gmail or InstaDDR fallback)
        if (instaDdrAccount && !this.otpService) {
          await this.ensureOtpService();
        }

        const instaOptions = this.otpService && instaDdrAccount
          ? { instaDdrService: this.otpService, instaDdrAccount }
          : undefined;

        const otpSource = this.config.gmailAddress ? "Gmail" : "InstaDDR";
        sendMessage({
          type: "log",
          level: "info",
          message: `RTGS batch login: ${loginEmail.substring(0, 3)}***` +
            (instaOptions ? ` (${otpSource} auto-OTP)` : ` (manual OTP)`),
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
            // Use first product URL as initial platform URL — addAllProductsAndCheckout
            // handles per-product URL switching via setProductUrl for multi-URL
            const initialUrl = this.config.products?.[0]?.url ?? this.config.productUrl;

            // Create fresh platform + payment instances for this attempt
            const tabPlatform =
              this.platform instanceof FlipkartPlatform
                ? new FlipkartPlatform(tabPage, initialUrl)
                : new AmazonPlatform(tabPage, initialUrl);
            const tabPayment = this.createPaymentForTab(tabPage);

            sendMessage({
              type: "log",
              level: "info",
              message: `Tab ${tabIndex + 1}: running full RTGS flow (${this.config.products?.length ?? 1} product(s))${attempt > 0 ? ` [attempt ${attempt + 1}]` : ""}`,
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

    // Intentionally no OTP-service close — Gmail tab stays open across runs.

    const completed = tabResults.filter((r) => r === "success").length;
    const failed = tabResults.filter((r) => r === "failed").length;
    sendMessage({ type: "done", completed, failed });
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
   * Shared cart flow used by BOTH Card and RTGS multi-URL iterations.
   * Adds all products to cart → goes to cart → sets quantities → places order →
   * waits for navigation → verifies address/GST → clicks Continue to reach payment page.
   *
   * After this method returns, the page is on the payment page ready for payment selection.
   */
  private async addAllProductsAndCheckout(
    page: Page,
    platform: BasePlatform,
    iterationNum: number
  ): Promise<void> {
    const products = this.config.products;

    // Step 1: For each product — navigate, add to cart
    for (let p = 0; p < products.length; p++) {
      const product = products[p];
      sendMessage({
        type: "log",
        level: "info",
        message: `Adding product ${p + 1}/${products.length} to cart...`,
        iteration: iterationNum,
      });

      // Set the current product URL on the platform
      platform.setProductUrl(product.url);

      // Navigate to this product
      await platform.navigateToProduct();

      // Add to cart (quantity will be set on the cart page for all platforms)
      await platform.addToCart();

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
    await platform.goToCart();

    // Step 3: Set quantity for each product in the cart page
    for (let p = 0; p < products.length; p++) {
      const product = products[p];
      if (product.quantity > 1) {
        sendMessage({
          type: "log",
          level: "info",
          message: `Setting quantity for item ${p + 1} to ${product.quantity}...`,
          iteration: iterationNum,
        });
        await platform.setCartItemQuantity(p, product.quantity);
      }
    }

    // Step 4: Place order / proceed to checkout from cart
    await platform.placeOrder();

    // Wait for navigation to order summary / checkout page after Place Order
    // Place Order triggers a page navigation — must wait for it to complete
    // before attempting any DOM operations
    if (platform instanceof FlipkartPlatform) {
      sendMessage({ type: "log", level: "info", message: "Waiting for order summary page after Place Order...", iteration: iterationNum });
      try {
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      } catch { /* already navigated */ }
      await sleep(1000);

      // Wait for page body to be ready
      for (let i = 0; i < 20; i++) {
        try {
          const ready = await page.evaluate(() =>
            document.body !== null && (document.body?.innerText || "").length > 100
          );
          if (ready) break;
        } catch { /* context still loading */ }
        await sleep(500);
      }
      await sleep(500);
    }

    // Step 5: Verify order summary page (Flipkart only) — handles address, GST, then Continue to checkout.
    // verifyAddressOnOrderSummary() clicks Continue which navigates to the payment page.
    // DO NOT call proceedToCheckout() here — it would reload /viewcheckout and destroy the payment page.
    if (this.config.address && platform instanceof FlipkartPlatform) {
      try {
        const totalQty = this.config.products?.reduce((sum, p) => sum + p.quantity, 0) ?? this.config.perOrderQuantity;
        await platform.verifyAddressOnOrderSummary(this.config.address, totalQty);
        // Capture the visible total so failed/declined rows still get an
        // amount in the CSV. Best effort — don't fail the iteration.
        const seen = await platform.captureCheckoutTotal();
        if (seen) this.lastSeenAmount = seen;
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
      if (platform instanceof FlipkartPlatform) {
        for (let i = 0; i < 20; i++) {
          try {
            const bodyLen = await page.evaluate(() => document.body.innerText.length);
            if (bodyLen > 100) break;
          } catch { /* ignore */ }
          await sleep(500);
        }
        await sleep(500);
        try {
          const clicked = await page.evaluate(() => {
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
            console.log("Continue clicked on order summary");
            for (let i = 0; i < 30; i++) {
              await sleep(500);
              const url = page.url();
              if (!url.includes("/viewcheckout")) break;
            }
          }
        } catch { /* ignore navigation errors */ }
      }
    }

    // At this point we're on the payment page, ready for payment selection.
  }

  /**
   * Runs the purchase flow for a single RTGS tab iteration:
   * Uses the shared cart flow (same as Card), then selects RTGS payment.
   * Does NOT wait for bank auth — that's handled by the caller in runRTGSBatched.
   */
  private async runRTGSTabIteration(
    tabPage: Page,
    tabPlatform: BasePlatform,
    tabPayment: BasePayment,
    iterationNum: number
  ): Promise<void> {
    // Use the EXACT same cart flow as Card (add all products, go to cart, place order, verify address)
    await this.addAllProductsAndCheckout(tabPage, tabPlatform, iterationNum);

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
    // Shared cart flow (same code used by RTGS)
    await this.addAllProductsAndCheckout(this.page, this.platform, iterationNum);

    // Payment flow with retry (Card/GiftCard)
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
        // Capture the visible total so failed/declined rows still get an
        // amount in the CSV.
        const seen = await this.platform.captureCheckoutTotal();
        if (seen) this.lastSeenAmount = seen;
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
        // A declined card is a definitive failure for this iteration — never
        // retry the same card. Surface it so the iteration's outer catch can
        // log the per-card decline and the next iteration rotates accounts.
        if (err instanceof CardDeclinedError) {
          throw err;
        }
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

  private async waitForPaymentCompletion(): Promise<
    { ok: true } | { ok: false; declineReason: string | null }
  > {
    const baseTimeout = 120_000; // 2 minutes base
    const maxTimeout = 300_000; // 5 minutes max (extended for OTP/bank pages)
    const absoluteMax = Date.now() + maxTimeout; // Hard ceiling
    let deadline = Date.now() + baseTimeout;
    let lastState = "";
    let wasOnBank = false;

    // CardPayment.getDeclineReason is the broad-phrase scanner; gate on
    // payment type so we don't add overhead for non-card flows that never
    // hit a bank page.
    const declineScanner =
      this.payment instanceof CardPayment ? (this.payment as CardPayment) : null;

    while (Date.now() < deadline) {
      // Order confirmed → success
      if (await this.platform.isOrderConfirmationVisible()) {
        sendMessage({ type: "log", level: "info", message: "Order confirmed!" });
        return { ok: true };
      }

      // Decline detected on whatever page we're currently looking at.
      // For card flows the scanner covers Flipkart's "unsuccessful" page AND
      // common bank/PSP wording ("transaction declined", "do not honour", …).
      if (declineScanner) {
        const reason = await declineScanner.getDeclineReason();
        if (reason) {
          sendMessage({
            type: "log",
            level: "error",
            message: `Card declined detected: "${reason}"`,
          });
          return { ok: false, declineReason: reason };
        }
      } else if (await this.payment.isPaymentFailed()) {
        sendMessage({ type: "log", level: "error", message: "Payment failed" });
        return { ok: false, declineReason: "payment failed" };
      }

      // Track URL transitions: bank → back-to-flipkart with no order confirmation
      // is a strong decline signal that lets us fail fast (instead of waiting
      // out the 5-minute ceiling).
      const currentState = await this.detectPageState();
      if (currentState !== lastState && currentState !== "unknown") {
        sendMessage({
          type: "log",
          level: "info",
          message: `Payment in progress: ${currentState}`,
        });
        lastState = currentState;
      }
      if (currentState === "bank_redirect") {
        wasOnBank = true;
      }

      // If we WERE on a bank page and now we're back on Flipkart with no order
      // confirmation, give it ~8 s for the confirmation page to render OR for
      // a decline message to surface; otherwise treat as decline.
      if (wasOnBank && declineScanner) {
        let onFlipkartNow = false;
        try {
          onFlipkartNow = await this.page.evaluate(() => {
            const u = window.location.href.toLowerCase();
            return u.includes("flipkart.com");
          });
        } catch { /* page in transition */ }

        if (onFlipkartNow) {
          const bounceDeadline = Date.now() + 8_000;
          while (Date.now() < bounceDeadline) {
            if (await this.platform.isOrderConfirmationVisible()) {
              sendMessage({ type: "log", level: "info", message: "Order confirmed!" });
              return { ok: true };
            }
            const reason = await declineScanner.getDeclineReason();
            if (reason) {
              sendMessage({
                type: "log",
                level: "error",
                message: `Card declined detected after bank redirect: "${reason}"`,
              });
              return { ok: false, declineReason: reason };
            }
            await sleep(500);
          }
          // Neither confirmation nor a matched decline phrase appeared after
          // bouncing back. Treat as a silent decline rather than waiting out
          // the full 5-minute ceiling.
          return {
            ok: false,
            declineReason: "bank returned without order confirmation",
          };
        }
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
    return { ok: false, declineReason: null };
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

  /**
   * Append a row to this job's CSV (one file per job: order-reports/job-<jobId>.csv).
   * Called for EVERY iteration — completed, declined and failed — with the
   * STATUS column reflecting what happened. The row is tab-separated; the
   * file extension stays `.csv` for back-compat with existing tooling, but
   * the API serves it with a `.tsv` filename so Excel imports columns
   * correctly.
   *
   * Columns: ITERATION | STATUS | ACCOUNT EMAIL | MODEL | COLOUR | QTY |
   *          PIN CODE | AMOUNT | PER PC | ORDER ID | ORDER DATE | GST NAME |
   *          NOTE
   */
  private appendOrderRow(args: {
    iteration: number;
    status: "completed" | "declined" | "failed";
    accountEmail: string;
    gstName: string;
    pinCode: string;
    qty: number;
    note?: string;
    order?: OrderDetails;
  }): void {
    const reportsDir = getOrderReportsDir();
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const jobId = this.config.jobId || "unknown";
    const csvPath = path.join(reportsDir, `job-${jobId}.csv`);

    const headers = [
      "ITERATION", "STATUS", "ACCOUNT EMAIL", "MODEL", "COLOUR", "QTY",
      "PIN CODE", "AMOUNT", "PER PC", "ORDER ID", "ORDER DATE", "GST NAME",
      "NOTE",
    ].join("\t");

    if (!fs.existsSync(csvPath)) {
      fs.writeFileSync(csvPath, headers + "\n", "utf-8");
      console.log(`[CSV] Created ${csvPath}`);
    }

    const o = args.order;
    const row = [
      String(args.iteration),
      args.status,
      args.accountEmail || "",
      o?.model || "",
      o?.colour || "",
      String(args.qty || o?.quantity || 0),
      args.pinCode || o?.pinCode || "",
      o?.amount || "",
      o?.perPc || "",
      o?.orderId || "",
      o?.orderDate || new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      args.gstName || "",
      args.note || "",
    ].map((v) => String(v).replace(/[\t\r\n]/g, " ")).join("\t");

    fs.appendFileSync(csvPath, row + "\n", "utf-8");
    console.log(`[CSV] Iter ${args.iteration} (${args.status}) → ${csvPath}`);

    sendMessage({
      type: "log",
      level: "info",
      message: `Iteration ${args.iteration} logged: ${args.status}` +
        (o?.orderId ? ` (Order ID ${o.orderId})` : ""),
      iteration: args.iteration,
    });
  }

  // Email used for the given iteration index (0-based). Mirrors the rotation
  // logic at the top of run(). Returns "" if no account/InstaDDR rotation.
  private emailForIteration(i: number): string {
    if (this.accounts && this.accounts.length > 0) {
      return this.accounts[i % this.accounts.length] || "";
    }
    if (this.instaDdrAccounts && this.instaDdrAccounts.length > 0) {
      return this.instaDdrAccounts[i % this.instaDdrAccounts.length]?.email || "";
    }
    return "";
  }

  // Build an OrderDetails object for the CURRENT iteration's row. Falls back
  // to URL-derived model + colour and the last visible checkout total when
  // the iteration didn't reach an order-confirmation page (declined/failed).
  // `extracted` is the (possibly empty) result of extractOrderDetails — its
  // non-empty fields always win.
  private synthesizeOrderDetails(args: {
    qty: number;
    pinCode: string;
    extracted?: OrderDetails;
  }): OrderDetails {
    const productUrl =
      this.config.products?.[0]?.url || this.config.productUrl || "";
    const fallback =
      productUrl && this.platform instanceof FlipkartPlatform
        ? FlipkartPlatform.parseProductFromUrl(productUrl)
        : { model: "", colour: "" };

    const ex = args.extracted;
    const model = (ex?.model || "").trim() || fallback.model;
    const colour = (ex?.colour || "").trim() || fallback.colour;
    const amount = (ex?.amount || "").trim() || this.lastSeenAmount || "";
    const orderId = (ex?.orderId || "").trim();
    const perPc =
      amount && args.qty > 0
        ? String(Math.round(Number(amount) / args.qty))
        : "";

    return {
      orderId,
      model,
      colour,
      quantity: args.qty,
      pinCode: args.pinCode,
      amount,
      perPc,
      orderDate:
        ex?.orderDate ||
        new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    };
  }
}
