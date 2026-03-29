import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

// GET /api/profiles — list user's chrome profiles
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const profiles = await ChromeProfile.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  return NextResponse.json(profiles);
}

// POST /api/profiles — create a new chrome profile
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { name, platform } = await req.json();

    if (!name) {
      return NextResponse.json(
        { error: "Profile name is required" },
        { status: 400 }
      );
    }

    await dbConnect();
    const userId = (session.user as { id: string }).id;

    // Generate unique directory name
    const directoryName = `profile-${uuidv4().slice(0, 8)}`;

    // Create profile directory
    const profilesDir = process.env.CHROME_PROFILES_DIR || "./chrome-profiles";
    const profilePath = path.resolve(profilesDir, directoryName);
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    const profile = await ChromeProfile.create({
      userId,
      name,
      directoryName,
      platform: platform || "both",
      isLoggedIn: false,
    });

    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    console.error("Create profile error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
