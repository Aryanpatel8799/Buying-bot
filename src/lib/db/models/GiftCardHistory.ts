import mongoose, { Schema, Document, Model } from "mongoose";

export interface IGiftCardHistory extends Document {
  userId: mongoose.Types.ObjectId;
  cardNumber: string;
  encryptedPin: string;
  status: "success" | "failed" | "pending";
  errorMessage?: string;
  chromeProfileId: mongoose.Types.ObjectId;
  addedAt: Date;
}

const GiftCardHistorySchema = new Schema<IGiftCardHistory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    cardNumber: {
      type: String,
      required: true,
    },
    encryptedPin: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "pending",
    },
    errorMessage: {
      type: String,
      default: "",
    },
    chromeProfileId: {
      type: Schema.Types.ObjectId,
      ref: "ChromeProfile",
      required: true,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Compound index for duplicate detection
GiftCardHistorySchema.index({ userId: 1, cardNumber: 1 });

delete mongoose.models.GiftCardHistory;
const GiftCardHistory: Model<IGiftCardHistory> = mongoose.model<IGiftCardHistory>(
  "GiftCardHistory",
  GiftCardHistorySchema
);

export default GiftCardHistory;
