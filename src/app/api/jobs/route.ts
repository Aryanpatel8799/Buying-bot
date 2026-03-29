import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import Job from "@/lib/db/models/Job";
import ChromeProfile from "@/lib/db/models/ChromeProfile";
import SavedCard from "@/lib/db/models/SavedCard";
import FlipkartAccount from "@/lib/db/models/FlipkartAccount";
import SavedAddress from "@/lib/db/models/SavedAddress";
import { encrypt } from "@/lib/encryption";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { z } from "zod";

const productItemSchema = z.object({
  url: z.string().url(),
  quantity: z.number().int().positive(),
});

const createJobSchema = z.object({
  platform: z.enum(["amazon", "flipkart"]),
  paymentMethod: z.enum(["card", "giftcard", "rtgs"]),
  productUrl: z.string().optional().default(""), // legacy single URL
  products: z.array(productItemSchema).min(1), // at least 1 product
  totalQuantity: z.number().int().positive().optional(), // auto-calculated from products
  perOrderQuantity: z.number().int().positive(),
  intervalSeconds: z.number().min(0).default(10),
  chromeProfileId: z.string(),
  paymentDetails: z.record(z.string(), z.string()).optional(),
  cardIds: z.array(z.string()).optional(),
  accountIds: z.array(z.string()).optional(),
  addressIds: z.array(z.string()).optional(),
  checkoutPincode: z.string().optional(),
  maxConcurrentTabs: z.number().int().positive().optional(),
});

// GET /api/jobs — list user's jobs
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();

  const userId = (session.user as { id: string }).id;
  const jobs = await Job.find({ userId })
    .sort({ createdAt: -1 })
    .populate("chromeProfileId", "name platform")
    .lean();

  return NextResponse.json(jobs);
}

