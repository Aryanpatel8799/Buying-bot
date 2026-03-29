import { Page } from "puppeteer-core";

export abstract class BasePayment {
  constructor(protected page: Page) {}

  abstract selectPaymentMethod(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract fillDetails(details: any): Promise<void>;
  abstract confirmPayment(): Promise<boolean>;
  abstract verifyPaymentSuccess(): Promise<boolean>;
  abstract isPaymentFailed(): Promise<boolean>;
}
