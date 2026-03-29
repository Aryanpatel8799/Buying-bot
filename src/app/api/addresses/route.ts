import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import SavedAddress from "@/lib/db/models/SavedAddress";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { z } from "zod";

const addAddressSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  mobile: z
    .string()
    .min(1, "Mobile number is required")
    .max(10, "Mobile number must be exactly 10 digits")
    .regex(/^\d{10}$/, "Mobile number must be exactly 10 digits"),
  pincode: z
    .string()
    .min(1, "Pincode is required")
    .max(6, "Pincode must be exactly 6 digits")
    .regex(/^\d{6}$/, "Pincode must be exactly 6 digits"),
  locality: z.string().min(1, "Locality is required").max(200),
  addressLine1: z.string().min(1, "Address is required").max(300),
  city: z.string().min(1, "City is required").max(100),
  state: z.string().min(1, "State is required").max(100),
  addressType: z.enum(["Home", "Work"]),
  gstNumber: z.string().min(1, "GST number is required").max(30),
  companyName: z.string().min(1, "Company name is required").max(200),
});

// GET /api/addresses — list user's saved addresses
export async function GET() {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await dbConnect();
  const userId = (session.user as { id: string }).id;

  const addresses = await SavedAddress.find({ userId })
    .select("_id name mobile pincode locality addressLine1 city state addressType gstNumber companyName createdAt")
    .sort({ createdAt: -1 })
    .lean();

  // Mask GST number and mobile before returning
  const masked = addresses.map((addr) => ({
    _id: addr._id,
    name: addr.name,
    maskedMobile: addr.mobile.slice(0, 3) + "*****" + addr.mobile.slice(-2),
    pincode: addr.pincode,
    locality: addr.locality,
    addressLine1: addr.addressLine1,
    city: addr.city,
    state: addr.state,
    addressType: addr.addressType,
    maskedGstNumber: addr.gstNumber.slice(0, 2) + "*".repeat(11) + addr.gstNumber.slice(-2),
    gstNumber: addr.gstNumber,
    companyName: addr.companyName,
    createdAt: addr.createdAt,
  }));

  return NextResponse.json(masked);
}

// POST /api/addresses — add a single saved address
export async function POST(req: NextRequest) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!checkRateLimit(`addresses:${userId}`, 20, 20 / 60)) {
    return rateLimitResponse();
  }

  try {
    const body = await req.json();
    const data = addAddressSchema.parse(body);

    await dbConnect();

    const address = await SavedAddress.create({
      userId,
      ...data,
    });

    return NextResponse.json(
      {
        _id: address._id,
        name: address.name,
        maskedGstNumber:
          address.gstNumber.slice(0, 2) + "*".repeat(11) + address.gstNumber.slice(-2),
        maskedMobile: address.mobile.slice(0, 3) + "*****" + address.mobile.slice(-2),
        companyName: address.companyName,
        addressType: address.addressType,
        createdAt: address.createdAt,
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
    console.error("Add address error:", error);
    return NextResponse.json(
      { error: "Failed to add address" },
      { status: 500 }
    );
  }
}
