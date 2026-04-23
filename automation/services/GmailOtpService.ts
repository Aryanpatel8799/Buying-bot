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
 * Search flow (drives the actual Gmail UI; the URL-hash-search trick was
 * unreliable):
 *   1. Navigate to the inbox.
 *   2. Type into the "Search mail" input (selector: input[name="q"][aria-label="Search mail"]).
 *   3. Read the autocomplete suggestion subjects — Flipkart's OTP subject is
 *      "Flipkart Account - 161794 is your verification code", so the OTP is
 *      right there without opening the email.
 *   4. If autocomplete didn't yield a code, press Enter to commit the search
 *      and read subjects/bodies of the result rows.
 *
 * OTP matching strategy ("try address-specific, fall back to newest"):
 *   - First search:  from:flipkart "<target-instaddr-email>" newer_than:1h
 *   - Fallback:      from:flipkart newer_than:1h
 */

const GMAIL_BASE = "https://mail.google.com";
const INBOX_URL = `${GMAIL_BASE}/mail/u/0/?tab=rm&ogbl#inbox`;
const SEARCH_INPUT_SELECTOR = 'input[name="q"][aria-label="Search mail"]';

const SETTLE_AFTER_TYPE_MS = 1800;
const SETTLE_AFTER_ENTER_MS = 3500;

export class GmailOtpService implements InstaDdrServiceLike {
  /** Shorter initial wait than InstaDDR's 60s — Gmail receives mail much faster. */
  readonly initialWaitMs = 10000;
  private inboxReady: Promise<void> | null = null;

  constructor(private page: Page) {
    // Hide navigator.webdriver before any navigation so Google Accounts can't
    // detect automation via the JS flag. The Chrome flags set in
    // BrowserManager suppress most signals; this one belongs to the page.
    this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    }).catch(() => { /* ignore */ });
  }

  /**
   * Fire-and-forget warm-up: navigate to the Gmail inbox so by the time we
   * need to fetch the OTP, the UI is already rendered. Call this right after
   * constructing the service (in parallel with the Flipkart login flow) —
   * fetchOtp() will await the same promise later so there's no race.
   */
  init(): Promise<void> {
    if (!this.inboxReady) this.inboxReady = this.loadInbox();
    return this.inboxReady;
  }

  private async loadInbox(): Promise<void> {
    const start = Date.now();
    try {
      await this.page.goto(INBOX_URL, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (err) {
      throw new Error(`[Gmail] Couldn't open Gmail inbox: ${(err as Error).message}`);
    }

    if (this.page.url().includes("accounts.google.com")) {
      throw new Error("Gmail profile is not signed in — reconnect it from the Profiles page.");
    }

    try {
      await this.page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: 20000, visible: true });
    } catch {
      throw new Error("Gmail loaded but the search input didn't appear (UI may have changed).");
    }
    console.log(`[Gmail] inbox ready in ${Date.now() - start}ms`);
  }

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

    await this.ensureInbox();

    // Strategy 1: Flipkart sender + the specific InstaDDR address, last 1h.
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

  /** Ensure the inbox has loaded — kicks off init() if no one did. */
  private async ensureInbox(): Promise<void> {
    if (!this.inboxReady) this.inboxReady = this.loadInbox();
    await this.inboxReady;
  }

  /**
   * Type the query into Gmail's search input, then try to read the OTP from
   * the autocomplete suggestions; if not found, press Enter and read it from
   * the search-results page.
   */
  private async searchAndExtract(query: string): Promise<string | null> {
    // Focus and clear the search box, then type the query.
    try {
      await this.page.click(SEARCH_INPUT_SELECTOR, { clickCount: 3 });
      await this.page.keyboard.press("Backspace");
    } catch {
      // Input may not be available yet — try ensuring inbox once more.
      await this.ensureInbox();
      await this.page.click(SEARCH_INPUT_SELECTOR, { clickCount: 3 }).catch(() => { /* ignore */ });
      await this.page.keyboard.press("Backspace").catch(() => { /* ignore */ });
    }
    await this.page.type(SEARCH_INPUT_SELECTOR, query, { delay: 25 });
    await sleep(SETTLE_AFTER_TYPE_MS);

    // Try the autocomplete dropdown first — for Flipkart the OTP is in the subject.
    let otp = await this.extractOtpFromAutocomplete();
    if (otp) return otp;

    // Otherwise commit the search and look at the results page.
    await this.page.keyboard.press("Enter");
    await sleep(SETTLE_AFTER_ENTER_MS);
    otp = await this.extractOtpFromResults();
    return otp;
  }

  /**
   * Read OTP from Gmail's search-suggestion dropdown. Each suggestion has:
   *   - <div class="asor_b asor_f"> with the subject (or the same text in `title=`)
   *   - aria-label on the parent `[aria-label^="Open mail"]` containing subject + sender + date
   * Flipkart OTP subjects typically contain the 6-digit code itself.
   */
  private async extractOtpFromAutocomplete(): Promise<string | null> {
    try {
      return await this.page.evaluate(() => {
        const candidates: string[] = [];

        // Subject-only nodes (most reliable for OTP-in-subject)
        document.querySelectorAll<HTMLElement>(".asor_b.asor_f").forEach((el) => {
          const text = (el.getAttribute("title") || el.textContent || "").trim();
          if (text) candidates.push(text);
        });

        // Whole-row aria-labels (fallback in case subject text doesn't include the OTP)
        document.querySelectorAll<HTMLElement>('[aria-label^="Open mail"]').forEach((el) => {
          const text = el.getAttribute("aria-label") || "";
          if (text) candidates.push(text);
        });

        for (const text of candidates) {
          const lower = text.toLowerCase();
          if (lower.includes("flipkart") && (lower.includes("verification") || lower.includes("otp"))) {
            const m = text.match(/\b(\d{6})\b/);
            if (m) return m[1];
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Read OTP from the actual search-results listing or an opened thread. Tries
   * the visible thread rows' subject text first; if that fails, opens the
   * first row and scans the body.
   */
  private async extractOtpFromResults(): Promise<string | null> {
    // 1) Look at row subjects in the result list.
    const fromRows = await this.page.evaluate(() => {
      // Gmail subjects in the list are inside `span[data-thread-id] span` or
      // `tr[role="row"] span[role="link"]`. Be permissive.
      const rows = document.querySelectorAll<HTMLElement>('tr[role="row"]');
      for (const row of rows) {
        const text = (row.textContent || "").replace(/\s+/g, " ");
        const lower = text.toLowerCase();
        if (lower.includes("flipkart") && (lower.includes("verification") || lower.includes("otp"))) {
          const m = text.match(/\b(\d{6})\b/);
          if (m) return m[1];
        }
      }
      return null;
    }).catch(() => null);

    if (fromRows) return fromRows;

    // 2) Click the first matching row, then scan the open thread.
    const opened = await this.page.evaluate(() => {
      const rows = document.querySelectorAll<HTMLElement>('tr[role="row"]');
      for (const row of rows) {
        const lower = (row.textContent || "").toLowerCase();
        if (lower.includes("flipkart")) {
          (row.querySelector('span[role="link"], [data-thread-id]') as HTMLElement | null ?? row).click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!opened) return null;
    await sleep(2500);

    return await this.page.evaluate(() => {
      const text = document.body?.innerText || "";
      const lower = text.replace(/\s+/g, " ").toLowerCase();
      if (!lower.includes("flipkart") || (!lower.includes("verification") && !lower.includes("otp"))) {
        return null;
      }
      const m = text.match(/\b(\d{6})\b/);
      return m ? m[1] : null;
    }).catch(() => null);
  }
}
