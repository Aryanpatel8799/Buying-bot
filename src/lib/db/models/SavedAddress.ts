import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISavedAddress extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  mobile: string;
  pincode: string;
  locality: string;
  addressLine1: string;
  city: string;
  state: string;
  addressType: "Home" | "Work";
  gstNumber: string;
  companyName: string;
  createdAt: Date;
  updatedAt: Date;
}

const SavedAddressSchema = new Schema<ISavedAddress>(
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
      maxlength: 100,
    },
    mobile: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10,
      minlength: 10,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
      maxlength: 6,
      minlength: 6,
    },
    locality: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    addressLine1: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    city: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    state: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    addressType: {
      type: String,
      enum: ["Home", "Work"],
      required: true,
    },
    gstNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 15,
      minlength: 15,
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
  },
  { timestamps: true }
);

// Compound index for duplicate GST detection per user
SavedAddressSchema.index({ userId: 1, gstNumber: 1 });

delete mongoose.models.SavedAddress;
const SavedAddress: Model<ISavedAddress> = mongoose.model<ISavedAddress>(
  "SavedAddress",
  SavedAddressSchema
);

export default SavedAddress;
