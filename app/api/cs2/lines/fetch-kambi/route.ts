import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { fetchBetOffers, fetchCs2Events, findKambiEvent, KambiError, KAMBI_BOOKMAKER, mapBetOffers } from "@/lib/cs2/kambi";
import { matchPlayer, matchTeams, skipReason } from "@/lib/cs2/propsMatch";
import { noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/cs2/lines/fetch-kambi { matchId }
// Hämtar matchens marknader från Kambi (Unibet) och svarar i samma form som
// /api/cs2/lines/parse-screenshot. Inget sparas — klienten bekräftar och
// skickar till /api/cs2/lines. `skip` säger varför en rad inte kan sparas.
export async function POST(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();

  const body = (await req.json().catch(() => ({}))) as { matchId?: unknown };
  const matchId = Number(body.matchId);
  if (!Number.isInteger(matchId)) return NextResponse.json({ error: "matchId saknas" }, { status: 400 });

  const match = await cs2Prisma.cs2Match.findUnique({ where: { id: matchId }, select: { startAt: true, team1Id: true, team2Id: true, team1Name: true, team2Name: true } });
  if (!match) return NextResponse.json({ error: "Matchen finns inte" }, { status: 404 });
  const teams = [
    ...(match.team1Id != null ? [{ id: match.team1Id, name: match.team1Name }] : []),
    ...(match.team2Id != null ? [{ id: match.team2Id, name: match.team2Name }] : []),
  ];
  const players = await cs2Prisma.cs2Player.findMany({
    where: { teamId: { in: teams.map((t) => t.id) } },
    select: { id: true, nickname: true, teamId: true },
  });

  try {
    const event = findKambiEvent({ startAt: match.startAt, teams }, await fetchCs2Events());
    if (!event) return NextResponse.json({ error: `${KAMBI_BOOKMAKER} har inte matchen i sitt utbud` }, { status: 404 });
    // Marknader utanför modellen (udda/jämnt, övertid, exakt resultat …) är bara brus här.
    const parsed = mapBetOffers(await fetchBetOffers(event.id), event).filter((r) => r.market !== "other");
    const teamOf = matchTeams(parsed.map((r) => r.team), teams);
    const rows = parsed.map((r) => {
      const playerId = matchPlayer(r.player, players);
      const teamId = r.team ? teamOf.get(r.team) ?? null : null;
      return { ...r, playerId, teamId, skip: skipReason({ ...r, playerId, teamId }) };
    });
    return NextResponse.json({ bookmaker: KAMBI_BOOKMAKER, rows });
  } catch (e) {
    console.error("cs2 fetch-kambi:", e);
    const msg = e instanceof KambiError ? e.message : "Kunde inte nå Kambi";
    return NextResponse.json({ error: `${msg} — använd skärmdump i stället` }, { status: 502 });
  }
}
