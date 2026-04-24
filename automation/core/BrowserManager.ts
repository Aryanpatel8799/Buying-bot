import puppeteer, { Browser, Page } from "puppeteer-core";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

function getChromePath(): string {
  // Allow override via env
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  switch (process.platform) {
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    case "win32": {
      const candidates = [
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) return found;
      throw new Error("Chrome not found. Set CHROME_PATH env variable.");
    }

    case "linux": {
      const candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) return found;
      throw new Error("Chrome not found. Set CHROME_PATH env variable.");
    }

    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export class BrowserManager {
  private browser: Browser | null = null;

  async launch(profileDir: string): Promise<{ browser: Browser; page: Page }> {
    // Ensure profile directory exists
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // Clean up orphan Chrome instances still holding this profile. After a
    // failed job the runner disconnects (instead of closing) so the user can
    // inspect; if we don't clear that orphan here, the NEW launch either
    // attaches to the stale Chrome or starts a degraded sibling process that
    // manifests as "Execution context was destroyed" errors mid-run.
    await this.killOrphanChrome(profileDir);
    this.removeSingletonLocks(profileDir);

    this.browser = await puppeteer.launch({
      headless: false,
      executablePath: getChromePath(),
      userDataDir: profileDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--start-maximized",
        "--disable-popup-blocking",
        "--disable-features=ChromeRuntimeRecognizedBlocking",
        // Hide automation signals so Google Accounts / Gmail / anti-bot DOM
        // checks don't reject the session when the runner opens a Gmail tab
        // for OTP fetching. Works in tandem with ignoreDefaultArgs below.
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      defaultViewport: null,
      // Don't let Puppeteer tear Chrome down when the Node runner receives
      // a signal or exits — we manage the browser lifecycle ourselves so we
      // can leave Chrome open on errors for the user to inspect.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    const page = await this.browser.newPage();
    return { browser: this.browser, page };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Detach the Puppeteer client from Chrome without killing the Chrome
   * process. The user keeps seeing their tabs and can continue manually.
   * The next call to launch() on this same profile will forcibly kill the
   * orphaned Chrome so it doesn't interfere.
   */
  async disconnect(): Promise<void> {
    if (this.browser) {
      try { await this.browser.disconnect(); } catch { /* ignore */ }
      this.browser = null;
    }
  }

  /**
   * Kill any running Chrome process whose command-line contains the profile
   * directory path. Safe to call even if nothing matches.
   */
  private async killOrphanChrome(profileDir: string): Promise<void> {
    const abs = path.resolve(profileDir);
    try {
      if (process.platform === "win32") {
        // Best-effort on Windows. wmic is deprecated but still available; on
        // newer hosts, the command simply fails silently and we continue.
        const escaped = abs.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        execSync(
          `wmic process where "CommandLine like '%%${escaped}%%'" delete`,
          { stdio: "ignore" }
        );
      } else {
        // pkill exits non-zero when no processes match — swallow.
        execSync(`pkill -f ${JSON.stringify(abs)}`, { stdio: "ignore" });
      }
      // Give Chrome a moment to actually exit before we touch the profile dir.
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // No orphan process, or the kill command isn't available — either way
      // we continue; the lock-file cleanup below covers the common case.
    }
  }

  /**
   * Delete Chrome's singleton-instance lock files from the profile dir so a
   * fresh launch isn't blocked by leftovers from a previous (possibly
   * crashed) Chrome process.
   */
  private removeSingletonLocks(profileDir: string): void {
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      const p = path.join(profileDir, name);
      try {
        // Some of these are symlinks — use lstat/unlink instead of existsSync.
        fs.lstatSync(p);
        fs.unlinkSync(p);
      } catch { /* file missing / not accessible — fine */ }
    }
  }
}
