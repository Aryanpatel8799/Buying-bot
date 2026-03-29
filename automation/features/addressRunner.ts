/**
 * Address Runner — Adds a delivery address to Flipkart account and verifies
 * GST invoice details on the checkout page.
 *
 * Receives config as base64-encoded JSON via process.argv[2].
 * Config: { chromeProfileDir, address: AddressDetails, historyId }
 *
 * Flow:
 * 1. Navigate to https://www.flipkart.com/account/addresses
 * 2. Check if the address already exists — if yes, skip adding
 * 3. Click "ADD A NEW ADDRESS" and fill all fields
 * 4. Save and go to checkout
 * 5. Verify delivery address matches
 * 6. Verify/update GST invoice details
 * 7. Ensure GST invoice checkbox is ticked
 */

import { BrowserManager } from "../core/BrowserManager";
import {
  sendMessage,
  sleep,
  navigateWithRetry,
  waitWithRetry,
  clearAndType,
} from "../core/helpers";

interface AddressDetails {
  name: string;
  mobile: string;
  pincode: string;
  locality: string;
  addressLine1: string;
  city: string;
  state: string;
  addressType: "Home" | "Work";
  gstNumber: string;
  companyName: string;
}

interface AddressRunnerConfig {
  chromeProfileDir: string;
  address: AddressDetails;
}

