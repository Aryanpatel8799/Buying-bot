import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import GiftCardInventory from "@/lib/db/models/GiftCardInventory";

interface Params {
  params: Promise<{ id: string }>;
}

interface ParsedCode {
  code: string;
  pin: string;
}

/**
 * Parse a CSV string with columns: code,pin (header row optional)
 * Returns array of {code, pin} objects. Skips empty rows and malformed lines.
 */
function parseCSV(csvText: string): ParsedCode[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Detect if first line is a header
  const firstLine = lines[0]?.toLowerCase() ?? "";
  const hasHeader = firstLine.startsWith("code") || firstLine.startsWith("card");
  const startIdx = hasHeader ? 1 : 0;

  const results: ParsedCode[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Support comma-separated or tab-separated
    const parts = line.includes("\t") ? line.split("\t") : line.split(",");
    const code = (parts[0] ?? "").trim().replace(/[\s-]/g, "");
    const pin = (parts[1] ?? "").trim().replace(/[\s-]/g, "");

    if (!code) continue;

    results.push({ code, pin });
  }
  return results;
}

// POST /api/giftcards/inventory/[id]/bulk — CSV upload to add codes
export async function POST(req: NextRequest, { params }: Params) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;
  await dbConnect();

  const inventory = await GiftCardInventory.findOne({ _id: id, userId });
  if (!inventory) {
    return NextResponse.json({ error: "Inventory not found" }, { status: 404 });
  }

  try {
    let csvText: string;

    // Support JSON body with csvText field OR multipart/form-data
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      csvText = body.csvText ?? body.csv ?? "";
    } else if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      csvText = await file.text();
    } else {
      return NextResponse.json({ error: "Unsupported content type" }, { status: 400 });
    }

    if (!csvText.trim()) {
      return NextResponse.json({ error: "CSV content is empty" }, { status: 400 });
    }

    const parsed = parseCSV(csvText);
    if (parsed.length === 0) {
      return NextResponse.json({ error: "No valid codes found in CSV" }, { status: 400 });
    }

    // Filter out duplicates (by code) within this upload
    const existingCodes = new Set(inventory.codes.map((c) => c.code));
    const newCodes: ParsedCode[] = [];
    let skipped = 0;

    for (const entry of parsed) {
      if (existingCodes.has(entry.code)) {
        skipped++;
      } else {
        newCodes.push(entry);
        existingCodes.add(entry.code); // prevent duplicates within the batch too
      }
    }

    const now = new Date();
    for (const entry of newCodes) {
      inventory.codes.push({
        code: entry.code,
        pin: entry.pin,
        status: "available",
        addedAt: now,
      });
    }

    await inventory.save();

    return NextResponse.json({
      success: true,
      added: newCodes.length,
      skipped,
      totalCodes: inventory.codes.length,
    });
  } catch (error) {
    console.error("CSV bulk upload error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
