import mongoose, { Schema, Document, Model } from "mongoose";

export interface IInstaDdrAccount extends Document {
  userId: mongoose.Types.ObjectId;
  label: string;
  platform: "flipkart";
  accounts: Array<{
    _id: mongoose.Types.ObjectId;
    instaDdrId: string;
    instaDdrPassword: string; // AES-256-GCM encrypted
    email: string; // AES-256-GCM encrypted
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const InstaDdrAccountEntrySchema = new Schema<any>(
  {
    instaDdrId: { type: String, required: true },
    instaDdrPassword: { type: String, required: true },
    email: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const InstaDdrAccountSchema = new Schema<IInstaDdrAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: { type: String, required: true, trim: true },
    platform: {
      type: String,
      enum: ["flipkart"],
      required: true,
      default: "flipkart",
    },
    accounts: { type: [InstaDdrAccountEntrySchema], default: [] },
  },
  { timestamps: true }
);

// Delete stale cached model so schema changes take effect in dev (hot reload)
delete mongoose.models.InstaDdrAccount;
const InstaDdrAccount: Model<IInstaDdrAccount> = mongoose.model<IInstaDdrAccount>(
  "InstaDdrAccount",
  InstaDdrAccountSchema
);

export default InstaDdrAccount;
