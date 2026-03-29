import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/db/connect";
import User from "@/lib/db/models/User";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  // Rate limit: 5 requests per minute
  // Use last entry in x-forwarded-for to resist header spoofing
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",").pop()!.trim() : req.headers.get("x-real-ip") || "unknown";
  if (!checkRateLimit(`signup:${ip}`, 5, 5 / 60)) {
    return rateLimitResponse();
  }

  try {
    const { email, password, name } = await req.json();

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: "Email, password, and name are required" },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    await dbConnect();

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: "client",
    });

    return NextResponse.json(
      { message: "Account created successfully", userId: user._id },
      { status: 201 }
    );
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