// POST /api/jobs — create a new job
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 10 requests per minute
  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`jobs:${userId}`, 10, 10 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    console.log("[CreateJob] Incoming body keys:", Object.keys(body));
    console.log("[CreateJob] addressIds:", body.addressIds);
    console.log("[CreateJob] checkoutPincode:", body.checkoutPincode);
    const data = createJobSchema.parse(body);
    console.log("[CreateJob] Parsed addressIds:", data.addressIds);
    console.log("[CreateJob] Parsed checkoutPincode:", data.checkoutPincode);

    // Block unsupported payment methods
    if (data.paymentMethod === "giftcard" && data.platform === "amazon") {
      return NextResponse.json(
        { error: "Amazon gift card payment is not yet supported" },
        { status: 400 }
      );
    }

    // Validate product URLs match the selected platform
    for (const p of data.products) {
      try {
        const domain = new URL(p.url).hostname;
        if (data.platform === "flipkart" && !domain.includes("flipkart.com")) {
          return NextResponse.json(
            { error: "Product URL must be a Flipkart URL" },
            { status: 400 }
          );
        }
        if (data.platform === "amazon" && !domain.includes("amazon.")) {
          return NextResponse.json(
            { error: "Product URL must be an Amazon URL" },
            { status: 400 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: "Invalid product URL" },
          { status: 400 }
        );
      }
    }

    // Always calculate totalQuantity from products — ignore user-supplied value
    const totalQuantity = data.totalQuantity ||
      data.products.reduce((sum, p) => sum + p.quantity, 0);

    if (data.perOrderQuantity > totalQuantity) {
      return NextResponse.json(
        { error: "Per-order quantity cannot exceed total quantity" },
        { status: 400 }
      );
    }

    await dbConnect();

    const userId = (session.user as { id: string }).id;

    // Validate chrome profile exists and belongs to user
    const profile = await ChromeProfile.findOne({
      _id: data.chromeProfileId,
      userId,
    });
    if (!profile) {
      return NextResponse.json(
        { error: "Chrome profile not found or doesn't belong to you" },
        { status: 400 }
      );
    }

    // Validate card rotation: if cardIds provided, verify they belong to user
    const useCardRotation = data.cardIds && data.cardIds.length > 0;
    if (useCardRotation) {
      const userCards = await SavedCard.find({
        _id: { $in: data.cardIds },
        userId,
      }).select("_id");
      if (userCards.length !== data.cardIds!.length) {
        return NextResponse.json(
          { error: "One or more selected cards not found" },
          { status: 400 }
        );
      }
    }

    // Validate account rotation: if accountIds provided, verify they belong to user and platform is flipkart
    const useAccountRotation = data.accountIds && data.accountIds.length > 0;
    if (useAccountRotation) {
      if (data.platform !== "flipkart") {
        return NextResponse.json(
          { error: "Account rotation is only supported for Flipkart" },
          { status: 400 }
        );
      }
      const userAccounts = await FlipkartAccount.find({
        _id: { $in: data.accountIds },
        userId,
      }).select("_id");
      if (userAccounts.length !== data.accountIds!.length) {
        return NextResponse.json(
          { error: "One or more selected accounts not found" },
          { status: 400 }
        );
      }
    }

    // Validate addressIds: if provided, verify they belong to user and platform is flipkart
    // For Flipkart jobs: if addressIds is not explicitly provided (undefined), auto-populate
    // the first saved address so GST verification always works if addresses exist.
    let addressIdsToStore: string[] = [];
    const hasExplicitAddressIds = data.addressIds !== undefined;

    if (data.addressIds && data.addressIds.length > 0) {
      // User explicitly selected addresses
      if (data.platform !== "flipkart") {
        return NextResponse.json(
          { error: "GST address selection is only supported for Flipkart" },
          { status: 400 }
        );
      }
      const userAddresses = await SavedAddress.find({
        _id: { $in: data.addressIds },
        userId,
      }).select("_id");
      if (userAddresses.length !== data.addressIds.length) {
        return NextResponse.json(
          { error: "One or more selected addresses not found" },
          { status: 400 }
        );
      }
      addressIdsToStore = data.addressIds;
    } else if (data.platform === "flipkart") {
      // Auto-populate: use first saved address if none explicitly selected
      const firstAddress = await SavedAddress.findOne({ userId }).select("_id");
      if (firstAddress) {
        console.log(`[CreateJob] No addressIds in request — auto-populating with first saved address: ${firstAddress._id}`);
        addressIdsToStore = [firstAddress._id.toString()];
      } else {
        console.log("[CreateJob] No addressIds in request and no saved addresses found — skipping GST verification");
      }
    }

    // Require either paymentDetails or cardIds for card payment
    if (data.paymentMethod === "card" && !useCardRotation && !data.paymentDetails) {
      return NextResponse.json(
        { error: "Card details or saved cards are required" },
        { status: 400 }
      );
    }

    const totalIterations = Math.ceil(totalQuantity / data.perOrderQuantity);

    console.log("[CreateJob] Storing with addressIds:", addressIdsToStore, "checkoutPincode:", data.checkoutPincode);

    const job = await Job.create({
      userId,
      platform: data.platform,
      paymentMethod: data.paymentMethod,
      productUrl: data.products[0]?.url || data.productUrl,
      products: data.products,
      totalQuantity,
      perOrderQuantity: data.perOrderQuantity,
      intervalSeconds: data.intervalSeconds,
      chromeProfileId: data.chromeProfileId,
      paymentDetails: data.paymentDetails
        ? encrypt(JSON.stringify(data.paymentDetails))
        : "",
      cardIds: useCardRotation ? data.cardIds : [],
      accountIds: useAccountRotation ? data.accountIds : [],
      addressIds: addressIdsToStore,
      checkoutPincode: data.checkoutPincode || "",
      maxConcurrentTabs: data.maxConcurrentTabs || 1,
      status: "pending",
      progress: {
        totalIterations,
        completedIterations: 0,
        failedIterations: 0,
        currentIteration: 0,
      },
    });

    console.log("[CreateJob] Stored job addressIds:", job.addressIds, "checkoutPincode:", job.checkoutPincode, "useExplicit:", hasExplicitAddressIds);

    // Also log as a structured object to make it easy to see in logs
    const stored = {
      _id: job._id?.toString(),
      platform: job.platform,
      addressIds: job.addressIds?.map((id: unknown) => id?.toString?.() ?? String(id)),
      checkoutPincode: job.checkoutPincode,
    };
    console.log("[CreateJob] Stored job summary:", JSON.stringify(stored));

    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("[CreateJob] Zod validation error:", error.issues);
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Create job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
