import mongoose, { Schema, Document, Model } from "mongoose";

export interface IProductItem {
  url: string;
  quantity: number;
}

export interface IJob extends Document {
  userId: mongoose.Types.ObjectId;
  platform: "amazon" | "flipkart";
  paymentMethod: "card" | "giftcard" | "rtgs";
  productUrl: string; // legacy single-URL field
  products: IProductItem[]; // multi-URL with per-item quantities
  totalQuantity: number;
  perOrderQuantity: number;
  intervalSeconds: number;
  chromeProfileId: mongoose.Types.ObjectId;
  paymentDetails: string; // AES-256-GCM encrypted JSON
  cardIds: mongoose.Types.ObjectId[]; // saved cards for rotation
  accountIds: mongoose.Types.ObjectId[]; // Flipkart accounts for rotation
  addressIds: mongoose.Types.ObjectId[]; // saved addresses for GST address verification
  checkoutPincode: string;
  maxConcurrentTabs: number; // max simultaneous tabs for RTGS multi-tab mode
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  progress: {
    totalIterations: number;
    completedIterations: number;
    failedIterations: number;
    currentIteration: number;
  };
  pid: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const JobSchema = new Schema<IJob>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["amazon", "flipkart"],
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ["card", "giftcard", "rtgs"],
      required: true,
    },
    productUrl: {
      type: String,
      default: "",
    },
    products: {
      type: [
        {
          url: { type: String, required: true },
          quantity: { type: Number, required: true, min: 1 },
        },
      ],
      default: [],
    },
    totalQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    perOrderQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    intervalSeconds: {
      type: Number,
      required: true,
      default: 10,
      min: 0,
    },
    chromeProfileId: {
      type: Schema.Types.ObjectId,
      ref: "ChromeProfile",
      required: true,
    },
    paymentDetails: {
      type: String,
      default: "",
    },
    cardIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "SavedCard" }],
      default: [],
    },
    accountIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "FlipkartAccount" }],
      default: [],
    },
    addressIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "SavedAddress" }],
      default: [],
    },
    checkoutPincode: {
      type: String,
      default: "",
    },
    maxConcurrentTabs: {
      type: Number,
      default: 1,
      min: 1,
    },
    status: {
      type: String,
      enum: ["pending", "running", "paused", "completed", "failed", "cancelled"],
      default: "pending",
    },
    progress: {
      totalIterations: { type: Number, default: 0 },
      completedIterations: { type: Number, default: 0 },
      failedIterations: { type: Number, default: 0 },
      currentIteration: { type: Number, default: 0 },
    },
    pid: {
      type: Number,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Delete stale cached model so schema changes take effect in dev (hot reload)
delete mongoose.models.Job;
const Job: Model<IJob> = mongoose.model<IJob>("Job", JobSchema);

export default Job;
