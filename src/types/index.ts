export type Platform = "amazon" | "flipkart";
export type PaymentMethod = "card" | "giftcard" | "rtgs";
export type JobStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type LogLevel = "info" | "warn" | "error";
export type UserRole = "admin" | "client";

export interface JobProgress {
  totalIterations: number;
  completedIterations: number;
  failedIterations: number;
  currentIteration: number;
}

export interface CardDetails {
  cardNumber: string;
  expiry: string;
  cvv: string;
}

export interface GiftCardDetails {
  code: string;
  pin?: string;
}

export interface RTGSDetails {
  bankName: string;
}

export type PaymentDetails = CardDetails | GiftCardDetails | RTGSDetails;

export interface ProductItem {
  url: string;
  quantity: number;
}

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
  checkoutPincode?: string; // override pincode at checkout time
}

export interface JobConfig {
  jobId: string;
  platform: Platform;
  paymentMethod: PaymentMethod;
  productUrl: string; // legacy single-URL (still used for single-product jobs)
  products: ProductItem[]; // multi-URL: each product with its own quantity
  totalQuantity: number;
  perOrderQuantity: number;
  intervalSeconds: number;
  chromeProfileDir: string;
  paymentDetails: PaymentDetails;
  cards?: CardDetails[]; // multiple cards for rotation across iterations
  accounts?: string[]; // decrypted Flipkart emails for account rotation
  address?: AddressDetails; // delivery address with GST for checkout verification
  maxConcurrentTabs?: number; // max simultaneous browser tabs for RTGS multi-tab mode (default: 1)
  giftCardInventoryId?: string; // gift card inventory for code rotation
  instaDdrAccounts?: InstaDdrAccount[]; // InstaDDR accounts for OTP automation
  instaDdrUrl?: string; // InstaDDR portal URL (defaults to https://m.kuku.lu)
}

export interface InstaDdrAccount {
  instaDdrId: string;
  instaDdrPassword: string;
  email: string; // the mail receiving Flipkart OTP
}

// IPC messages from runner child process to parent
export interface ProgressMessage {
  type: "progress";
  iteration: number;
  total: number;
  status: "success" | "failed";
}

export interface LogMessage {
  type: "log";
  level: LogLevel;
  message: string;
  iteration?: number;
  screenshot?: string;
}

export interface DoneMessage {
  type: "done";
  completed: number;
  failed: number;
}

export interface WaitingForOtpMessage {
  type: "waiting_for_otp";
  email: string;
  iteration: number;
}

export type RunnerMessage = ProgressMessage | LogMessage | DoneMessage | WaitingForOtpMessage;
