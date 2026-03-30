import mongoose, { Schema, Document, Model } from "mongoose";

export interface IGiftCardInventoryCode {
  code: string;
  pin?: string;
  balance?: number;
  status: "available" | "used" | "failed";
  errorMessage?: string;
  addedAt: Date;
  usedAt?: Date;
}

export interface IGiftCardInventory extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  platform: "flipkart" | "amazon";
  codes: IGiftCardInventoryCode[];
  createdAt: Date;
  updatedAt: Date;
}

const GiftCardInventoryCodeSchema = new Schema<IGiftCardInventoryCode>(
  {
    code: { type: String, required: true },
    pin: { type: String, default: "" },
    balance: { type: Number, default: undefined },
    status: {
      type: String,
      enum: ["available", "used", "failed"],
      default: "available",
    },
    errorMessage: { type: String, default: "" },
    addedAt: { type: Date, default: Date.now },
    usedAt: { type: Date, default: undefined },
  },
  { _id: false }
);

const GiftCardInventorySchema = new Schema<IGiftCardInventory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      enum: ["flipkart", "amazon"],
      required: true,
    },
    codes: {
      type: [GiftCardInventoryCodeSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Compound index for efficient "next available code" queries
GiftCardInventorySchema.index({
  userId: 1,
  platform: 1,
  "codes.status": 1,
});

// Delete stale cached model so schema changes take effect in dev (hot reload)
delete mongoose.models.GiftCardInventory;
const GiftCardInventory: Model<IGiftCardInventory> = mongoose.model<IGiftCardInventory>(
  "GiftCardInventory",
  GiftCardInventorySchema
);

export default GiftCardInventory;
