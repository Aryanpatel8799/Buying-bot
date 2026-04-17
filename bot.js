const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const os = require("os");

function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  switch (process.platform) {
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    case "win32": {
      const candidates = [
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
      const found = candidates.find((p) => p && fs.existsSync(p));
      if (found) return found;
      throw new Error("Chrome not found. Install Google Chrome or set CHROME_PATH env variable.");
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
      throw new Error("Chrome not found. Install Google Chrome or set CHROME_PATH env variable.");
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// ─── CONFIG — EDIT THESE VALUES ─────────────────────────────
const CONFIG = {
  productURL:
    "https://www.flipkart.com/fossil-rhett-analog-watch-men/p/itmf3zhjhxxncqbq?pid=WATFFDFZHZAVGZHJ&lid=LSTWATFFDFZHZAVGZHJWL2XH4&marketplace=FLIPKART&store=r18%2Ff13&srno=b_1_3&otracker=browse&fm=organic&iid=fcacf6c0-5b58-4c6e-b28d-709adc293ce4.WATFFDFZHZAVGZHJ.SEARCH&ppt=browse&ppn=browse&ov_redirect=true",

  quantity: "2",

  cardNumber: "4111 1111 1111 1111",
  expiry: "12 / 28",
  cvv: "123",

  shortDelay: 500,
  mediumDelay: 1000,
  longDelay: 2000,

  executablePath: resolveChromePath(),

  // Bot's persistent profile — log in once, stays logged in forever
  botDataDir: path.join(os.homedir(), ".chrome-bot-profile"),
};

// ─── HELPERS ────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitAndClick(page, selector, label = "", timeout = 10000) {
  console.log(`⏳ Waiting for ${label || selector} ...`);
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollIntoView({ block: "center" });
  }, selector);
  await sleep(200);
  await page.click(selector);
  console.log(`✅ Clicked ${label || selector}`);
}

async function clearAndType(page, selector, value, label = "") {
  console.log(`⌨️  Typing into ${label || selector} ...`);
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value, { delay: 30 });
  console.log(`✅ Entered "${value}" into ${label || selector}`);
}

// ─── MAIN ───────────────────────────────────────────────────

(async () => {
  console.log("\n🚀 Starting Checkout Bot...\n");

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CONFIG.executablePath,
    userDataDir: CONFIG.botDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--start-maximized",
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  try {
    // STEP 1: Navigate to Product Page
    console.log("🌐 Opening product page...");
    await page.goto(CONFIG.productURL, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(CONFIG.longDelay);

    // STEP 2: Click "Buy Now" (yellow gradient button)
    await waitAndClick(
      page,
      'div[style*="linear-gradient(90deg, rgb(255, 229, 31), rgb(255, 205, 3))"]',
      "Buy Now button"
    );
    await sleep(CONFIG.mediumDelay);

    // STEP 3: Open Quantity Dialog (click "Qty: 1")
    console.log('⏳ Waiting for Quantity dropdown ...');
    await page.waitForFunction(
      () => [...document.querySelectorAll("div")].some((el) => el.textContent.trim().startsWith("Qty:")),
      { timeout: 10000 }
    );
    await page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent.trim().startsWith("Qty:")) {
          el.closest('div[style*="cursor"]').click();
          return;
        }
      }
    });
    console.log('✅ Clicked Quantity dropdown');
    await sleep(CONFIG.mediumDelay);

    // STEP 4: Click "more"
    console.log('⏳ Waiting for "more" option ...');
    await page.waitForFunction(
      () => [...document.querySelectorAll("div.css-146c3p1")].some((el) => el.textContent.trim() === "more"),
      { timeout: 10000 }
    );
    await page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent.trim() === "more") {
          el.closest("div.r-1glkqn6").click();
          return;
        }
      }
    });
    console.log('✅ Clicked "more"');
    await sleep(CONFIG.shortDelay);

    // STEP 5: Enter Quantity
    await clearAndType(
      page,
      'input[placeholder="Quantity"]',
      CONFIG.quantity,
      "Quantity input"
    );
    await sleep(CONFIG.shortDelay);

    // STEP 6: Click "APPLY"
    console.log('⏳ Waiting for "APPLY" button ...');
    await page.evaluate(() => {
      const els = document.querySelectorAll("div.css-146c3p1");
      for (const el of els) {
        if (el.textContent.trim() === "APPLY") {
          el.closest("div.r-5kz9s3").click();
          return;
        }
      }
    });
    console.log('✅ Clicked "APPLY"');
    await sleep(CONFIG.mediumDelay);

    // STEP 7: Click "Continue"
    await waitAndClick(
      page,
      'div[style*="background-color: rgb(255, 194, 0)"]',
      "Continue button"
    );
    await sleep(CONFIG.longDelay);

    // STEP 8: Fill Payment Details
    await clearAndType(page, "#cc-input", CONFIG.cardNumber, "Card Number");
    await sleep(CONFIG.shortDelay);

    await clearAndType(page, 'input[placeholder="MM / YY"]', CONFIG.expiry, "Expiry Date");
    await sleep(CONFIG.shortDelay);

    await clearAndType(page, "#cvv-input", CONFIG.cvv, "CVV");
    await sleep(CONFIG.shortDelay);

    // STEP 9 (OPTIONAL): Click "Place Order"
    // Uncomment when ready:
    // await waitAndClick(page, 'PLACE_ORDER_SELECTOR', "Place Order");

    console.log("\n✅ Bot completed the checkout flow!");
    console.log('ℹ️  "Place Order" is commented out for safety.\n');

  } catch (err) {
    console.error("\n❌ Bot encountered an error:\n", err.message);
    await page.screenshot({ path: "error-screenshot.png" });
    console.log("📸 Saved error screenshot to error-screenshot.png");
  }
})();
