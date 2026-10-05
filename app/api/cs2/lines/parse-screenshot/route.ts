import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { extractPropsFromScreenshot, PropsParseFailedError } from "@/lib/cs2/propsExtract";
import { matchPlayer, matchTeams, skipReason } from "@/lib/cs2/propsMatch";
import { noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BASE64_CHARS = 7_000_000;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

// POST /api/cs2/lines/parse-screenshot { matchId, imageBase64, mediaType }
// Tolkar bokens marknader (spelarprops och lagmarknader) till linjer och
// kopplar spelare och lag till matchens. Inget sparas — klienten bekräftar och
// skickar till /api/cs2/lines. `skip` säger varför en rad inte kan sparas.
export async function POST(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "Tolkningstjänsten är inte konfigurerad (ANTHROPIC_API_KEY)" }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as { matchId?: unknown; imageBase64?: unknown; mediaType?: unknown };
  const matchId = Number(body.matchId);
  if (!Number.isInteger(matchId)) return NextResponse.json({ error: "matchId saknas" }, { status: 400 });
  if (typeof body.imageBase64 !== "string" || !body.imageBase64) return NextResponse.json({ error: "imageBase64 saknas" }, { status: 400 });
  if (body.imageBase64.length > MAX_BASE64_CHARS) return NextResponse.json({ error: "Bilden är för stor (max ~5 MB)" }, { status: 413 });
  if (!TYPES.includes(body.mediaType as (typeof TYPES)[number])) return NextResponse.json({ error: "Bildformatet stöds inte" }, { status: 400 });

  const match = await cs2Prisma.cs2Match.findUnique({ where: { id: matchId }, select: { team1Id: true, team2Id: true, team1Name: true, team2Name: true } });
  if (!match) return NextResponse.json({ error: "Matchen finns inte" }, { status: 404 });
  const players = await cs2Prisma.cs2Player.findMany({
    where: { teamId: { in: [match.team1Id, match.team2Id].filter((x): x is number => x != null) } },
    select: { id: true, nickname: true, teamId: true },
  });

  try {
    const parsed = await extractPropsFromScreenshot(body.imageBase64, body.mediaType as (typeof TYPES)[number]);
    const teams = [
      ...(match.team1Id != null ? [{ id: match.team1Id, name: match.team1Name }] : []),
      ...(match.team2Id != null ? [{ id: match.team2Id, name: match.team2Name }] : []),
    ];
    const teamOf = matchTeams(parsed.rows.map((r) => r.team), teams);
    const rows = parsed.rows.map((r) => {
      const playerId = matchPlayer(r.player, players);
      const teamId = r.team ? teamOf.get(r.team) ?? null : null;
      return { ...r, playerId, teamId, skip: skipReason({ ...r, playerId, teamId }) };
    });
    return NextResponse.json({ bookmaker: parsed.bookmaker, rows });
  } catch (e) {
    if (e instanceof PropsParseFailedError) return NextResponse.json({ error: e.message }, { status: 422 });
    if (e instanceof Anthropic.AuthenticationError) return NextResponse.json({ error: "Tolkningstjänsten är inte konfigurerad" }, { status: 500 });
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) return NextResponse.json({ error: "Tolkningstjänsten är upptagen — försök igen strax" }, { status: 502 });
    if (e instanceof Anthropic.APIError) return NextResponse.json({ error: "Tolkningen misslyckades — försök igen" }, { status: 502 });
    console.error("cs2 parse-screenshot:", e);
    return NextResponse.json({ error: "Kunde inte tolka skärmdumpen" }, { status: 422 });
  }
}
