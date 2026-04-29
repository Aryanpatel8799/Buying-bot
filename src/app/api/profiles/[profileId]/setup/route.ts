import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import { getProfileDir } from "@/lib/platform/chromePaths";
import { getChromePath } from "@/lib/platform/chromePaths";
import { displayManager } from "@/lib/display/displayManager";
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

  // Allocate a per-session display so multiple users can run profile-setup
  // (and watch via noVNC) without colliding.
  const slot = await displayManager.allocate();

  try {
    const profileDir = getProfileDir(profile.directoryName);

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: getChromePath(),
      userDataDir: profileDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      defaultViewport: null,
      ...(slot ? { env: { ...process.env, DISPLAY: slot.displayString } } : {}),
    });

    // Release the display the moment the user closes the Chrome window.
    if (slot) {
      browser.on("disconnected", () => {
        displayManager.release(slot.display).catch(() => { /* ignore */ });
      });
    }

    const page = await browser.newPage();

    const loginUrl =
      profile.platform === "amazon" || profile.platform === "both"
        ? "https://www.amazon.in"
        : "https://www.flipkart.com";
    await page.goto(loginUrl, { waitUntil: "networkidle2" }).catch(() => { /* ignore */ });

    await ChromeProfile.updateOne(
      { _id: profileId },
      { isLoggedIn: true, lastUsedAt: new Date() }
    );

    return NextResponse.json({
      message: "Chrome launched. Please log in manually and close the browser when done.",
      noVncUrl: slot?.noVncUrl ?? null,
    });
  } catch (error) {
    if (slot) await displayManager.release(slot.display);
    console.error("Profile setup error:", error);
    return NextResponse.json(
      { error: "Failed to launch Chrome. Make sure Chrome is installed." },
      { status: 500 }
    );
  }
}
