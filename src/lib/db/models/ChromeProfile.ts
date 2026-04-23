import mongoose, { Schema, Document, Model } from "mongoose";

export interface IChromeProfile extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  directoryName: string;
  platform: "amazon" | "flipkart" | "both";
  isLoggedIn: boolean;
  lastUsedAt: Date | null;
  /** Gmail address linked to this Chrome profile for OTP fetching */
  gmailAddress: string | null;
  /** Timestamp when Gmail was connected (user logged in manually in this profile) */
  gmailConnectedAt: Date | null;
  createdAt: Date;
}

const ChromeProfileSchema = new Schema<IChromeProfile>(
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
      trim: true,
    },
    directoryName: {
      type: String,
      required: true,
      unique: true,
    },
    platform: {
      type: String,
      enum: ["amazon", "flipkart", "both"],
      default: "both",
    },
    isLoggedIn: {
      type: Boolean,
      default: false,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    gmailAddress: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },
    gmailConnectedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Delete stale cached model so new fields take effect in dev hot-reload
delete mongoose.models.ChromeProfile;
const ChromeProfile: Model<IChromeProfile> = mongoose.model<IChromeProfile>(
  "ChromeProfile",
  ChromeProfileSchema
);

export default ChromeProfile;
