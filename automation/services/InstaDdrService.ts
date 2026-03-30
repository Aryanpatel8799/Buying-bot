import { Page, BrowserContext } from "puppeteer-core";
import { sleep } from "../core/helpers";

const LOGIN_URL = "https://m.kuku.lu/index.php?pagemode_login=1&noindex=1#p156";
const INBOX_URL = "https://m.kuku.lu/recv.php";

export interface InstaDdrCredentials {
  instaDdrId: string;
  instaDdrPassword: string;
  email: string;
}

export class InstaDdrService {
  private currentId: string = "";
  private currentPassword: string = "";

  constructor(
    private page: Page,
    private baseUrl: string = "https://m.kuku.lu",
    private context?: BrowserContext
  ) {}

  /** Close the isolated browser context (call when job finishes). */
  async close(): Promise<void> {
    console.log("[InstaDDR] Closing isolated browser context...");
    this.currentId = "";
    this.currentPassword = "";
    if (this.context) {
      await this.context.close();
    }
  }

  /**
   * Main method: navigate to InstaDDR, login if needed (credentials changed), fetch OTP.
   * InstaDDR login is manual (user enters credentials in browser).
   * Flipkart OTP is fetched automatically from the inbox.
   */
  async fetchOtp(credentials: InstaDdrCredentials): Promise<string> {
    const { email } = credentials;

    // Navigate to inbox and fetch OTP (session already logged in manually by user)
    const otp = await this.getOtpFromInbox(email);
    return otp;
  }

  /**
   * Navigate to InstaDDR login page and wait for user to enter credentials manually.
   * After login, click the "No" confirmation button if it appears.
   * User must log in manually in the InstaDDR browser — this method just
   * navigates to the login page and handles the post-login confirmation dialog.
   */
  async waitForManualLogin(id: string, password: string): Promise<void> {
    console.log(`[InstaDDR] Navigating to login page — logging in automatically`);
    this.currentId = id;
    this.currentPassword = password;

    await this.page.goto(LOGIN_URL, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Wait for the page to render
    let loginFormFound = false;
    for (let attempt = 0; attempt < 10 && !loginFormFound; attempt++) {
      loginFormFound = await this.page.evaluate(() => {
        return document.getElementById("user_number") !== null ||
               document.body.innerText.length > 50;
      });
      if (!loginFormFound) {
        console.log(`[InstaDDR] Waiting for page to render (attempt ${attempt + 1}/10)...`);
        await sleep(1000);
      }
    }

    // Click "Sign in to another account" if it exists (required before login form appears)
    for (let attempt = 0; attempt < 5; attempt++) {
      const clicked = await this.page.evaluate(() => {
        const link = document.getElementById("link_loginform");
        if (link) {
          link.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        console.log("[InstaDDR] 'Sign in to another account' clicked");
        await sleep(2000);
        break;
      }
      await sleep(1000);
    }

    // Wait for the actual login form to appear
    let formReady = false;
    for (let attempt = 0; attempt < 10 && !formReady; attempt++) {
      formReady = await this.page.evaluate(() => {
        return document.getElementById("user_number") !== null;
      });
      if (!formReady) {
        console.log(`[InstaDDR] Waiting for login form (attempt ${attempt + 1}/10)...`);
        await sleep(1000);
      }
    }

    if (!formReady) {
      console.warn("[InstaDDR] Login form not found — cannot enter credentials");
      return;
    }

    // Enter AccountID
    console.log(`[InstaDDR] Entering AccountID...`);
    const idEntered = await this.page.evaluate((accountId: string) => {
      const input = document.getElementById("user_number") as HTMLInputElement | null;
      if (!input) return false;
      input.value = "";
      input.focus();
      for (const char of accountId) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        nativeSetter?.call(input, input.value + char);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true, cancelable: true }));
      }
      input.blur();
      return input.value === accountId;
    }, id);

    if (!idEntered) {
      console.warn("[InstaDDR] Failed to enter AccountID");
    } else {
      console.log("[InstaDDR] AccountID entered");
    }

    await sleep(500);

    // Enter Password
    console.log(`[InstaDDR] Entering Password...`);
    const pwEntered = await this.page.evaluate((pwd: string) => {
      const input = document.getElementById("user_password") as HTMLInputElement | null;
      if (!input) return false;
      input.value = "";
      input.focus();
      for (const char of pwd) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        nativeSetter?.call(input, input.value + char);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true, cancelable: true }));
      }
      input.blur();
      return input.value === pwd;
    }, password);

    if (!pwEntered) {
      console.warn("[InstaDDR] Failed to enter Password");
    } else {
      console.log("[InstaDDR] Password entered");
    }

    await sleep(500);

    // Click Login button
    console.log(`[InstaDDR] Clicking Login...`);
    const clicked = await this.page.evaluate(() => {
      const btn = document.querySelector('a[href="javascript:checkLogin();"]') as HTMLAnchorElement | null;
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.warn("[InstaDDR] Login button not found");
      return;
    }

    console.log("[InstaDDR] Login button clicked — waiting for session to establish");
    await sleep(3000);

    // Click "No" confirmation button if it appears
    for (let attempt = 0; attempt < 5; attempt++) {
      const noClicked = await this.page.evaluate(() => {
        const btn = document.getElementById("area-confirm-dialog-button-cancel");
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (noClicked) {
        console.log("[InstaDDR] 'No' confirmation button clicked");
        await sleep(1000);
        break;
      }
      await sleep(1000);
    }

    console.log("[InstaDDR] Login complete");
  }

  /** Navigate to InstaDDR login page. For manual login flow. */
  async login(id: string, password: string): Promise<void> {
    await this.waitForManualLogin(id, password);
  }

  async logout(): Promise<void> {
    console.log("[InstaDDR] Logging out...");
    try {
      await this.page.goto(`${this.baseUrl}/index.php?pagemode_logout=1`, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
    } catch {
      // ignore
    }
    this.currentId = "";
    this.currentPassword = "";
    await sleep(1000);
    console.log("[InstaDDR] Logged out");
  }

  private async getOtpFromInbox(email: string): Promise<string> {
    console.log(`[InstaDDR] Fetching OTP for: ${email.substring(0, 3)}***`);

    // Navigate to inbox
    await this.page.goto(INBOX_URL, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await sleep(2500);

    // Reload to catch latest emails
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1000);

    // Parse email subject lines for Flipkart OTP
    const otp = await this.page.evaluate(() => {
      const anchors = document.querySelectorAll("a[href*='recv.php'], a[href*='read.php']");
      for (const anchor of anchors) {
        const text = anchor.textContent?.trim() || "";
        if (text.toLowerCase().includes("flipkart") && text.includes("verification")) {
          const match = text.match(/\d{6}/);
          if (match) return match[0];
        }
      }
      // Fallback: search all elements
      const allEls = document.querySelectorAll("a, div, span, td");
      for (const el of allEls) {
        const text = el.textContent?.trim() || "";
        if (text.toLowerCase().includes("flipkart") && /\d{6}/.test(text)) {
          const match = text.match(/\d{6}/);
          if (match) return match[0];
        }
      }
      return null;
    });

    if (otp) {
      console.log(`[InstaDDR] OTP found: ${otp}`);
      return otp;
    }

    throw new Error(`No Flipkart OTP found in InstaDDR inbox for ${email}`);
  }
}
