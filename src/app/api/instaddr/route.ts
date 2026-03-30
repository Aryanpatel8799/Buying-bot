import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { z } from "zod";

const createSchema = z.object({
  label: z.string().min(1).max(200),
  platform: z.enum(["flipkart"]).default("flipkart"),
});

// GET /api/instaddr — list all InstaDDR account groups
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const groups = await InstaDdrAccount.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  // Return masked summaries
  const summaries = groups.map((g: any) => ({
    _id: g._id.toString(),
    label: g.label,
    platform: g.platform,
    totalAccounts: g.accounts.length,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));

  return NextResponse.json(summaries);
}

// POST /api/instaddr — create a new InstaDDR account group
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`instaddr:${userId}`, 20, 20)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    await dbConnect();
    const group = await InstaDdrAccount.create({
      userId,
      label: data.label.trim(),
      platform: data.platform,
      accounts: [],
    });

    return NextResponse.json(
      {
        _id: group._id.toString(),
        label: group.label,
        platform: group.platform,
        totalAccounts: 0,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Create InstaDDR group error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
