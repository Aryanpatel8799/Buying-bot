import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/getSession";
import dbConnect from "@/lib/db/connect";
import InstaDdrAccount from "@/lib/db/models/InstaDdrAccount";
import { encrypt } from "@/lib/encryption";
import mongoose from "mongoose";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/instaddr/[id]/bulk — CSV upload: instaDdrId,instaDdrPassword,email
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await getAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session.user as { id: string }).id;

  let csvText: string;
  try {
    const body = await req.json();
    csvText = body.csv as string;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!csvText || typeof csvText !== "string") {
    return NextResponse.json({ error: "Missing csv field" }, { status: 400 });
  }

  await dbConnect();

  const group = await InstaDdrAccount.findOne({ _id: id, userId });
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  // Parse CSV: instaDdrId,instaDdrPassword,email
  const lines = csvText.split("\n").map((l) => l.trim()).filter(Boolean);

  const errors: string[] = [];
  const accountsToAdd: any[] = [];
  const existingEmails = new Set(
    group.accounts.map((a: any) => {
      try {
        return decryptEmail(a.email);
      } catch {
        return "";
      }
    })
  );

  function decryptEmail(encrypted: string): string {
    const parts = encrypted.split(":");
    if (parts.length !== 3) return "";
    const decipher = require("crypto").createDecipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.ENCRYPTION_KEY || "", "hex"),
      Buffer.from(parts[0], "hex")
    );
    decipher.setAuthTag(Buffer.from(parts[1], "hex"));
    return decipher.update(parts[2], "hex", "utf8") + decipher.final("utf8");
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.startsWith("instaddrid") || line.startsWith("id") || line.startsWith("accountid")) {
      continue; // skip header
    }

    const parts = lines[i].split(",").map((p) => p.trim());
    if (parts.length < 3) {
      errors.push(`Row ${i + 1}: Expected 3 fields (instaDdrId,password,email), got ${parts.length}`);
      continue;
    }

    const [instaDdrId, instaDdrPassword, email] = parts;

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      errors.push(`Row ${i + 1}: Invalid email "${email}"`);
      continue;
    }

    // Skip duplicates
    if (existingEmails.has(email.toLowerCase())) {
      errors.push(`Row ${i + 1}: Duplicate email "${email}"`);
      continue;
    }

    existingEmails.add(email.toLowerCase());
    accountsToAdd.push({
      _id: new mongoose.Types.ObjectId(),
      instaDdrId,
      instaDdrPassword: encrypt(instaDdrPassword),
      email: encrypt(email.toLowerCase()),
      createdAt: new Date(),
    });
  }

  let inserted = 0;
  if (accountsToAdd.length > 0) {
    group.accounts.push(...accountsToAdd as any);
    await group.save();
    inserted = accountsToAdd.length;
  }

  return NextResponse.json({
    inserted,
    skipped: accountsToAdd.length === 0 && errors.length > 0 ? errors.length : 0,
    errors: errors.length > 0 ? errors : undefined,
  });
}
