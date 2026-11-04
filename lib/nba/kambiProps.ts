// Spelarprops från Kambi (Unibet, Paf, LeoVegas …) via Kambis öppna API.
// Gratis och utan nyckel — inget OddsPapi-anrop. Sparas som book "kambi" i
// NbaPropLine, så att prop-sidan prisar dem som vilket bolag som helst.

import type { NbaPrisma } from "../nbaDb";
import { fetchKambiNba } from "../live/books";
import { normalizeName, type PropStatKey } from "../oddspapi/markets";
import { nickname } from "./oddspapiCapture";
import { savePropLines } from "./store";

export const KAMBI_PROP_BOOK = "kambi";

interface KambiOutcome {
  type?: string;
  odds?: number;
  line?: number;
  participant?: string;
  status?: string;
}
interface KambiBetOffer {
  eventId?: number;
  criterion?: { englishLabel?: string; lifetime?: string };
  betOfferType?: { englishName?: string };
  outcomes?: KambiOutcome[];
}

/** Kambis kriterier för över/under per spelare (inklusive förlängning). "10+ Points …" och kombinationer utan PRA hoppas över. */
export function kambiPropStat(label: string): PropStatKey | null {
  const n = label.toLowerCase().replace(/\s*-\s*including overtime\s*$/, "").trim();
  if (/^\d+\+/.test(n)) return null;
  if (n === "points scored by the player") return "pts";
  if (n === "rebounds by the player") return "reb";
  if (n === "assists by the player") return "ast";
  if (n === "3-point field goals made by the player") return "fg3";
  if (n === "points, rebounds & assists by the player") return "pra";
  return null;
}

export interface KambiPropLine {
  stat: PropStatKey;
  playerName: string;
  line: number;
  over: number;
  under: number;
}

/** `eventId`: bara spel som hör till den matchen (svaret kan i princip innehålla fler). */
export function parseKambiProps(json: { betOffers?: KambiBetOffer[] }, eventId?: string | number): KambiPropLine[] {
  const out: KambiPropLine[] = [];
  for (const b of json.betOffers ?? []) {
    if (eventId != null && b.eventId != null && String(b.eventId) !== String(eventId)) continue;
    if (b.betOfferType?.englishName !== "Player Occurrence Line") continue;
    if (b.criterion?.lifetime && b.criterion.lifetime !== "FULL_TIME_OVERTIME") continue;
    const stat = kambiPropStat(b.criterion?.englishLabel ?? "");
    if (!stat) continue;
    const over = b.outcomes?.find((o) => o.type === "OT_OVER");
    const under = b.outcomes?.find((o) => o.type === "OT_UNDER");
    if (!over?.odds || !under?.odds || over.status !== "OPEN" || under.status !== "OPEN" || over.line == null || !over.participant) continue;
    out.push({ stat, playerName: over.participant, line: over.line / 1000, over: over.odds / 1000, under: under.odds / 1000 });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchEventOffers(brand: string, eventId: string): Promise<{ betOffers?: KambiBetOffer[] }> {
  const url = `https://eu-offering-api.kambicdn.com/offering/v2018/${brand}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (betting-tracker, personal use)" }, cache: "no-store" });
    const text = res.ok ? await res.text() : "";
    if (text) return JSON.parse(text);
    if (attempt >= 2) throw new Error(`Kambi ${res.status} för event ${eventId}`);
    await sleep(1500 * (attempt + 1));
  }
}

export async function captureKambiProps(
  db: NbaPrisma,
  opts: { hours?: number; brand?: string; log?: (m: string) => void } = {}
): Promise<{ events: number; matched: number; saved: number; unmatched: string[] }> {
  const brand = opts.brand ?? "ubse";
  const res = { events: 0, matched: 0, saved: 0, unmatched: [] as string[] };
  const horizon = Date.now() + (opts.hours ?? 36) * 3600e3;
  const events = (await fetchKambiNba(brand)).filter((e) => e.start > Date.now() && e.start <= horizon);
  res.events = events.length;
  if (!events.length) return res;
  const teams = await db.nbaTeam.findMany();
  const byNick = new Map(teams.map((t) => [nickname(t.name), t.id]));
  let allPlayers: Array<{ id: number; name: string }> | null = null;

  for (const ev of events) {
    const home = byNick.get(nickname(ev.home));
    const away = byNick.get(nickname(ev.away));
    if (!home || !away) continue;
    const game = await db.nbaGame.findFirst({
      where: { homeTeamId: home, awayTeamId: away, status: "scheduled", startAt: { gte: new Date(ev.start - 3 * 3600e3), lte: new Date(ev.start + 3 * 3600e3) } },
    });
    if (!game) continue;
    res.matched++;
    await sleep(300);
    const lines = parseKambiProps(await fetchEventOffers(brand, ev.id), ev.id);
    if (!lines.length) continue;
    const players = await db.nbaPlayer.findMany({ where: { teamId: { in: [home, away] } }, select: { id: true, name: true } });
    const byName = new Map(players.map((p) => [normalizeName(p.name), p.id]));
    const batch: Parameters<typeof savePropLines>[4] = [];
    for (const pr of lines) {
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
      batch.push({ playerId, stat: pr.stat, line: pr.line, over: pr.over, under: pr.under });
    }
    res.saved += await savePropLines(db, game.id, KAMBI_PROP_BOOK, KAMBI_PROP_BOOK, batch);
  }
  opts.log?.(`${res.matched}/${res.events} Kambi-matcher, ${res.saved} nya prop-linjer${res.unmatched.length ? ` (ej kopplade: ${res.unmatched.slice(0, 5).join(", ")})` : ""}`);
  return res;
}
