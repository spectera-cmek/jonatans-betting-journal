// Pinnacles spelarprops via deras öppna webb-API (samma data som sajten visar).
// Gratis och utan nyckel. Pinnacle är den skarpaste prop-marknaden och
// prissättningen förankras i dess rättvisa pris — men OddsPapi ger bara
// Pinnacle två gånger om dagen, medan Kambi fångas varje timme. Den här
// fångsten körs varje timme, så att ankaret är lika färskt som det som prissätts.
//
// Sparas som book "pinnacle", source "arcadia" i NbaPropLine, med maxinsatsen
// (maxStake): låg insats = tidig, mjuk linje.

import type { NbaPrisma } from "../nbaDb";
import { americanToDecimal, getJson, PINNACLE_NBA_LEAGUE } from "../live/books";
import { normalizeName, type PropStatKey } from "../oddspapi/markets";
import { nickname } from "./oddspapiCapture";
import { savePropLines } from "./store";

export const PINNACLE_PROP_BOOK = "pinnacle";
export const PINNACLE_PROP_SOURCE = "arcadia";

interface PinParticipant {
  id?: number;
  alignment?: string;
  name: string;
}

export interface PinPropMatchup {
  id: number;
  type: string;
  parentId?: number | null;
  isLive?: boolean;
  startTime: string;
  units?: string;
  special?: { category?: string; description?: string };
  participants?: PinParticipant[];
  parent?: { id: number; startTime: string; participants?: PinParticipant[] };
}

export interface PinPropMarket {
  matchupId: number;
  type: string;
  period: number;
  status?: string;
  limits?: Array<{ amount: number; type: string }>;
  prices?: Array<{ participantId?: number; price: number; points?: number }>;
}

/** Pinnacles enhet → vår statistik. */
const UNIT_STAT: Record<string, PropStatKey> = {
  Points: "pts",
  Rebounds: "reb",
  Assists: "ast",
  "Threes Made": "fg3",
  "Pts & Rebs & Asts": "pra",
};

export interface PinPropLine {
  parentId: number;
  home: string;
  away: string;
  start: number;
  playerName: string;
  stat: PropStatKey;
  line: number;
  over: number;
  under: number;
  /** Pinnacles maxinsats (maxRiskStake), eller null. */
  maxStake: number | null;
}

/** "Kyle Kuzma Total Rebounds" → "Kyle Kuzma". */
export function pinPropPlayer(description: string): string | null {
  const m = /^(.*?)\s+Total\s+.+$/.exec(description.trim());
  return m ? m[1].trim() : null;
}

export function parsePinnacleProps(matchups: PinPropMatchup[], markets: PinPropMarket[]): PinPropLine[] {
  const byMatchup = new Map<number, PinPropMarket>();
  for (const k of markets) {
    if (k.period !== 0 || k.type !== "total" || (k.status && k.status !== "open")) continue;
    byMatchup.set(k.matchupId, k);
  }
  const out: PinPropLine[] = [];
  for (const m of matchups) {
    if (m.type !== "special" || m.isLive || m.special?.category !== "Player Props") continue;
    const stat = UNIT_STAT[m.units ?? ""];
    const playerName = pinPropPlayer(m.special?.description ?? "");
    const k = byMatchup.get(m.id);
    if (!stat || !playerName || !k || !m.parent) continue;
    const overId = m.participants?.find((p) => /^over$/i.test(p.name))?.id;
    const underId = m.participants?.find((p) => /^under$/i.test(p.name))?.id;
    const po = k.prices?.find((p) => p.participantId === overId);
    const pu = k.prices?.find((p) => p.participantId === underId);
    if (!po || !pu || po.points == null || po.points !== pu.points) continue;
    const home = m.parent.participants?.find((p) => p.alignment === "home")?.name;
    const away = m.parent.participants?.find((p) => p.alignment === "away")?.name;
    if (!home || !away) continue;
    out.push({
      parentId: m.parent.id,
      home,
      away,
      start: Date.parse(m.parent.startTime),
      playerName,
      stat,
      line: po.points,
      over: Math.round(americanToDecimal(po.price) * 1000) / 1000,
      under: Math.round(americanToDecimal(pu.price) * 1000) / 1000,
      maxStake: k.limits?.find((l) => l.type === "maxRiskStake")?.amount ?? null,
    });
  }
  return out;
}

export async function fetchPinnacleProps(leagueId = PINNACLE_NBA_LEAGUE): Promise<PinPropLine[]> {
  const base = `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${leagueId}`;
  // Ett anrop i taget — parallella anrop har gett tillfälliga 401.
  const matchups = await getJson<PinPropMatchup[]>(`${base}/matchups?brandId=0`);
  const markets = await getJson<PinPropMarket[]>(`${base}/markets/straight`);
  return parsePinnacleProps(matchups, markets);
}

export async function capturePinnacleProps(
  db: NbaPrisma,
  opts: { hours?: number; log?: (m: string) => void } = {}
): Promise<{ games: number; matched: number; saved: number; unmatched: string[] }> {
  const res = { games: 0, matched: 0, saved: 0, unmatched: [] as string[] };
  const now = Date.now();
  const horizon = now + (opts.hours ?? 36) * 3600e3;
  const lines = (await fetchPinnacleProps()).filter((l) => l.start > now && l.start <= horizon);
  const byParent = new Map<number, PinPropLine[]>();
  for (const l of lines) byParent.set(l.parentId, [...(byParent.get(l.parentId) ?? []), l]);
  res.games = byParent.size;
  if (!byParent.size) return res;
  const teams = await db.nbaTeam.findMany();
  const byNick = new Map(teams.map((t) => [nickname(t.name), t.id]));
  let allPlayers: Array<{ id: number; name: string }> | null = null;
  const seenAt = new Date();

  for (const group of byParent.values()) {
    const g0 = group[0];
    const home = byNick.get(nickname(g0.home));
    const away = byNick.get(nickname(g0.away));
    if (!home || !away) continue;
    const game = await db.nbaGame.findFirst({
      where: { homeTeamId: home, awayTeamId: away, status: "scheduled", startAt: { gte: new Date(g0.start - 3 * 3600e3), lte: new Date(g0.start + 3 * 3600e3) } },
    });
    if (!game) continue;
    res.matched++;
    const players = await db.nbaPlayer.findMany({ where: { teamId: { in: [home, away] } }, select: { id: true, name: true } });
    const byName = new Map(players.map((p) => [normalizeName(p.name), p.id]));
    const batch: Parameters<typeof savePropLines>[4] = [];
    for (const pr of group) {
      let playerId = byName.get(normalizeName(pr.playerName));
      if (!playerId) {
        allPlayers ??= await db.nbaPlayer.findMany({ select: { id: true, name: true } });
        const hits = allPlayers.filter((p) => normalizeName(p.name) === normalizeName(pr.playerName));
        if (hits.length === 1) playerId = hits[0].id;
      }
      if (!playerId) {
        if (res.unmatched.length < 20 && !res.unmatched.includes(pr.playerName)) res.unmatched.push(pr.playerName);
        continue;
      }
      batch.push({ playerId, stat: pr.stat, line: pr.line, over: pr.over, under: pr.under, maxStake: pr.maxStake });
    }
    res.saved += await savePropLines(db, game.id, PINNACLE_PROP_BOOK, PINNACLE_PROP_SOURCE, batch, seenAt);
  }
  opts.log?.(`${res.matched}/${res.games} Pinnacle-matcher, ${res.saved} nya prop-linjer${res.unmatched.length ? ` (ej kopplade: ${res.unmatched.slice(0, 5).join(", ")})` : ""}`);
  return res;
}
