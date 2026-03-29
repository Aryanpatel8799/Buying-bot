import mongoose, { Schema, Document, Model } from "mongoose";

export interface ILog extends Document {
  jobId: mongoose.Types.ObjectId;
  iteration: number;
  level: "info" | "warn" | "error";
  message: string;
  screenshotPath: string | null;
  timestamp: Date;
}

const LogSchema = new Schema<ILog>({
  jobId: {
    type: Schema.Types.ObjectId,
    ref: "Job",
    required: true,
    index: true,
  },
  iteration: {
    type: Number,
    required: true,
  },
  level: {
    type: String,
    enum: ["info", "warn", "error"],
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  screenshotPath: {
    type: String,
    default: null,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

const Log: Model<ILog> =
  mongoose.models.Log || mongoose.model<ILog>("Log", LogSchema);

export default Log;
