import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/db";
import { parseSlipsFromBuffer, importSlips } from "@/lib/bet365";
import { isAuthed, apiUnauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Where the bet365 account-statement PDF is read from. Override with BET365_PDF.
const PDF_PATH = process.env.BET365_PDF || "./statement.pdf";

// GET /api/import/bet365 — report the configured path + freshness for the UI.
export async function GET() {
  if (!isAuthed()) return apiUnauthorized();
  try {
    const stat = await fs.stat(PDF_PATH);
    return NextResponse.json({
      path: PDF_PATH,
      exists: true,
      modified: stat.mtime.toISOString(),
      sizeKb: Math.round(stat.size / 1024),
    });
  } catch {
    return NextResponse.json({ path: PDF_PATH, exists: false });
  }
}

// POST /api/import/bet365?wipe=1 — parse the PDF and import.
// Default is incremental (settle pending + add new); wipe=1 does a full reset.
export async function POST(req: Request) {
  if (!isAuthed()) return apiUnauthorized();
  const { searchParams } = new URL(req.url);
  const wipe = searchParams.get("wipe") === "1";

  let data: Uint8Array;
  try {
    data = new Uint8Array(await fs.readFile(PDF_PATH));
  } catch {
    return NextResponse.json(
      { ok: false, error: `Hittade ingen PDF på ${PDF_PATH}. Lägg kontoutdraget där, eller sätt BET365_PDF i .env.local.` },
      { status: 400 }
    );
  }

  try {
    const slips = await parseSlipsFromBuffer(data);
    const summary = await importSlips(prisma, slips, { wipe });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
