import mongoose, { Document, Schema } from "mongoose";

export interface IFlipkartAccount extends Document {
  userId: mongoose.Types.ObjectId;
  label: string;
  encryptedEmail: string; // AES-256-GCM encrypted email
  createdAt: Date;
  updatedAt: Date;
}

const FlipkartAccountSchema = new Schema<IFlipkartAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    encryptedEmail: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.models.FlipkartAccount ||
  mongoose.model<IFlipkartAccount>("FlipkartAccount", FlipkartAccountSchema);
