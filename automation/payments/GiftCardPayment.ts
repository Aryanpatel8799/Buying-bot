import { Page } from "puppeteer-core";
import { BasePayment } from "./BasePayment";
import { clearAndType, sleep, waitAndClick } from "../core/helpers";

interface GiftCardDetails {
  code: string;
  pin?: string;
}

export class GiftCardPayment extends BasePayment {
  private platform: "flipkart" | "amazon";

  constructor(page: Page, platform: "flipkart" | "amazon") {
    super(page);
    this.platform = platform;
  }

  async selectPaymentMethod(): Promise<void> {
    if (this.platform === "flipkart") {
      // Click the "Have a Flipkart Gift Card? Add" button
      console.log('Waiting for "Have a Flipkart Gift Card?" button ...');
      await this.page.waitForSelector("div.DF3_NF", {
        visible: true,
        timeout: 15000,
      });
      // Click the "Add" span inside the gift card section
      await this.page.evaluate(() => {
        const container = document.querySelector("div.DF3_NF");
        if (container) {
          const addBtn = container.querySelector("span.v_6Ifl");
          if (addBtn) {
            (addBtn as HTMLElement).click();
          } else {
            (container as HTMLElement).click();
          }
        }
      });
      console.log("Clicked Gift Card Add button");
      await sleep(300);

      // Click the gift card checkbox
      const checked = await this.page.evaluate(() => {
        const cb = document.querySelector("input.Checkbox-module_input-checkbox__3IlN4.CJ7EqD") as HTMLInputElement | null;
        if (cb && !cb.checked) {
          cb.click();
          return true;
        }
        return false;
      });
      if (checked) {
        console.log("Gift card checkbox ticked");
        await sleep(200);
      }
    } else {
      throw new Error("Amazon gift card payment selector not yet configured.");
    }
  }

  async fillDetails(details: GiftCardDetails): Promise<void> {
    if (this.platform === "flipkart") {
      // Enter voucher number
      await clearAndType(
        this.page,
        "#egvNumber",
        details.code,
        "Voucher Number"
      );
      await sleep(200);

      // Enter voucher PIN
      if (details.pin) {
        await clearAndType(this.page, "#pin", details.pin, "Voucher PIN");
        await sleep(200);
      }
    } else {
      throw new Error(
        `Amazon gift card input fields not yet configured. Code: ${details.code}`
      );
    }
  }

  async confirmPayment(): Promise<boolean> {
    if (this.platform === "flipkart") {
      // Click the "APPLY" button after entering gift card details
      console.log('Clicking "APPLY" for gift card ...');
      try {
        // Try clicking a button/div with text "APPLY" near the gift card inputs
        await this.page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll(
              "button, div[class*='semibold'], span[class*='semibold']"
            )
          );
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toUpperCase() || "";
            if (text === "APPLY") {
              (btn as HTMLElement).click();
              return;
            }
          }
        });
      } catch {
        // Fallback: try clicking submit-like button near gift card section
        await waitAndClick(
          this.page,
          'button[type="submit"]',
          "Gift Card Apply",
          10000
        );
      }
      console.log("Gift card applied");
      await sleep(500);

      // Now click "Place Order" / "PAY" button
      console.log("Clicking Place Order ...");
      try {
        await waitAndClick(
          this.page,
          'div[style*="background-color: rgb(255, 194, 0)"]',
          "Place Order button",
          15000
        );
      } catch {
        await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("div, button, span"));
          for (const btn of buttons) {
            const text = btn.textContent?.trim().toUpperCase() || "";
            if (
              text === "PLACE ORDER" ||
              text.includes("PAY ") ||
              text === "PAY"
            ) {
              (btn.closest("div[style*='cursor']") as HTMLElement)?.click();
              return;
            }
          }
        });
      }
      console.log("Payment confirmation clicked");
    } else {
      throw new Error("Amazon gift card confirmation not yet configured.");
    }
    return true;
  }

  async verifyPaymentSuccess(): Promise<boolean> {
    try {
      const success = await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("order confirmed") ||
          text.includes("order placed") ||
          text.includes("order successful")
        );
      });
      return success;
    } catch {
      return false;
    }
  }

  async isPaymentFailed(): Promise<boolean> {
    try {
      const failed = await this.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes("invalid gift card") ||
          text.includes("invalid voucher") ||
          text.includes("gift card expired") ||
          text.includes("insufficient balance") ||
          text.includes("payment failed")
        );
      });
      return failed;
    } catch {
      return false;
    }
  }
}
