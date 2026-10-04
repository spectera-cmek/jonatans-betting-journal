import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { buildMatchupView, loadMatchupContext, type LineInput } from "@/lib/cs2/matchup";
import { DEFAULT_CS2_BLEND_W } from "@/lib/cs2/pricing";
import { idParam, noCs2Db } from "@/lib/cs2/api";
import type { Cs2Market, Cs2Scope } from "@/lib/cs2/types";

export const dynamic = "force-dynamic";

// GET /api/cs2/matches/:id?w=0.5 — hela matchupen: veto, kartor, serie,
// spelarnas fördelningar, prissatta linjer och angles.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt match-id" }, { status: 400 });
  const raw = Number(new URL(req.url).searchParams.get("w"));
  const blendW = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_CS2_BLEND_W;

  const ctx = await loadMatchupContext(cs2Prisma, id);
  if (!ctx) {
    const m = await cs2Prisma.cs2Match.findUnique({ where: { id }, select: { team1Name: true, team2Name: true } });
    if (!m) return NextResponse.json({ error: "Matchen finns inte" }, { status: 404 });
    return NextResponse.json({ dbConfigured: true, pending: true, team1Name: m.team1Name, team2Name: m.team2Name });
  }
  const rows = await cs2Prisma.cs2Line.findMany({ where: { matchId: id }, orderBy: { createdAt: "desc" } });
  const lines: LineInput[] = rows.map((r) => ({
    id: r.id,
    market: r.market as Cs2Market,
    scope: r.scope as Cs2Scope,
    playerId: r.playerId,
    teamId: r.teamId,
    line: r.line,
    overOdds: r.overOdds,
    underOdds: r.underOdds,
    includesOt: r.includesOt,
    bookmaker: r.bookmaker,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));
  return NextResponse.json({ dbConfigured: true, ...buildMatchupView(ctx, lines, blendW) });
}
