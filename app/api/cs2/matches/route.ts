import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { listUpcoming } from "@/lib/cs2/queries";
import { CS2_NO_STORE, noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/matches?days=7 — kommande matcher med datatäckning per lag.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(30, raw) : 7;
  const matches = await listUpcoming(cs2Prisma, days);
  return NextResponse.json({ dbConfigured: true, matches }, CS2_NO_STORE);
}
