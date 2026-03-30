import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import SavedCard from "@/lib/db/models/SavedCard";
import FlipkartAccount from "@/lib/db/models/FlipkartAccount";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

// POST /api/jobs/[jobId]/rerun — clone a job and create a fresh copy
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;

  // Rate limit: 10 reruns per minute
  if (!checkRateLimit(`jobs-rerun:${userId}`, 10, 10 / 60)) {
    return rateLimitResponse();
  }

  await dbConnect();
  const { jobId } = await params;

  const originalJob = await Job.findOne({ _id: jobId, userId });
  if (!originalJob) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  console.log(`[rerun] originalJob instaDdrAccountIds:`, JSON.stringify(originalJob.instaDdrAccountIds));
  console.log(`[rerun] originalJob accountIds:`, JSON.stringify(originalJob.accountIds));
  console.log(`[rerun] originalJob cardIds:`, JSON.stringify(originalJob.cardIds));

  // Validate referenced resources still exist
  const profile = await ChromeProfile.findOne({ _id: originalJob.chromeProfileId, userId });
  if (!profile) {
    return NextResponse.json(
      { error: "Original Chrome profile no longer exists" },
      { status: 400 }
    );
  }

  if (originalJob.cardIds && originalJob.cardIds.length > 0) {
    const cardCount = await SavedCard.countDocuments({
      _id: { $in: originalJob.cardIds },
      userId,
    });
    if (cardCount !== originalJob.cardIds.length) {
      return NextResponse.json(
        { error: "One or more saved cards from the original job no longer exist" },
        { status: 400 }
      );
    }
  }

  if (originalJob.accountIds && originalJob.accountIds.length > 0) {
    const accountCount = await FlipkartAccount.countDocuments({
      _id: { $in: originalJob.accountIds },
      userId,
    });
    if (accountCount !== originalJob.accountIds.length) {
      return NextResponse.json(
        { error: "One or more accounts from the original job no longer exist" },
        { status: 400 }
      );
    }
  }

  if (originalJob.instaDdrAccountIds && originalJob.instaDdrAccountIds.length > 0) {
    const groupCount = await InstaDdrAccount.countDocuments({
      _id: { $in: originalJob.instaDdrAccountIds },
      userId,
    });
    if (groupCount !== originalJob.instaDdrAccountIds.length) {
      return NextResponse.json(
        { error: "One or more InstaDDR groups from the original job no longer exist" },
        { status: 400 }
      );
    }
  }

  const totalIterations = Math.ceil(
    originalJob.totalQuantity / originalJob.perOrderQuantity
  );

  const newJob = await Job.create({
    userId,
    platform: originalJob.platform,
    paymentMethod: originalJob.paymentMethod,
    productUrl: originalJob.productUrl,
    products: originalJob.products || [],
    totalQuantity: originalJob.totalQuantity,
    perOrderQuantity: originalJob.perOrderQuantity,
    intervalSeconds: originalJob.intervalSeconds,
    chromeProfileId: originalJob.chromeProfileId,
    paymentDetails: originalJob.paymentDetails, // already encrypted
    cardIds: originalJob.cardIds || [],
    accountIds: originalJob.accountIds || [],
    instaDdrAccountIds: originalJob.instaDdrAccountIds || [],
    giftCardInventoryId: originalJob.giftCardInventoryId || undefined,
    checkoutPincode: originalJob.checkoutPincode || "",
    maxConcurrentTabs: originalJob.maxConcurrentTabs,
    addressIds: originalJob.addressIds || [],
    status: "pending",
    progress: {
      totalIterations,
      completedIterations: 0,
      failedIterations: 0,
      currentIteration: 0,
    },
  });

  return NextResponse.json(newJob, { status: 201 });
}
