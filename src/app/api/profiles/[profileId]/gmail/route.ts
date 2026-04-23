import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import { getProfileDir, getChromePath } from "@/lib/platform/chromePaths";
import puppeteer from "puppeteer-core";
import { z } from "zod";

const connectSchema = z.object({
  gmailAddress: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid Gmail address"),
});

// POST /api/profiles/[profileId]/gmail — link a Gmail to this profile and
// launch Chrome so the user can log in manually. We trust the typed address
// (no DOM verification — per user preference).
export async function POST(
  req: NextRequest,
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

  let data: z.infer<typeof connectSchema>;
  try {
    const body = await req.json();
    data = connectSchema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    // Save the link first — if Chrome fails to launch on a headless VPS, the
    // user can still see/edit the stored address from the UI.
    await ChromeProfile.updateOne(
      { _id: profileId },
      {
        $set: {
          gmailAddress: data.gmailAddress,
          gmailConnectedAt: new Date(),
          lastUsedAt: new Date(),
        },
      }
    );

    const profileDir = getProfileDir(profile.directoryName);

    // Launch Chrome on the Gmail sign-in page so the user can log in.
    // Mirrors the setup route. Browser stays open for the user to close.
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: getChromePath(),
      userDataDir: profileDir,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.goto("https://mail.google.com", { waitUntil: "networkidle2" }).catch(() => { /* ignore */ });

    return NextResponse.json({
      message: "Gmail address saved. Chrome is open — log in manually, then close the browser.",
      gmailAddress: data.gmailAddress,
    });
  } catch (err) {
    console.error("Gmail connect error:", err);
    // We still saved the address above — surface a useful message.
    return NextResponse.json(
      {
        error: "Address saved, but failed to launch Chrome. Make sure Chrome is installed or sign in to Gmail manually in this profile.",
        gmailAddress: data.gmailAddress,
      },
      { status: 500 }
    );
  }
}

// DELETE /api/profiles/[profileId]/gmail — unlink the Gmail address.
export async function DELETE(
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

  const result = await ChromeProfile.updateOne(
    { _id: profileId, userId },
    { $set: { gmailAddress: null, gmailConnectedAt: null } }
  );

  if (result.matchedCount === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ message: "Gmail disconnected" });
}
