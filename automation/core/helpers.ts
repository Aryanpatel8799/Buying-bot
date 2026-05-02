import { Page } from "puppeteer-core";

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a selector with retry + page refresh logic.
 * Waits `timeoutMs` for the element. If not found, refreshes the page
 * and retries. After `maxRetries` total attempts, throws.
 *
 * If `isPaymentPage` is provided and returns true, skips page refresh on failure
 * and instead waits up to 2 minutes — to avoid disrupting user input on payment pages.
 */
export async function waitWithRetry(
  page: Page,
  waitFn: () => Promise<void>,
  {
    label = "",
    timeoutMs = 10000,
    maxRetries = 5,
    isPaymentPage = undefined as (() => Promise<boolean>) | undefined,
  } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitFn();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `${label || "Element"} not found (attempt ${attempt}/${maxRetries}): ${msg}`
      );

      if (attempt < maxRetries) {
        // Check if we're on a payment page — if so, don't refresh, just wait
        let onPaymentPage = false;
        if (isPaymentPage) {
          try {
            onPaymentPage = await isPaymentPage();
          } catch { /* ignore */ }
        }

        if (onPaymentPage) {
          console.log(`On payment page — waiting 2 minutes instead of refreshing...`);
          await sleep(120_000); // 2 minutes
        } else {
          console.log(`Refreshing page and retrying...`);
          await sleep(500);
          try {
            await page.reload({ waitUntil: "networkidle2", timeout: 10000 });
          } catch {
            console.log(`Page refresh timed out on attempt ${attempt}, retrying anyway...`);
          }
          await sleep(300);
        }
      }
    }
  }

  throw new Error(
    `${label || "Element"} not found after ${maxRetries} attempts (each waited ${timeoutMs / 1000}s + page refresh)`
  );
}

export async function waitAndClick(
  page: Page,
  selector: string,
  label = "",
  timeout = 10000,
  maxRetries = 5,
  isPaymentPage?: () => Promise<boolean>
): Promise<void> {
  console.log(`Waiting for ${label || selector} ...`);

  await waitWithRetry(
    page,
    async () => {
      await page.waitForSelector(selector, { visible: true, timeout });
    },
    { label: label || selector, timeoutMs: timeout, maxRetries, isPaymentPage }
  );

  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.click();
    }
  }, selector);
  console.log(`Clicked ${label || selector}`);
}

export async function clearAndType(
  page: Page,
  selector: string,
  value: string,
  label = "",
  sensitive = false,
  isPaymentPage?: () => Promise<boolean>
): Promise<void> {
  console.log(`Typing into ${label || selector} ...`);

  await waitWithRetry(
    page,
    async () => {
      await page.waitForSelector(selector, { visible: true, timeout: 10000 });
    },
    { label: label || selector, timeoutMs: 10000, maxRetries: 5, isPaymentPage }
  );

  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.click();
    }
  }, selector);
  await sleep(100);

  // Select all existing text and delete it
  const isMac = process.platform === "darwin";
  if (isMac) {
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
  } else {
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
  }
  await page.keyboard.press("Backspace");
  await sleep(100);

  // Also clear via JS to be safe
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLInputElement;
    if (el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, selector);
  await sleep(50);

  // Type the value character by character. delay:50 is the sweet spot for
  // Flipkart's React-controlled inputs — anything faster (we used to be at
  // 20) and React drops the trailing keypresses, leaving the field with a
  // truncated value.
  await page.type(selector, value, { delay: 50 });
  // Wait long enough for React's onChange to flush before we verify.
  await sleep(300);

  // Verify the value was entered correctly. Loop up to 3 times so we recover
  // from React's "value reverted" race (it sometimes overwrites our chars
  // with its previous controlled-state value mid-typing).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const actualValue = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      return el?.value || "";
    }, selector);

    if (actualValue === value) break;

    const displayVal = sensitive ? "***" : value;
    const displayActual = sensitive ? "***" : actualValue;
    console.log(
      `Value mismatch on ${label || selector} (attempt ${attempt}/3): expected "${displayVal}" (${value.length} chars), got "${displayActual}" (${actualValue.length} chars). Re-applying via native setter...`
    );

    // Use the RIGHT prototype's value setter — `HTMLInputElement` doesn't
    // work for textareas, which is why the previous fallback silently
    // no-op'd on the address-line field. Pick the prototype matching the
    // element so React picks up the change properly via its synthetic
    // event system.
    await page.evaluate(
      (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return;
        const proto =
          el instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      },
      selector,
      value
    );
    await sleep(300);
  }

  // Final sanity check — log if we still couldn't get the right value so
  // the runner's screenshots have a clear trail.
  const finalValue = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
    return el?.value || "";
  }, selector);
  if (finalValue !== value) {
    const displayVal = sensitive ? "***" : value;
    const displayActual = sensitive ? "***" : finalValue;
    console.log(
      `WARNING: ${label || selector} ended with truncated/changed value: expected "${displayVal}" got "${displayActual}"`
    );
  }

  const displayValue = sensitive ? "***" : value;
  console.log(`Entered "${displayValue}" into ${label || selector}`);
}

type MessageListener = (msg: object) => void;
const listeners: MessageListener[] = [];

/**
 * Register a side-channel listener for sendMessage() calls. Used by runners
 * that also need to persist messages to a database (see giftCardJobReporter).
 * Returns an unsubscribe fn.
 */
export function onSendMessage(listener: MessageListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function sendMessage(msg: object): void {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {
    // Pipe closed — process is terminating
  }
  for (const l of listeners) {
    try {
      l(msg);
    } catch { /* swallow — listener errors must never break the runner */ }
  }
}

/**
 * Navigate to a URL with retry logic.
 * If the page doesn't load within `timeoutMs`, refreshes and retries.
 * After `maxRetries` failures, throws an error.
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  {
    timeoutMs = 10000,
    maxRetries = 5,
    waitUntil = "domcontentloaded" as const,
  } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Loading page (attempt ${attempt}/${maxRetries}, timeout ${timeoutMs / 1000}s)...`
      );
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      console.log(`Page loaded successfully on attempt ${attempt}`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Attempt ${attempt} failed: ${msg}`);

      if (attempt < maxRetries) {
        console.log(`Refreshing page...`);
        await sleep(500);
        try {
          await page.reload({ waitUntil, timeout: timeoutMs });
          console.log(`Page loaded after refresh on attempt ${attempt}`);
          return;
        } catch {
          console.log(`Refresh also failed on attempt ${attempt}`);
        }
      }
    }
  }

  throw new Error(
    `Page failed to load after ${maxRetries} attempts: ${url}`
  );
}

/**
 * Wraps an async operation with a timeout.
 * If the operation doesn't complete within `timeoutMs`, throws an error.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label = "Operation"
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Waits for any of multiple async conditions to succeed.
 * Returns the result of the first one that resolves. 
 * If all fail, throws the last error.
 */
export async function waitForAny<T>(
  fns: Array<() => Promise<T>>,
  label = "waitForAny"
): Promise<T> {
  let lastError: Error | null = null;
  return Promise.race(
    fns.map((fn) =>
      fn().catch((err) => {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Return a never-resolving promise so other branches can still win
        return new Promise<T>(() => {});
      })
    )
  ).then((result) => {
    if (result !== undefined) return result;
    throw lastError || new Error(`${label}: all conditions failed`);
  });
}

