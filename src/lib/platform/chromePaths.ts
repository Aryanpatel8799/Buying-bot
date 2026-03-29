import fs from "fs";
import path from "path";

export function getChromePath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    case "win32": {
      const candidates = [
        path.join(
          process.env.LOCALAPPDATA || "",
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        ),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) return found;
      throw new Error(
        "Chrome not found. Please install Google Chrome or set CHROME_PATH env variable."
      );
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
      throw new Error(
        "Chrome not found. Please install Google Chrome or set CHROME_PATH env variable."
      );
    }

    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export function getProfileDir(profileDirName: string): string {
  const baseDir = process.env.CHROME_PROFILES_DIR || "./chrome-profiles";
  return path.resolve(baseDir, profileDirName);
}
