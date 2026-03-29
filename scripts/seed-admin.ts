import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local manually since tsx doesn't auto-load it
const envPath = resolve(__dirname, "../.env.local");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        const value = trimmed.slice(eqIdx + 1);
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
} catch {
  // .env.local not found, use defaults
}

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/buying-platform";

async function seed() {
  await mongoose.connect(MONGODB_URI);

  const User = mongoose.model(
    "User",
    new mongoose.Schema({
      email: { type: String, required: true, unique: true },
      passwordHash: { type: String, required: true },
      name: { type: String, required: true },
      role: { type: String, default: "admin" },
    }, { timestamps: true })
  );

  const email = "admin@autobuy.com";
  const existing = await User.findOne({ email });

  if (existing) {
    console.log("Admin user already exists:", email);
  } else {
    const passwordHash = await bcrypt.hash("admin123", 12);
    await User.create({
      email,
      passwordHash,
      name: "Admin",
      role: "admin",
    });
    console.log("Admin user created:", email);
    console.log("Password: admin123");
  }

  await mongoose.disconnect();
}

seed().catch(console.error);
