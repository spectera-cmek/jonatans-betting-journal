import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { loadGameplan, teamMapNames } from "@/lib/cs2/queries";
import { canonicalMap } from "@/lib/cs2/maps";
import { CS2_NO_STORE, idParam, noCs2Db, windowFrom } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/teams/:id/gameplan?map=mirage&side=t&maps=10&months=6&vs=<lag-id>
// Docen för ett lag, en karta och en sida. Utan ?map väljs lagets mest spelade.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt lag-id" }, { status: 400 });
  const url = new URL(req.url);
  const window = windowFrom(url);
  const maps = await teamMapNames(cs2Prisma, id, window.months);
  const map = canonicalMap(url.searchParams.get("map")) ?? maps[0] ?? null;
  if (!map) return NextResponse.json({ dbConfigured: true, maps, report: null, notes: {} });
  const side = url.searchParams.get("side") === "ct" ? "ct" : "t";
  const vs = idParam(url.searchParams.get("vs") ?? "");
  const data = await loadGameplan(cs2Prisma, id, map, side, window, vs);
  if (!data) return NextResponse.json({ error: "Laget finns inte" }, { status: 404 });
  return NextResponse.json({ dbConfigured: true, maps, ...data }, CS2_NO_STORE);
}