async function main() {
  const configB64 = process.argv[2];
  if (!configB64) {
    console.error("Usage: addressRunner <base64-config>");
    process.exit(1);
  }

  let config: AddressRunnerConfig;
  try {
    config = JSON.parse(Buffer.from(configB64, "base64").toString("utf-8"));
  } catch {
    console.error("Failed to parse address runner config");
    process.exit(1);
  }

  sendMessage({
    type: "log",
    level: "info",
    message: `Address Runner started — GST: ${config.address.gstNumber}, Company: ${config.address.companyName}`,
  });

  const browserManager = new BrowserManager();

  try {
    const { browser, page } = await browserManager.launch(config.chromeProfileDir);

    // =========================================================
    // STEP 1: Navigate to Flipkart account addresses page
    // =========================================================
    await navigateWithRetry(page, "https://www.flipkart.com/account/addresses", {
      timeoutMs: 15000,
      maxRetries: 3,
    });
    await sleep(500);
    sendMessage({ type: "log", level: "info", message: "Opened account addresses page" });

    // =========================================================
    // STEP 2: Check if address already exists
    // =========================================================
    const addressExists = await page.evaluate(
      (addr: AddressDetails) => {
        const allText = document.body.innerText.toLowerCase();
        const nameMatch = allText.includes(addr.name.toLowerCase());
        const cityMatch = allText.includes(addr.city.toLowerCase());
        const localityMatch = allText.includes(addr.locality.toLowerCase());
        const matchCount = [nameMatch, cityMatch, localityMatch].filter(Boolean).length;
        return matchCount >= 2;
      },
      config.address
    );

    if (addressExists) {
      sendMessage({
        type: "log",
        level: "info",
        message: "Address appears to already exist on Flipkart — skipping add",
      });
      // Still proceed to checkout to verify GST
    } else {
      // =========================================================
      // STEP 3: Click "ADD A NEW ADDRESS"
      // =========================================================
      sendMessage({ type: "log", level: "info", message: "Address not found — adding new one" });

      await waitWithRetry(
        page,
        async () => {
          await page.waitForFunction(
            () => {
              const divs = Array.from(document.querySelectorAll("div"));
              for (const d of divs) {
                const txt = d.innerText?.trim() || "";
                if (txt.includes("ADD A NEW ADDRESS")) return true;
              }
              return false;
            },
            { timeout: 10000 }
          );
        },
        { label: "ADD A NEW ADDRESS button", timeoutMs: 10000, maxRetries: 3 }
      );

      await page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll("div"));
        for (const d of divs) {
          const txt = d.innerText?.trim() || "";
          if (txt.includes("ADD A NEW ADDRESS")) {
            (d as HTMLElement).click();
            return;
          }
        }
      });
      sendMessage({ type: "log", level: "info", message: "Clicked ADD A NEW ADDRESS" });
      await sleep(500);

      // =========================================================
      // STEP 4: Fill address form fields
      // =========================================================

      // Name
      await clearAndType(page, 'input[name="name"]', config.address.name, "Name field");
      await sleep(200);

      // 10-digit mobile number
      await clearAndType(page, 'input[name="phone"]', config.address.mobile, "Mobile field");
      await sleep(200);

      // Pincode
      await clearAndType(page, 'input[name="pincode"]', config.address.pincode, "Pincode field");
      await sleep(200);

      // Locality
      await clearAndType(page, 'input[name="addressLine2"]', config.address.locality, "Locality field");
      await sleep(200);

      // Address (Area and Street)
      await clearAndType(
        page,
        'textarea[name="addressLine1"]',
        config.address.addressLine1,
        "Address field"
      );
      await sleep(200);

      // City/District/Town
      await clearAndType(page, 'input[name="city"]', config.address.city, "City field");
      await sleep(200);

      // State (select from dropdown)
      await waitWithRetry(
        page,
        async () => {
          await page.waitForSelector('select[name="state"]', { visible: true, timeout: 5000 });
        },
        { label: "State dropdown", timeoutMs: 5000, maxRetries: 3 }
      );

      await page.select('select[name="state"]', config.address.state);
      sendMessage({ type: "log", level: "info", message: `Selected state: ${config.address.state}` });
      await sleep(200);

      // Address Type (Home or Work)
      const radioValue = config.address.addressType === "Home" ? "HOME" : "WORK";
      await page.evaluate(
        (val: string) => {
          const radios = Array.from(document.querySelectorAll(`input[name="locationTypeTag"][id="${val}"]`));
          if (radios.length > 0) {
            (radios[0] as HTMLInputElement).click();
          }
        },
        radioValue
      );
      sendMessage({ type: "log", level: "info", message: `Selected address type: ${config.address.addressType}` });
      await sleep(200);

      // =========================================================
      // STEP 5: Click Save button
      // =========================================================
      await waitWithRetry(
        page,
        async () => {
          await page.waitForFunction(
            () => {
              const buttons = Array.from(document.querySelectorAll("button"));
              for (const btn of buttons) {
                if (btn.textContent?.trim().toLowerCase() === "save") return true;
              }
              return false;
            },
            { timeout: 5000 }
          );
        },
        { label: "Save button", timeoutMs: 5000, maxRetries: 3 }
      );

      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const btn of buttons) {
          if (btn.textContent?.trim().toLowerCase() === "save") {
            btn.scrollIntoView({ block: "center" });
            (btn as HTMLElement).click();
            return;
          }
        }
      });
      sendMessage({ type: "log", level: "info", message: "Clicked Save" });
      await sleep(500);

      const saveResult = await page.evaluate(() => {
        const text = document.body.innerText;
        if (text.includes("Address saved") || text.includes("saved successfully") || text.includes("added successfully")) {
          return "success";
        }
        return "unknown";
      });

      if (saveResult === "success") {
        sendMessage({ type: "log", level: "info", message: "Address saved successfully on Flipkart" });
      } else {
        sendMessage({ type: "log", level: "warn", message: "Could not confirm address save — proceeding anyway" });
      }
    }

    // =========================================================
    // STEP 6: Navigate to checkout page
    // =========================================================
    await navigateWithRetry(page, "https://www.flipkart.com/viewcheckout", {
      timeoutMs: 15000,
      maxRetries: 3,
    });
    await sleep(1000);
    sendMessage({ type: "log", level: "info", message: "Opened checkout page" });

    // =========================================================
    // STEP 7: Verify delivery address on checkout page
    // =========================================================
    await verifyAndFixDeliveryAddress(page, config.address, browser);

    // =========================================================
    // STEP 8: Verify and fix GST invoice details
    // =========================================================
    await verifyAndFixGstDetails(page, config.address);

    // =========================================================
    // STEP 9: Ensure GST invoice checkbox is ticked
    // =========================================================
    await ensureGstCheckboxTicked(page);

    sendMessage({ type: "log", level: "info", message: "Address + GST setup completed successfully" });
    sendMessage({ type: "done", completed: 1, failed: 0 });

    process.exit(0);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    sendMessage({
      type: "log",
      level: "error",
      message: `Address Runner fatal error: ${errorMsg}`,
    });
    process.exit(1);
  } finally {
    await browserManager.close();
  }
}

