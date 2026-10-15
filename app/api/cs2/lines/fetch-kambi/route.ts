import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { fetchCs2Events, KambiError, KAMBI_BOOKMAKER } from "@/lib/cs2/kambi";
import { kambiRowsForMatch } from "@/lib/cs2/lineStore";
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
  try {
    const rows = await kambiRowsForMatch(cs2Prisma, match, await fetchCs2Events());
    if (!rows) return NextResponse.json({ error: `${KAMBI_BOOKMAKER} har inte matchen i sitt utbud` }, { status: 404 });
    return NextResponse.json({ bookmaker: KAMBI_BOOKMAKER, rows });
  } catch (e) {
    console.error("cs2 fetch-kambi:", e);
    const msg = e instanceof KambiError ? e.message : "Kunde inte nå Kambi";
    return NextResponse.json({ error: `${msg} — använd skärmdump i stället` }, { status: 502 });
  }
}
