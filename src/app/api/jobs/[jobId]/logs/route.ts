import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import Log from "@/lib/db/models/Log";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const { jobId } = await params;
  const userId = (session.user as { id: string }).id;

  // Verify job belongs to user
  const job = await Job.findOne({ _id: jobId, userId });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50", 10);
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    Log.find({ jobId }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    Log.countDocuments({ jobId }),
  ]);

  return NextResponse.json({
    logs,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
