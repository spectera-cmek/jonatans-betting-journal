import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { listTeams } from "@/lib/cs2/queries";
import { CS2_NO_STORE, noCs2Db, windowFrom } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/teams — bevakade lag och lag med kartor i perioden.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const { months } = windowFrom(new URL(req.url));
  const teams = await listTeams(cs2Prisma, months);
  return NextResponse.json({ dbConfigured: true, teams }, CS2_NO_STORE);
}
