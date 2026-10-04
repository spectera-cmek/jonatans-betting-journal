import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { searchPlayers } from "@/lib/cs2/queries";
import { noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/players?q=zyw — sök spelare på nick.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ dbConfigured: true, players: [] });
  return NextResponse.json({ dbConfigured: true, players: await searchPlayers(cs2Prisma, q) });
}
