import { Page } from "puppeteer-core";

/** InstaDDR account credentials */
export interface InstaDdrAccount {
  instaDdrId: string;
  instaDdrPassword: string;
  email: string;
}

/** Minimal interface for an OTP provider (InstaDdrService, GmailOtpService, …) */
export interface InstaDdrServiceLike {
  login(id: string, password: string): Promise<void>;
  logout(): Promise<void>;
  fetchOtp(credentials: { instaDdrId: string; instaDdrPassword: string; email: string }): Promise<string>;
  /** Navigate to the OTP provider and wait for the user to log in manually. */
  waitForManualLogin(id: string, password: string): Promise<void>;
  /** Release any resources held by the service (page, isolated context, etc.). */
  close(): Promise<void>;
}

/** Options passed to loginWithEmail for InstaDDR OTP automation */
export interface InstaDdrLoginOptions {
  instaDdrService?: InstaDdrServiceLike;
  instaDdrAccount?: InstaDdrAccount;
}

/** Delivery address details with GST invoice information */
export interface AddressDetails {
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
  /** Override pincode used at checkout (falls back to pincode if not set) */
  checkoutPincode?: string;
}

export abstract class BasePlatform {
  constructor(
    protected page: Page,
    protected productUrl: string
  ) {}

  /** If true, setQuantity() runs before clickBuyNow() (e.g. Amazon) */
  quantityBeforeBuy = false;

  /** Update the product URL (used in multi-URL flow) */
  setProductUrl(url: string): void {
    this.productUrl = url;
  }

  abstract navigateToProduct(): Promise<void>;
  abstract clickBuyNow(): Promise<void>;
  abstract setQuantity(qty: number): Promise<void>;
  abstract proceedToCheckout(): Promise<void>;
  abstract isOrderConfirmationVisible(): Promise<boolean>;
  abstract isPaymentPage(): Promise<boolean>;

  /** Add current product to cart (multi-URL flow) */
  async addToCart(): Promise<void> {
    throw new Error("addToCart not implemented for this platform");
  }

  /** Navigate to cart page (multi-URL flow) */
  async goToCart(): Promise<void> {
    throw new Error("goToCart not implemented for this platform");
  }

  /** Set quantity for a specific item in the cart page (multi-URL flow) */
  async setCartItemQuantity(itemIndex: number, qty: number): Promise<void> {
    throw new Error("setCartItemQuantity not implemented for this platform");
  }

  /** Click Place Order in cart (multi-URL flow) */
  async placeOrder(): Promise<void> {
    throw new Error("placeOrder not implemented for this platform");
  }

  /** Reset browser state between iterations — navigate to homepage, dismiss popups, clear cart */
  async resetForNextIteration(): Promise<void> {
    // Default: just navigate to homepage. Subclasses can override for platform-specific cleanup.
  }

  /** Login with email (account rotation). OTP entered by human. */
  async loginWithEmail(_email: string, _options?: InstaDdrLoginOptions): Promise<void> {
    throw new Error("loginWithEmail not implemented for this platform");
  }

  /** Wait for login to complete after OTP entry */
  async waitForLoginCompletion(_timeoutMs?: number): Promise<boolean> {
    throw new Error("waitForLoginCompletion not implemented for this platform");
  }

  /** Logout current account */
  async logout(): Promise<void> {
    throw new Error("logout not implemented for this platform");
  }

  /**
   * Verify and fix the delivery address and GST invoice details on the checkout page.
   * Only applicable for Flipkart (Amazon has separate address management).
   * If address data is provided, checks the current address on checkout and updates if needed.
   */
  async verifyAddressOnCheckout(_address?: AddressDetails): Promise<void> {
    // Default: no-op for platforms that don't support this
  }

  /** Extract order details from the confirmation page after a successful order */
  async extractOrderDetails(): Promise<OrderDetails> {
    return {
      orderId: "",
      model: "",
      colour: "",
      quantity: 0,
      pinCode: "",
      amount: "",
      perPc: "",
      orderDate: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    };
  }
}

export interface OrderDetails {
  orderId: string;
  model: string;
  colour: string;
  quantity: number;
  pinCode: string;
  amount: string;
  perPc: string;
  orderDate: string;
}
