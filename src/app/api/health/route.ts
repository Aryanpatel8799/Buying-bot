import { NextResponse } from "next/server";
import dbConnect from "@/lib/db/connect";

export async function GET() {
  try {
    await dbConnect();
    return NextResponse.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    return NextResponse.json(
      { status: "error", message: "Database connection failed" },
      { status: 503 }
    );
  }
}
