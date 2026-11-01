import { NextResponse } from "next/server";
import { getSessionUser, getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { nbaPrisma, hasNbaDb } from "@/lib/nbaDb";
import { detailJson, idParam, noNbaDb } from "@/lib/nba/api";
import { projectStoredGame } from "@/lib/nba/pipeline";
import { DEFAULT_NBA_PARAMS } from "@/lib/nba/params";

export const dynamic = "force-dynamic";
// Historiken (~1,5 säsong boxscores) läses och matchen simuleras vid varje anrop.
export const maxDuration = 60;

/** Färre simuleringar i appen än i den dagliga körningen — snabbt nog, ±0,5 %-enhet. */
const API_PARAMS = { ...DEFAULT_NBA_PARAMS, sims: 10000 };

async function respond(id: number, save: boolean) {
  const g = await nbaPrisma.nbaGame.findUnique({ where: { id } });
  if (!g) return NextResponse.json({ error: "Matchen finns inte" }, { status: 404 });
  const p = await projectStoredGame(nbaPrisma, id, { params: API_PARAMS, save });
  if (!p) return NextResponse.json({ error: "Kunde inte räkna matchen" }, { status: 500 });
  const teams = new Map((await nbaPrisma.nbaTeam.findMany({ where: { id: { in: [g.homeTeamId, g.awayTeamId] } } })).map((t) => [t.id, t]));
  return NextResponse.json(detailJson(g, teams, p));
}

// GET /api/nba/games/123 — matchen räknad med nuvarande minuter och priser.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const id = idParam(params.id);
  if (!id) return NextResponse.json({ error: "Ogiltigt id" }, { status: 400 });
  return respond(id, false);
}

// PUT /api/nba/games/123 — spara minut-ändringar och räkna om.
// Body: { overrides: [{ playerId, minutes }] }. minutes = null tar bort
// ändringen, 0 = spelar inte.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return apiUnauthorized();
  if (!hasNbaDb()) return noNbaDb();
  const id = idParam(params.id);
  if (!id) return NextResponse.json({ error: "Ogiltigt id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { overrides?: Array<{ playerId?: unknown; minutes?: unknown }> };
  const list = Array.isArray(body.overrides) ? body.overrides : [];
  for (const o of list) {
    const playerId = Number(o.playerId);
    if (!Number.isInteger(playerId) || playerId <= 0) return NextResponse.json({ error: "Ogiltig spelare" }, { status: 400 });
    if (o.minutes === null || o.minutes === undefined || o.minutes === "") {
      await nbaPrisma.nbaMinutesOverride.deleteMany({ where: { gameId: id, playerId } });
      continue;
    }
    const minutes = Number(o.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 48) return NextResponse.json({ error: "Minuter måste vara 0–48" }, { status: 400 });
    await nbaPrisma.nbaMinutesOverride.upsert({
      where: { gameId_playerId: { gameId: id, playerId } },
      create: { gameId: id, playerId, minutes, createdBy: user.username },
      update: { minutes, createdBy: user.username },
    });
  }
  return respond(id, true);
}
