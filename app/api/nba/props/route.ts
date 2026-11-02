import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { nbaPrisma, hasNbaDb } from "@/lib/nbaDb";
import { noNbaDb } from "@/lib/nba/api";
import { NBA_EDGE_THRESHOLD, NBA_MAX_FLAG_ODDS } from "@/lib/nba/params";
import { PROP_STATS } from "@/lib/nba/props";

export const dynamic = "force-dynamic";

// GET /api/nba/props?days=2 — modellens props för kommande matcher (sparade
// av npm run nba:update), med bästa linjen om det finns en, och facit för
// spelade props.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const days = Math.min(7, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 2));
  const now = Date.now();
  const [rows, settled, players, teams] = await Promise.all([
    nbaPrisma.nbaPropProjection.findMany({
      where: { game: { status: "scheduled", startAt: { gte: new Date(now - 4 * 3600e3), lte: new Date(now + days * 864e5) } } },
      include: { game: { select: { id: true, startAt: true, homeTeamId: true, awayTeamId: true } } },
    }),
    nbaPrisma.nbaPropProjection.findMany({ where: { actual: { not: null } }, select: { stat: true, mean: true, q10: true, q90: true, actual: true, line: true, over: true, under: true, edgeOver: true, edgeUnder: true } }),
    nbaPrisma.nbaPlayer.findMany({ select: { id: true, name: true } }),
    nbaPrisma.nbaTeam.findMany({ select: { id: true, abbr: true } }),
  ]);
  const name = new Map(players.map((p) => [p.id, p.name]));
  const abbr = new Map(teams.map((t) => [t.id, t.abbr]));
  // Facit per statistik: medelfel, täckning 10–90 och markerade spel mot linjen.
  const facit = PROP_STATS.map((stat) => {
    const l = settled.filter((s) => s.stat === stat);
    let ae = 0;
    let cov = 0;
    let bets = 0;
    let profit = 0;
    let w = 0;
    let lo = 0;
    for (const s of l) {
      ae += Math.abs(s.actual! - s.mean);
      if (s.actual! >= s.q10 && s.actual! <= s.q90) cov++;
      if (s.line == null || s.over == null || s.under == null) continue;
      const eo = s.edgeOver ?? -1;
      const eu = s.edgeUnder ?? -1;
      const over = eo >= eu;
      const edge = Math.max(eo, eu);
      const price = over ? s.over : s.under;
      if (edge < NBA_EDGE_THRESHOLD || price > NBA_MAX_FLAG_ODDS) continue;
      bets++;
      if (s.actual === s.line) continue;
      const won = over ? s.actual! > s.line : s.actual! < s.line;
      if (won) {
        w++;
        profit += price - 1;
      } else {
        lo++;
        profit -= 1;
      }
    }
    return { stat, n: l.length, mae: l.length ? ae / l.length : null, coverage: l.length ? cov / l.length : null, bets, w, l: lo, roi: bets ? profit / bets : null };
  });
  return NextResponse.json({
    dbConfigured: true,
    threshold: NBA_EDGE_THRESHOLD,
    maxOdds: NBA_MAX_FLAG_ODDS,
    facit,
    props: rows.map((r) => ({
      gameId: r.gameId,
      startAt: r.game.startAt,
      matchup: `${abbr.get(r.game.awayTeamId) ?? "?"} @ ${abbr.get(r.game.homeTeamId) ?? "?"}`,
      team: abbr.get(r.teamId) ?? "?",
      playerId: r.playerId,
      name: name.get(r.playerId) ?? `#${r.playerId}`,
      stat: r.stat,
      minutes: r.minutes,
      mean: r.mean,
      q10: r.q10,
      q90: r.q90,
      line: r.line,
      book: r.book,
      over: r.over,
      under: r.under,
      pModel: r.pModel,
      pMarket: r.pMarket,
      edgeOver: r.edgeOver,
      edgeUnder: r.edgeUnder,
    })),
  });
}

const STATS = new Set<string>(PROP_STATS);

// POST /api/nba/props — ditt eget bolags prop-linje.
// Body: { gameId, playerId, stat, book, line, over, under }.
export async function POST(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const n = (v: unknown) => Number(String(v ?? "").replace(",", "."));
  const gameId = n(b.gameId);
  const playerId = n(b.playerId);
  const stat = String(b.stat ?? "");
  const book = String(b.book ?? "").trim().slice(0, 40);
  const line = n(b.line);
  const over = n(b.over);
  const under = n(b.under);
  if (!Number.isInteger(gameId) || !Number.isInteger(playerId)) return NextResponse.json({ error: "Ogiltig match eller spelare" }, { status: 400 });
  if (!STATS.has(stat)) return NextResponse.json({ error: "Okänd statistik" }, { status: 400 });
  if (!book) return NextResponse.json({ error: "Ange bolag" }, { status: 400 });
  if (!(line >= 0) || !Number.isFinite(line)) return NextResponse.json({ error: "Ange linje" }, { status: 400 });
  if (!(over > 1) || !(under > 1)) return NextResponse.json({ error: "Över och under måste vara decimalodds över 1" }, { status: 400 });
  const row = await nbaPrisma.nbaPropLine.create({ data: { gameId, playerId, stat, book, line, over, under, source: "manual" } });
  return NextResponse.json({ ok: true, id: row.id });
}

// DELETE /api/nba/props?id=12 — ta bort en egen prop-linje.
export async function DELETE(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Ogiltigt id" }, { status: 400 });
  await nbaPrisma.nbaPropLine.deleteMany({ where: { id, source: "manual" } });
  return NextResponse.json({ ok: true });
}
