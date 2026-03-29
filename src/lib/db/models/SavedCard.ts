import mongoose, { Document, Schema } from "mongoose";

export interface ISavedCard extends Document {
  userId: mongoose.Types.ObjectId;
  label: string;
  encryptedDetails: string; // AES-256-GCM encrypted JSON: {cardNumber, expiry, cvv}
  createdAt: Date;
  updatedAt: Date;
}

const SavedCardSchema = new Schema<ISavedCard>(
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
    encryptedDetails: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.models.SavedCard ||
  mongoose.model<ISavedCard>("SavedCard", SavedCardSchema);
