import mongoose, { Schema, Document, Model } from "mongoose";

export type GiftCardJobKind = "add" | "verify";
export type GiftCardJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface GiftCardJobLog {
  level: "info" | "warn" | "error";
  message: string;
  at: Date;
}

export interface GiftCardJobCardStatus {
  cardNumber: string;
  status: "added" | "not added" | "success" | "error";
  balance?: string;
  pin?: string;
  error?: string;
}

export interface IGiftCardJob extends Document {
  userId: mongoose.Types.ObjectId;
  kind: GiftCardJobKind;
  platform: "flipkart" | "amazon";
  status: GiftCardJobStatus;
  pid?: number | null;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  /** card-level results (appended as the runner progresses) */
  cardStatuses: GiftCardJobCardStatus[];
  /** log lines (appended as the runner progresses) */
  logs: GiftCardJobLog[];
  /** For add-jobs: the ordered GiftCardHistory ids the runner can update */
  historyIds?: string[];
  /** Set once when the runner finishes */
  errorMessage?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CardStatusSchema = new Schema<GiftCardJobCardStatus>(
  {
    cardNumber: { type: String, required: true },
    status: { type: String, required: true },
    balance: { type: String },
    pin: { type: String },
    error: { type: String },
  },
  { _id: false }
);

const LogSchema = new Schema<GiftCardJobLog>(
  {
    level: { type: String, enum: ["info", "warn", "error"], required: true },
    message: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const GiftCardJobSchema = new Schema<IGiftCardJob>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["add", "verify"], required: true },
    platform: { type: String, enum: ["flipkart", "amazon"], required: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },
    pid: { type: Number, default: null },
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    cardStatuses: { type: [CardStatusSchema], default: [] },
    logs: { type: [LogSchema], default: [] },
    historyIds: { type: [String], default: [] },
    errorMessage: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

GiftCardJobSchema.index({ userId: 1, createdAt: -1 });

delete mongoose.models.GiftCardJob;
const GiftCardJob: Model<IGiftCardJob> = mongoose.model<IGiftCardJob>(
  "GiftCardJob",
  GiftCardJobSchema
);

export default GiftCardJob;
