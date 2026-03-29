import mongoose, { Schema, Document, Model } from "mongoose";

export interface IChromeProfile extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  directoryName: string;
  platform: "amazon" | "flipkart" | "both";
  isLoggedIn: boolean;
  lastUsedAt: Date | null;
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
  },
  { timestamps: true }
);

const ChromeProfile: Model<IChromeProfile> =
  mongoose.models.ChromeProfile ||
  mongoose.model<IChromeProfile>("ChromeProfile", ChromeProfileSchema);

export default ChromeProfile;