// ----------------------------------------------------------------
// Helper: Verify delivery address on checkout page, fix if needed
// ----------------------------------------------------------------
async function verifyAndFixDeliveryAddress(
  page: import("puppeteer-core").Page,
  address: AddressDetails,
  browser: import("puppeteer-core").Browser
) {
  sendMessage({ type: "log", level: "info", message: "Checking delivery address on checkout page..." });

  // Read current address from the "Deliver to:" section
  const currentAddress = await page.evaluate(() => {
    const divs = Array.from(document.querySelectorAll("div"));
    let deliverSection: HTMLElement | null = null;
    for (const d of divs) {
      const txt = d.innerText?.trim() || "";
      if (txt.startsWith("Deliver to:")) {
        deliverSection = d as HTMLElement;
        break;
      }
    }
    if (!deliverSection) return null;
    return deliverSection.innerText || null;
  });

  const addressMatch = currentAddress
    ? checkAddressMatch(currentAddress, address)
    : false;

  if (addressMatch) {
    sendMessage({ type: "log", level: "info", message: "Delivery address matches — no change needed" });
    return;
  }

  sendMessage({ type: "log", level: "info", message: "Delivery address mismatch — clicking Change" });

  // Click "Change" in the delivery address section
  await waitWithRetry(
    page,
    async () => {
      await page.waitForFunction(
        () => {
          const allDivs = Array.from(document.querySelectorAll("div"));
          for (const d of allDivs) {
            if (d.innerText?.trim() === "Change") {
              // Walk up to find a clickable parent
              let el: HTMLElement | null = d;
              while (el && el !== document.body) {
                const style = el.getAttribute("style") || "";
                if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
                  return true;
                }
                el = el.parentElement;
              }
              // Just check if this div or nearby is clickable
              const parent = d.parentElement;
              if (parent) {
                const pStyle = parent.getAttribute("style") || "";
                if (pStyle.includes("cursor")) return true;
              }
            }
          }
          return false;
        },
        { timeout: 5000 }
      );
    },
    { label: "Change address button", timeoutMs: 8000, maxRetries: 3 }
  );

  await page.evaluate((targetText: string) => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      const txt = d.innerText?.trim() || "";
      if (txt === targetText) {
        let el: HTMLElement | null = d;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
            el.scrollIntoView({ block: "center" });
            el.click();
            return;
          }
          el = el.parentElement;
        }
        // Fallback: click parent if it has cursor style
        const parent = d.parentElement;
        if (parent) {
          const pStyle = parent.getAttribute("style") || "";
          if (pStyle.includes("cursor")) {
            parent.scrollIntoView({ block: "center" });
            parent.click();
            return;
          }
        }
      }
    }
  }, "Change");
  sendMessage({ type: "log", level: "info", message: "Clicked Change for delivery address" });
  await sleep(500);

  // =========================================================
  // STEP 7a: Look for the address in the list
  // =========================================================
  const foundInList = await page.evaluate(
    (addr: AddressDetails) => {
      const allDivs = Array.from(document.querySelectorAll("div"));
      const addressParts = [
        addr.name.toLowerCase(),
        addr.city.toLowerCase(),
        addr.locality.toLowerCase(),
        addr.addressLine1.toLowerCase().split(" ").slice(0, 3).join(" "),
      ].filter(Boolean);

      let matchingEntry: HTMLElement | null = null;
      let matchCount = 0;

      for (const d of allDivs) {
        const txt = d.innerText?.trim() || "";
        const lowerTxt = txt.toLowerCase();
        const currentMatches = addressParts.filter(
          (p) => p.length > 2 && lowerTxt.includes(p)
        ).length;

        // Check if this div contains the company name and looks like an address entry
        if (
          currentMatches > matchCount &&
          lowerTxt.includes(addr.city.toLowerCase())
        ) {
          matchCount = currentMatches;
          matchingEntry = d as HTMLElement;
        }
      }

      if (matchingEntry) {
        // Walk up to find the clickable container
        let el: HTMLElement | null = matchingEntry;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (
            style.includes("cursor: pointer") ||
            el.getAttribute("role") === "button"
          ) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return "clicked";
          }
          el = el.parentElement;
        }
      }
      return null;
    },
    address
  );

  if (foundInList) {
    sendMessage({ type: "log", level: "info", message: "Found address in list and selected it" });
    await sleep(500);
    return;
  }

  sendMessage({ type: "log", level: "info", message: "Address not in list — opening new tab to add it" });

  // =========================================================
  // STEP 7b: Open new tab to add address
  // =========================================================
  const newTab = await browser.newPage();
  await newTab.goto("https://www.flipkart.com/account/addresses", {
    waitUntil: "networkidle2",
    timeout: 15000,
  });
  sendMessage({ type: "log", level: "info", message: "Opened addresses page in new tab" });
  await sleep(500);

  // Click ADD A NEW ADDRESS in new tab
  await waitWithRetry(
    newTab,
    async () => {
      await newTab.waitForFunction(
        () => {
          const divs = Array.from(document.querySelectorAll("div"));
          for (const d of divs) {
            if (d.innerText?.trim().includes("ADD A NEW ADDRESS")) return true;
          }
          return false;
        },
        { timeout: 8000 }
      );
    },
    { label: "ADD A NEW ADDRESS in new tab", timeoutMs: 8000, maxRetries: 3 }
  );

  await newTab.evaluate((addrDiv: string) => {
    const divs = Array.from(document.querySelectorAll("div"));
    for (const d of divs) {
      if (d.innerText?.trim().includes(addrDiv)) {
        (d as HTMLElement).click();
        return;
      }
    }
  }, "ADD A NEW ADDRESS");
  sendMessage({ type: "log", level: "info", message: "Clicked ADD A NEW ADDRESS in new tab" });
  await sleep(500);

  // Fill form in new tab
  await clearAndType(newTab, 'input[name="name"]', address.name, "Name (new tab)");
  await sleep(100);
  await clearAndType(newTab, 'input[name="phone"]', address.mobile, "Mobile (new tab)");
  await sleep(100);
  await clearAndType(newTab, 'input[name="pincode"]', address.pincode, "Pincode (new tab)");
  await sleep(100);
  await clearAndType(newTab, 'input[name="addressLine2"]', address.locality, "Locality (new tab)");
  await sleep(100);
  await clearAndType(newTab, 'textarea[name="addressLine1"]', address.addressLine1, "Address (new tab)");
  await sleep(100);
  await clearAndType(newTab, 'input[name="city"]', address.city, "City (new tab)");
  await sleep(100);
  await newTab.select('select[name="state"]', address.state);
  sendMessage({ type: "log", level: "info", message: "Filled address form in new tab" });
  await sleep(100);

  const radioVal = address.addressType === "Home" ? "HOME" : "WORK";
  await newTab.evaluate(
    (val: string) => {
      const radios = Array.from(document.querySelectorAll(`input[name="locationTypeTag"][id="${val}"]`));
      if (radios.length > 0) (radios[0] as HTMLInputElement).click();
    },
    radioVal
  );
  await sleep(100);

  // Save in new tab
  await waitWithRetry(
    newTab,
    async () => {
      await newTab.waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const btn of buttons) {
            if (btn.textContent?.trim().toLowerCase() === "save") return true;
          }
          return false;
        },
        { timeout: 5000 }
      );
    },
    { label: "Save button (new tab)", timeoutMs: 5000, maxRetries: 3 }
  );

  await newTab.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      if (btn.textContent?.trim().toLowerCase() === "save") {
        btn.scrollIntoView({ block: "center" });
        (btn as HTMLElement).click();
        return;
      }
    }
  });
  sendMessage({ type: "log", level: "info", message: "Clicked Save in new tab" });
  await sleep(500);

  // Close new tab and go back to checkout tab
  await newTab.close();
  sendMessage({ type: "log", level: "info", message: "Closed new tab, switching to checkout tab" });
  await sleep(300);

  // Go back to checkout and refresh
  await page.goto("https://www.flipkart.com/viewcheckout", {
    waitUntil: "networkidle2",
    timeout: 15000,
  });
  await sleep(1000);
  sendMessage({ type: "log", level: "info", message: "Refreshed checkout page" });

  // Click Change again and select the newly added address
  await page.evaluate((targetText: string) => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      if (d.innerText?.trim() === targetText) {
        let el: HTMLElement | null = d;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
            el.scrollIntoView({ block: "center" });
            el.click();
            return;
          }
          el = el.parentElement;
        }
      }
    }
  }, "Change");
  sendMessage({ type: "log", level: "info", message: "Clicked Change again to select address" });
  await sleep(500);

  // Try to find and select the address in the list
  const selected = await page.evaluate(
    (addr: AddressDetails) => {
      const allDivs = Array.from(document.querySelectorAll("div"));
      const cityLower = addr.city.toLowerCase();

      for (const d of allDivs) {
        const txt = d.innerText?.trim() || "";
        if (txt.toLowerCase().includes(cityLower) && txt.length > 10) {
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
    },
    address
  );

  if (selected) {
    sendMessage({ type: "log", level: "info", message: "Selected the newly added address" });
    await sleep(500);
  } else {
    sendMessage({ type: "log", level: "warn", message: "Could not auto-select address — manual intervention may be needed" });
  }
}

// ----------------------------------------------------------------
// Helper: Verify and fix GST invoice details
// ----------------------------------------------------------------
async function verifyAndFixGstDetails(
  page: import("puppeteer-core").Page,
  address: AddressDetails
) {
  sendMessage({ type: "log", level: "info", message: "Checking GST invoice details on checkout page..." });

  // Check current GST details
  const currentGst = await page.evaluate(() => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    const gstTexts: string[] = [];
    for (const d of allDivs) {
      const txt = d.innerText?.trim() || "";
      if (txt.length > 5 && txt.length < 20 && /^[0-9A-Z]+$/.test(txt.replace(/\s/g, ""))) {
        // Check if it looks like a GST number
        if (/^[0-9]{2}[A-Z]{3}/.test(txt.replace(/\s/g, ""))) {
          gstTexts.push(txt.replace(/\s/g, ""));
        }
      }
    }

    // Also look for the company name text
    const companyDivs = Array.from(document.querySelectorAll("div"));
    let companyName = "";
    for (const d of companyDivs) {
      const txt = d.innerText?.trim() || "";
      if (txt.length > 5 && /[A-Z\s]/.test(txt) && !/[a-z]{3,}/.test(txt.replace(/\s/g, ""))) {
        if (txt.includes("PRIVATE") || txt.includes("LIMITED") || txt.includes("LTD") || txt.includes("CORPORATION")) {
          companyName = txt;
          break;
        }
      }
    }

    return { gstTexts, companyName };
  });

  const gstMatches =
    currentGst.gstTexts.some((g) => g === address.gstNumber) &&
    (currentGst.companyName.toLowerCase().includes(address.companyName.toLowerCase()) ||
      address.companyName.toLowerCase().includes(currentGst.companyName.toLowerCase()));

  if (gstMatches) {
    sendMessage({ type: "log", level: "info", message: "GST details match — no change needed" });
    return;
  }

  sendMessage({ type: "log", level: "info", message: "GST details mismatch or missing — updating" });

  // Click "Change" in the GST section
  await waitWithRetry(
    page,
    async () => {
      await page.waitForFunction(
        () => {
          const allDivs = Array.from(document.querySelectorAll("div"));
          for (const d of allDivs) {
            if (d.innerText?.trim() === "Change") {
              let el: HTMLElement | null = d;
              while (el && el !== document.body) {
                const style = el.getAttribute("style") || "";
                if (style.includes("cursor: pointer")) return true;
                el = el.parentElement;
              }
            }
          }
          return false;
        },
        { timeout: 5000 }
      );
    },
    { label: "Change GST button", timeoutMs: 8000, maxRetries: 3 }
  );

  await page.evaluate((targetText: string) => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      if (d.innerText?.trim() === targetText) {
        let el: HTMLElement | null = d;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (style.includes("cursor: pointer")) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return;
          }
          el = el.parentElement;
        }
      }
    }
  }, "Change");
  sendMessage({ type: "log", level: "info", message: "Clicked Change for GST details" });
  await sleep(300);

  // Click "Add new GST Details"
  await waitWithRetry(
    page,
    async () => {
      await page.waitForFunction(
        () => {
          const allDivs = Array.from(document.querySelectorAll("div"));
          for (const d of allDivs) {
            const txt = d.innerText?.trim() || "";
            if (txt === "Add new GST Details") return true;
          }
          return false;
        },
        { timeout: 5000 }
      );
    },
    { label: "Add new GST Details button", timeoutMs: 8000, maxRetries: 3 }
  );

  await page.evaluate(() => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      if (d.innerText?.trim() === "Add new GST Details") {
        let el: HTMLElement | null = d;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (style.includes("cursor: pointer")) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return;
          }
          el = el.parentElement;
        }
      }
    }
  });
  sendMessage({ type: "log", level: "info", message: "Clicked Add new GST Details" });
  await sleep(300);

  // Enter GST number and company name
  // Find the inputs — they appear after clicking "Add new GST Details"
  await waitWithRetry(
    page,
    async () => {
      await page.waitForFunction(
        () => {
          // Look for the input that takes GST number (15 chars, autocapitalize)
          const inputs = Array.from(document.querySelectorAll("input"));
          for (const inp of inputs) {
            const maxLen = inp.getAttribute("maxlength");
            if (maxLen === "15") return true;
          }
          return false;
        },
        { timeout: 5000 }
      );
    },
    { label: "GST number input", timeoutMs: 8000, maxRetries: 3 }
  );

  // Fill GST number
  await page.evaluate(
    (gst: string) => {
      const inputs = Array.from(document.querySelectorAll("input"));
      for (const inp of inputs) {
        const maxLen = inp.getAttribute("maxlength");
        if (maxLen === "15") {
          const el = inp as HTMLInputElement;
          el.focus();
          el.value = gst;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
    },
    address.gstNumber
  );
  sendMessage({ type: "log", level: "info", message: `Entered GST number: ${address.gstNumber.slice(0, 2)}****${address.gstNumber.slice(-2)}` });
  await sleep(500);

  // Fill company name (60 char input)
  await page.evaluate(
    (company: string) => {
      const inputs = Array.from(document.querySelectorAll("input"));
      for (const inp of inputs) {
        const maxLen = inp.getAttribute("maxlength");
        if (maxLen === "60") {
          const el = inp as HTMLInputElement;
          el.focus();
          el.value = company;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
    },
    address.companyName
  );
  sendMessage({ type: "log", level: "info", message: `Entered company name: ${address.companyName}` });
  await sleep(500);

  // Click "Confirm and Save"
  await waitWithRetry(
    page,
    async () => {
      await page.waitForFunction(
        () => {
          const allDivs = Array.from(document.querySelectorAll("div"));
          for (const d of allDivs) {
            const txt = d.innerText?.trim() || "";
            if (txt === "Confirm and Save") return true;
          }
          return false;
        },
        { timeout: 5000 }
      );
    },
    { label: "Confirm and Save button", timeoutMs: 8000, maxRetries: 3 }
  );

  await page.evaluate(() => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      if (d.innerText?.trim() === "Confirm and Save") {
        let el: HTMLElement | null = d;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (style.includes("cursor: pointer") || el.getAttribute("role") === "button") {
            el.scrollIntoView({ block: "center" });
            el.click();
            return;
          }
          el = el.parentElement;
        }
        // Fallback: try the button itself
        d.scrollIntoView({ block: "center" });
        (d as HTMLElement).click();
        return;
      }
    }
  });
  sendMessage({ type: "log", level: "info", message: "Clicked Confirm and Save" });
  await sleep(500);
}

