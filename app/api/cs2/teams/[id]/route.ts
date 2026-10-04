import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { loadTeam } from "@/lib/cs2/queries";
import { CS2_NO_STORE, idParam, noCs2Db, windowFrom } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/teams/:id — trupp, kartpool, kommande och senaste matcher.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt lag-id" }, { status: 400 });
  const data = await loadTeam(cs2Prisma, id, windowFrom(new URL(req.url)));
  if (!data) return NextResponse.json({ error: "Laget finns inte" }, { status: 404 });
  return NextResponse.json({ dbConfigured: true, ...data }, CS2_NO_STORE);
}
