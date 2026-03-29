import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { getChromePath } from "@/lib/platform/chromePaths";
import puppeteer from "puppeteer-core";

// POST /api/profiles/[profileId]/setup — launch Chrome for manual login
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const { profileId } = await params;
  const userId = (session.user as { id: string }).id;

  const profile = await ChromeProfile.findOne({ _id: profileId, userId });
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  try {
    const profileDir = getProfileDir(profile.directoryName);

    // Launch Chrome with the profile for manual login
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: getChromePath(),
      userDataDir: profileDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      defaultViewport: null,
    });

    const page = await browser.newPage();

    // Navigate to the platform's login page
    const loginUrl =
      profile.platform === "amazon" || profile.platform === "both"
        ? "https://www.amazon.in"
        : "https://www.flipkart.com";

    await page.goto(loginUrl, { waitUntil: "networkidle2" });

    // Update profile status
    await ChromeProfile.updateOne(
      { _id: profileId },
      { isLoggedIn: true, lastUsedAt: new Date() }
    );

    // NOTE: Browser stays open for user to login manually.
    // They close it when done. The session persists in the profile directory.

    return NextResponse.json({
      message: "Chrome launched. Please log in manually and close the browser when done.",
    });
  } catch (error) {
    console.error("Profile setup error:", error);
    return NextResponse.json(
      { error: "Failed to launch Chrome. Make sure Chrome is installed." },
      { status: 500 }
    );
  }
}