// ----------------------------------------------------------------
// Helper: Ensure GST invoice checkbox is ticked
// ----------------------------------------------------------------
async function ensureGstCheckboxTicked(page: import("puppeteer-core").Page) {
  sendMessage({ type: "log", level: "info", message: "Checking GST invoice checkbox..." });

  const isChecked = await page.evaluate(() => {
    // Look for the "Use GST Invoice" text + checked image
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      const txt = d.innerText?.trim() || "";
      if (txt === "Use GST Invoice" || txt === "Use GST Invoice ") {
        // Check if parent/sibling has the checked image
        let el: HTMLElement | null = d;
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          // The checked state has the checked PNG image
          if (style.includes("background-color: rgb(255, 255, 255)") || style.includes("checked-b672f")) {
            const children = Array.from(el.querySelectorAll("img"));
            for (const img of children) {
              const src = img.getAttribute("src") || "";
              if (src.includes("checked-b672f")) return true;
            }
          }
          el = el.parentElement;
        }
        // Alternative: check if any ancestor has the checked image
        const ancestors = Array.from(document.querySelectorAll(`img[src*="checked-b672f"]`));
        if (ancestors.length > 0) return true;
      }
    }
    return false;
  });

  if (isChecked) {
    sendMessage({ type: "log", level: "info", message: "GST invoice checkbox is already ticked" });
    return;
  }

  sendMessage({ type: "log", level: "info", message: "GST invoice checkbox is not ticked — clicking it" });

  await page.evaluate(() => {
    const allDivs = Array.from(document.querySelectorAll("div"));
    for (const d of allDivs) {
      const txt = d.innerText?.trim() || "";
      if (txt === "Use GST Invoice" || txt === "Use GST Invoice ") {
        let el: HTMLElement | null = d;
        // Also check the container div before Use GST Invoice text
        while (el && el !== document.body) {
          const style = el.getAttribute("style") || "";
          if (style.includes("cursor: pointer") || el.getAttribute("role") === "checkbox") {
            el.scrollIntoView({ block: "center" });
            el.click();
            return;
          }
          el = el.parentElement;
        }
        // Fallback: look for the container with cursor pointer near Use GST Invoice
        const parent = d.parentElement;
        if (parent) {
          const pStyle = parent.getAttribute("style") || "";
          if (pStyle.includes("cursor")) {
            parent.scrollIntoView({ block: "center" });
            parent.click();
            return;
          }
          const gParent = parent.parentElement;
          if (gParent) {
            const gpStyle = gParent.getAttribute("style") || "";
            if (gpStyle.includes("cursor")) {
              gParent.scrollIntoView({ block: "center" });
              gParent.click();
              return;
            }
          }
        }
        // Direct click as last resort
        d.scrollIntoView({ block: "center" });
        (d as HTMLElement).click();
      }
    }
  });

  sendMessage({ type: "log", level: "info", message: "GST invoice checkbox clicked" });
  await sleep(300);

  // Verify it got ticked
  const stillUnchecked = await page.evaluate(() => {
    const checkedImages = Array.from(document.querySelectorAll(`img[src*="checked-b672f"]`));
    return checkedImages.length === 0;
  });

  if (stillUnchecked) {
    sendMessage({ type: "log", level: "warn", message: "GST invoice checkbox may not have ticked — will continue anyway" });
  } else {
    sendMessage({ type: "log", level: "info", message: "GST invoice checkbox is now ticked" });
  }
}

// ----------------------------------------------------------------
// Helper: Check if address text matches expected address
// ----------------------------------------------------------------
function checkAddressMatch(text: string, address: AddressDetails): boolean {
  const lowerText = text.toLowerCase();
  const checks = [
    address.name.toLowerCase(),
    address.city.toLowerCase(),
    address.pincode,
    address.locality.toLowerCase(),
    address.addressLine1.toLowerCase().split(" ").slice(0, 2).join(" "),
  ];

  const matched = checks.filter((c) => c.length > 2 && lowerText.includes(c)).length;
  return matched >= 2;
}

main();
