import puppeteer, { Browser, Page } from "puppeteer-core";
import fs from "fs";
import path from "path";

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
      ],
      defaultViewport: null,
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
}
