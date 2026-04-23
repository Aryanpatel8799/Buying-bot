import { Page } from "puppeteer-core";
import { sleep } from "../core/helpers";
import type { InstaDdrServiceLike } from "../platforms/BasePlatform";

/**
 * GmailOtpService — fetches Flipkart OTPs from a Gmail inbox.
 *
 * Design:
 *  - The user has already logged into Gmail inside a Chrome profile on disk
 *    (see the "Connect Gmail" flow under /dashboard/profiles). When the
 *    runner starts, it re-uses that profile, so `mail.google.com` is already
 *    signed in without us ever touching credentials.
 *  - The page passed in is a tab opened in the **main browser context** (not
 *    an isolated one) so the profile's cookies are present.
 *  - Matches the InstaDdrServiceLike interface so it plugs into
 *    FlipkartPlatform.loginWithEmail() / BatchOrchestrator / giftCardRunner
 *    with zero call-site changes beyond choosing which service to instantiate.
 *
 * OTP matching strategy (per the feature plan — "try address match, fall
 * back to newest"):
 *   1. Gmail search for Flipkart sender AND the target InstaDDR address
 *      anywhere in the mail, within the last hour. If a match exists, use
 *      the newest such result.
 *   2. Otherwise, Gmail search for Flipkart sender only (newest wins).
 *   3. If both strategies return no 6-digit code within the timeout, throw.
 */

const GMAIL_BASE = "https://mail.google.com";
const MATCH_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 2000;

export class GmailOtpService implements InstaDdrServiceLike {
  constructor(private page: Page) {}

  // No-ops — login is persisted in the Chrome profile's cookies.
  async login(_id: string, _password: string): Promise<void> { /* no-op */ }
  async logout(): Promise<void> { /* no-op */ }
  async waitForManualLogin(_id: string, _password: string): Promise<void> { /* no-op */ }

  /** Close the Gmail tab; do NOT close the main browser context. */
  async close(): Promise<void> {
    try {
      if (!this.page.isClosed()) {
        await this.page.close();
      }
    } catch { /* ignore */ }
  }

  async fetchOtp(credentials: { instaDdrId: string; instaDdrPassword: string; email: string }): Promise<string> {
    const { email } = credentials;
    console.log(`[Gmail] Fetching OTP for: ${email.substring(0, 4)}***`);

    // Strategy 1: search for Flipkart + target InstaDDR address, last 1h.
    const specificQuery = `from:flipkart "${email}" newer_than:1h`;
    let otp = await this.searchAndExtract(specificQuery);
    if (otp) {
      console.log(`[Gmail] OTP ${otp} matched via address-specific search`);
      return otp;
    }

    // Strategy 2: newest Flipkart OTP, last 1h.
    const fallbackQuery = `from:flipkart newer_than:1h`;
    otp = await this.searchAndExtract(fallbackQuery);
    if (otp) {
      console.log(`[Gmail] OTP ${otp} matched via newest-wins fallback`);
      return otp;
    }

    throw new Error(`No Flipkart OTP found in Gmail for ${email.substring(0, 4)}***`);
  }

  /** Run a Gmail search query, wait until a 6-digit code appears on the page, return it. */
  private async searchAndExtract(query: string): Promise<string | null> {
    const url = `${GMAIL_BASE}/mail/u/0/#search/${encodeURIComponent(query)}`;
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (err) {
      console.warn(`[Gmail] navigate failed (${(err as Error).message})`);
      return null;
    }
    await sleep(2500);

    // Are we signed out? Gmail will redirect to accounts.google.com.
    if (this.page.url().includes("accounts.google.com")) {
      throw new Error("Gmail profile is not signed in — reconnect it from the Profiles page.");
    }

    const deadline = Date.now() + MATCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const otp = await this.extractOtpFromDom();
      if (otp) return otp;

      // Open the newest thread if we haven't already — Gmail's search page
      // shows subject + preview; opening the thread gives us the body.
      await this.openFirstResult();
      await sleep(POLL_INTERVAL_MS);
    }

    return null;
  }

  /** Click the first thread row in the current search result so we can read
   *  the body. Safe to call multiple times. */
  private async openFirstResult(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        // Gmail uses role="row" inside the thread list; the clickable area is
        // the first span with the subject. Fall back to clicking the row itself.
        const firstRow = document.querySelector('tr[role="row"]') as HTMLElement | null;
        if (firstRow) {
          const subject = firstRow.querySelector('span[role="link"], [data-thread-id]') as HTMLElement | null;
          (subject ?? firstRow).click();
        }
      });
    } catch { /* ignore */ }
  }

  /** Look for a "Flipkart ... verification ... 6-digit" pattern anywhere on
   *  the currently-rendered page (search results preview or open thread). */
  private async extractOtpFromDom(): Promise<string | null> {
    try {
      return await this.page.evaluate(() => {
        const text = (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .toLowerCase();

        // Only look at text that mentions flipkart + verification to avoid
        // grabbing random 6-digit numbers (tracking codes, PINs from other emails).
        if (!text.includes("flipkart") || !text.includes("verification")) {
          return null;
        }

        // Search original (cased) body text for the 6-digit group so we can
        // show it in logs; regex is the same either way.
        const raw = document.body?.innerText || "";
        const match = raw.match(/\b(\d{6})\b/);
        return match ? match[1] : null;
      });
    } catch {
      return null;
    }
  }
}
