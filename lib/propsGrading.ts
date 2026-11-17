// Rättning av props och statistikmarknader ur matchdata (ESPN, NHL:s API
// eller Sofascore — se lib/statSources):
// spelarprops (skott, poäng, returer …), lag- och matchtotaler för hörnor och
// skott, och BTTS. Rena funktioner — hämtningen sköter scripts/results/gradeProps.ts.
//
// Över/under rättas av samma gradeBet() som resten av appen (som en total
// med värdet på hemmasidan och 0 borta), så push vid exakt linje följer
// appens regler.
//
// Hellre ingen rättning än en fel: allt som inte går att avgöra säkert blir
// ett skäl att hoppa över, och betet rättas för hand som förut. Det gäller
// kort (bolagen räknar olika), kombinationer, spelare som inte spelade
// (void eller förlust beror på bolaget) och statistikfält vi inte sett i
// matchens data.

import type { Outcome } from "./betting";
import { gradeBet } from "./grading";
import { matchFixture, normalizeTeam, teamSimilarity, MIN_TEAM_SIMILARITY } from "./teamMatch";
import { sofaSportFor, type SofaSport } from "./sofascore/api";
import {
  hasStatKey,
  playerPlayed,
  type Lineups,
  type MatchEvent,
  type PlayerLine,
  type StatPair,
} from "./matchData";

// ---------------------------------------------------------------------------
// Mappningstabellen
// ---------------------------------------------------------------------------

/**
 * En spelarstatistik som summa av komponenter. Varje komponent är en lista
 * kandidatnycklar — första nyckeln som finns i matchens data används.
 */
type PlayerSum = string[][];

interface StatSpec {
  /** Spelarnivå: primär summa, och en reserv om primärens nycklar saknas i matchen. */
  player?: { sum: PlayerSum; fallback?: PlayerSum };
  /** Lag- och matchnivå ur /statistics: kandidatnycklar. */
  team?: string[];
  /** Lag- och matchnivå ur resultatet: ordinarie tid eller slutresultat. */
  score?: "normal" | "final";
}

/** Sport → marknadskategori (gemener) → var värdet finns. */
const SPECS: Record<SofaSport, Record<string, StatSpec>> = {
  football: {
    hörnor: { team: ["cornerKicks"] },
    skott: {
      team: ["totalShotsOnGoal"], // Sofascores namn för TOTALA skott
      player: {
        sum: [["totalShots"]],
        fallback: [["onTargetScoringAttempt"], ["shotOffTarget"], ["blockedScoringAttempt"]],
      },
    },
    "skott på mål": { team: ["shotsOnGoal"], player: { sum: [["onTargetScoringAttempt"]] } },
    räddningar: { team: ["goalkeeperSaves"], player: { sum: [["saves"]] } },
    offside: { team: ["offsides"], player: { sum: [["totalOffside"]] } },
    mål: { score: "normal", player: { sum: [["goals"]] } },
    totalt: { score: "normal" },
    assists: { player: { sum: [["goalAssist"]] } },
  },
  basketball: {
    spelarpoäng: { player: { sum: [["points"]] } },
    returer: { player: { sum: [["rebounds"]], fallback: [["defensiveRebounds"], ["offensiveRebounds"]] } },
    assists: { player: { sum: [["assists"]] } },
    trepoängare: { player: { sum: [["threePointsMade"]] } },
    frikast: { player: { sum: [["freeThrowsMade"]] } },
    steals: { player: { sum: [["steals"]] } },
    blocks: { player: { sum: [["blocks"]] } },
    pra: { player: { sum: [["points"], ["rebounds"], ["assists"]] } },
    // Baskettotaler räknar förlängning.
    totalt: { score: "final" },
  },
  "ice-hockey": {
    // Hockeyns "skott" är skott på mål (SOG) hos bolagen. NHL-källan kallar
    // dem shotsOnGoal; Sofascore "shots" per spelare och "Shots" per lag.
    skott: { team: ["shotsOnGoal", "Shots", "shots"], player: { sum: [["shotsOnGoal", "shots"]] } },
    "skott på mål": { team: ["shotsOnGoal", "Shots", "shots"], player: { sum: [["shotsOnGoal", "shots"]] } },
    mål: { player: { sum: [["goals"]] } },
    assists: { player: { sum: [["assists"]] } },
    spelarpoäng: { player: { sum: [["points"]], fallback: [["goals"], ["assists"]] } },
    räddningar: { player: { sum: [["saves"]] } },
  },
};

/** Kategorier som medvetet lämnas åt handen, med skälet. */
const MANUAL: Record<string, string> = {
  "kort & fouls": "kort räknas olika hos bolagen (gult 1/rött 2, eller kortpoäng) — rättas för hand",
  frisparkar: "frisparkar finns inte i källornas statistik — rättas för hand",
};

/** För sofascore:capture: vilka spelarnycklar mappningen räknar med. */
export const PROP_STAT_CHECKS: { sport: SofaSport; label: string; keys: string[] }[] = Object.entries(SPECS).flatMap(
  ([sport, cats]) =>
    Object.entries(cats).flatMap(([cat, spec]) =>
      (spec.player?.sum ?? []).map((keys) => ({ sport: sport as SofaSport, label: `${cat} (${keys.join("|")})`, keys }))
    )
);

// ---------------------------------------------------------------------------
// Vad behöver betet?
// ---------------------------------------------------------------------------

/** Delmängden av Bet som rättningen läser. */
export interface PropBet {
  id: string;
  sport: string | null;
  /** Avgör vilka källor som täcker matchen (t.ex. NHL eller SHL). */
  league?: string | null;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  eventAt: Date | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  betType: string;
  eventKind: string;
}

export type PropNeed =
  | { kind: "btts"; sport: SofaSport; yes: boolean }
  | {
      kind: "overUnder";
      sport: SofaSport;
      category: string;
      scope: "player" | "team" | "match";
      side: "over" | "under";
      line: number;
      spec: StatSpec;
    };

export type Classified = { ok: true; need: PropNeed } | { ok: false; reason: string };

const skip = (reason: string): Classified => ({ ok: false, reason });

function foldText(s: string): string {
  return normalizeTeam(s);
}

/** Vad som krävs för att rätta betet, eller varför det inte går. */
export function classifyPropBet(bet: PropBet): Classified {
  if (bet.betType !== "single") return skip("kombination — rättas för hand");
  if (bet.eventKind !== "match") return skip("långtidsspel — rättas för hand");
  const sport = sofaSportFor(bet.sport);
  if (!sport) return skip(`sporten "${bet.sport ?? "?"}" hämtas inte`);
  if (bet.market === "h2h" || bet.market === "spreads") return skip("matchresultat — ESPN-rättningen tar det");

  const category = (bet.marketCategory ?? "").trim().toLowerCase();
  if (MANUAL[category]) return skip(MANUAL[category]);
  const scope = (bet.marketScope ?? "match") as "player" | "team" | "match";

  if (category === "btts") {
    if (sport !== "football") return skip("BTTS bara för fotboll");
    const t = ` ${foldText(bet.selection)} `;
    const yes = / (ja|yes) /.test(t);
    const no = / (nej|no) /.test(t);
    if (yes === no) return skip(`BTTS: kan inte läsa ja/nej ur "${bet.selection}"`);
    return { ok: true, need: { kind: "btts", sport, yes } };
  }

  const spec = SPECS[sport][category];
  if (!spec) return skip(`kategorin "${bet.marketCategory ?? "—"}" har ingen mappning för ${sport}`);
  const side = bet.selectionSide;
  if (side !== "over" && side !== "under") return skip("saknar över/under");
  if (bet.line == null) return skip("saknar linje");
  // Kvartslinjer (asiatiska) delar insatsen — gradeBet rättar bara hela och halva.
  if (Math.abs(bet.line * 4 - Math.round(bet.line * 4)) < 1e-9 && Math.round(bet.line * 4) % 2 !== 0) {
    return skip("kvartslinje — rättas för hand");
  }
  if (scope === "player" && !spec.player) return skip(`${category}: bara lag/match, inte spelare`);
  if (scope !== "player" && !spec.team && !spec.score) return skip(`${category}: bara spelare, inte lag/match`);
  return { ok: true, need: { kind: "overUnder", sport, category, scope, side, line: bet.line, spec } };
}

// ---------------------------------------------------------------------------
// Hitta matchen
// ---------------------------------------------------------------------------

/**
 * "Hemma vs Borta" / "Hemma - Borta" när homeTeam/awayTeam saknas.
 * "Borta @ Hemma" är amerikansk ordning — där kommer bortalaget först.
 */
export function teamsOf(bet: Pick<PropBet, "event" | "homeTeam" | "awayTeam">): { home: string; away: string } | null {
  if (bet.homeTeam && bet.awayTeam) return { home: bet.homeTeam, away: bet.awayTeam };
  const at = bet.event.split(/\s+@\s+/);
  if (at.length === 2 && at[0].trim() && at[1].trim()) return { home: at[1].trim(), away: at[0].trim() };
  const parts = bet.event.split(/\s+(?:vs\.?|v|–|-)\s+/i);
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return null;
  return { home: parts[0].trim(), away: parts[1].trim() };
}

/**
 * Matchen för betet bland källans kandidater (dagens lista ±1 dygn).
 * Saknar eventAt klockslag (bara datum) tillåts ett bredare tidsfönster;
 * namnlikheten och marginalkontrollen i matchFixture skyddar mot fel lag.
 */
export function findEventForBet(bet: PropBet, events: MatchEvent[]): MatchEvent | null {
  const teams = teamsOf(bet);
  if (!teams || !bet.eventAt) return null;
  const candidates = events.map((e) => ({
    id: String(e.id),
    kickoffAt: e.startAt,
    homeTeamName: e.homeTeam.name,
    awayTeamName: e.awayTeam.name,
  }));
  const at = bet.eventAt.toISOString();
  const straight = { home_team: teams.home, away_team: teams.away, commence_time: at };
  // Omvänd ordning som reserv: kvitton och loggar blandar "hemma–borta" och
  // amerikanska "borta @ hemma". Props och totaler bryr sig inte om ordningen,
  // och lagtotaler läser laget ur selection, inte ur ordningen.
  const swapped = { home_team: teams.away, away_team: teams.home, commence_time: at };
  const hit =
    matchFixture(straight, candidates) ??
    matchFixture(straight, candidates, { maxDriftHours: 30 }) ??
    matchFixture(swapped, candidates) ??
    matchFixture(swapped, candidates, { maxDriftHours: 30 });
  return hit ? events.find((e) => String(e.id) === hit.fixture.id) ?? null : null;
}

// ---------------------------------------------------------------------------
// Rätta
// ---------------------------------------------------------------------------

export interface MatchData {
  /** Källans namn för skälet, t.ex. "ESPN". */
  source: string;
  event: MatchEvent;
  /** /statistics, period ALL. Null om den inte hämtats eller saknas. */
  stats: Record<string, StatPair> | null;
  lineups: Lineups | null;
}

/**
 * `final`: beskedet gäller oavsett källa (matchen är inte spelad, spelaren
 * var inte med) — då är det ingen idé att fråga nästa källa.
 */
export type Graded =
  | { ok: true; outcome: Outcome; value: number; reason: string }
  | { ok: false; reason: string; final?: boolean };

const no = (reason: string, final = false): Graded => ({ ok: false, reason, final });

/** Behövs /statistics respektive /lineups för betet? */
export function dataNeeded(need: PropNeed): { stats: boolean; lineups: boolean } {
  if (need.kind === "btts") return { stats: false, lineups: false };
  if (need.scope === "player") return { stats: false, lineups: true };
  return { stats: !need.spec.score && !!need.spec.team, lineups: false };
}

/**
 * Spelaren som betet gäller: den vars namn står i selection-texten. Hela
 * namnet går före efternamnet; två lika bra träffar ger ingen träff.
 * Förkortade namn ("A. Matthews", som NHL:s API skriver) räknas som hela
 * när efternamnet står i texten och något ord börjar på initialen.
 */
export function findPlayer(selection: string, lineups: Lineups): PlayerLine | null {
  const words = new Set(foldText(selection).split(" ").filter(Boolean));
  let best: PlayerLine | null = null;
  let bestScore = 0;
  let tied = false;
  for (const p of lineups.players) {
    const tokens = foldText(p.name).split(" ").filter(Boolean);
    if (tokens.length === 0) continue;
    const last = tokens[tokens.length - 1];
    const initialsOk = tokens
      .slice(0, -1)
      .every((t) => words.has(t) || (t.length === 1 && [...words].some((w) => w !== last && w.startsWith(t))));
    const lastHit = last.length >= 4 && words.has(last);
    const score = tokens.every((t) => words.has(t)) || (lastHit && tokens.length > 1 && initialsOk && tokens.some((t) => t.length === 1)) ? 2 : lastHit ? 1 : 0;
    if (score === 0) continue;
    if (score > bestScore) {
      best = p;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** Värdet för en summa, eller null om någon komponents nyckel saknas i hela matchen. */
function playerSum(lineups: Lineups, p: PlayerLine, sum: PlayerSum): { value: number; keys: string[] } | null {
  let value = 0;
  const keys: string[] = [];
  for (const candidates of sum) {
    const key = candidates.find((k) => hasStatKey(lineups, k));
    if (!key) return null;
    keys.push(key);
    // Sofascore utelämnar nollor — saknas nyckeln hos spelaren är värdet 0.
    // (ESPN och NHL skriver ut nollorna.)
    value += p.stats[key] ?? 0;
  }
  return { value, keys };
}

/** Vilket lag selection-texten pekar på, om exakt ett. */
export function teamSideOf(selection: string, bet: PropBet, event: MatchEvent): "home" | "away" | null {
  const teams = teamsOf(bet);
  const sim = (names: (string | null | undefined)[]) =>
    Math.max(0, ...names.filter((n): n is string => !!n).map((n) => teamSimilarity(selection, n)));
  const home = sim([teams?.home, event.homeTeam.name, event.homeTeam.shortName]) >= MIN_TEAM_SIMILARITY;
  const away = sim([teams?.away, event.awayTeam.name, event.awayTeam.shortName]) >= MIN_TEAM_SIMILARITY;
  if (home === away) return null;
  return home ? "home" : "away";
}

function overUnder(side: "over" | "under", line: number, value: number): Outcome | null {
  return gradeBet({ market: "totals", selectionSide: side, line }, { homeScore: value, awayScore: 0 });
}

const sideLabel = (side: "over" | "under") => (side === "over" ? "över" : "under");

/** Rättar betet ur matchdatan. */
export function gradeProp(bet: PropBet, need: PropNeed, data: MatchData): Graded {
  const { event } = data;
  const match = `${event.homeTeam.name}–${event.awayTeam.name}`;
  const ref = `${data.source} ${event.id}`;
  if (event.status !== "finished") return no(`${match}: inte färdigspelad (${event.status})`, true);

  if (need.kind === "btts") {
    if (event.homeScore == null || event.awayScore == null) {
      return no(`${match}: resultatet efter ordinarie tid är okänt (${event.statusDescription ?? "förlängning?"})`);
    }
    const both = event.homeScore > 0 && event.awayScore > 0;
    const outcome: Outcome = both === need.yes ? "win" : "loss";
    return {
      ok: true,
      outcome,
      value: both ? 1 : 0,
      reason: `BTTS ${need.yes ? "ja" : "nej"}: ${match} ${event.homeScore}–${event.awayScore} efter ordinarie tid (${ref})`,
    };
  }

  const { spec, side, line, scope, category } = need;
  let value: number;
  let detail: string;

  if (scope === "player") {
    if (!data.lineups || data.lineups.players.length === 0) return no(`${match}: lineups saknas`);
    const p = findPlayer(bet.selection, data.lineups);
    if (!p) return no(`hittar ingen (entydig) spelare i "${bet.selection}"`);
    if (!playerPlayed(p)) return no(`${p.name} spelade inte — bolagets regler avgör (ofta void)`, true);
    const r = playerSum(data.lineups, p, spec.player!.sum) ?? (spec.player!.fallback ? playerSum(data.lineups, p, spec.player!.fallback) : null);
    if (!r) return no(`${category}: fältet finns inte i matchens spelardata`);
    value = r.value;
    detail = `${p.name} ${value}`;
  } else {
    let pair: StatPair | null = null;
    let source = "";
    if (spec.score) {
      const h = spec.score === "normal" ? event.homeScore : event.homeScoreFinal;
      const a = spec.score === "normal" ? event.awayScore : event.awayScoreFinal;
      if (h != null && a != null) pair = { home: h, away: a };
      source = spec.score === "normal" ? "ordinarie tid" : "inkl. förlängning";
    } else if (spec.team) {
      const key = spec.team.find((k) => data.stats && k in data.stats);
      if (key) pair = data.stats![key];
      source = "lagstatistik";
    }
    if (!pair) return no(`${match}: ${category} saknas i ${data.source}s data`);
    if (scope === "team") {
      const which = teamSideOf(bet.selection, bet, event);
      if (!which) return no(`kan inte avgöra vilket lag "${bet.selection}" gäller`);
      value = pair[which];
      detail = `${which === "home" ? event.homeTeam.name : event.awayTeam.name} ${value}`;
    } else {
      value = pair.home + pair.away;
      detail = `${pair.home}+${pair.away}=${value}`;
    }
    detail += ` (${source})`;
  }

  const outcome = overUnder(side, line, value);
  if (!outcome) return no("kunde inte rätta linjen");
  const label = category.charAt(0).toUpperCase() + category.slice(1);
  return {
    ok: true,
    outcome,
    value,
    reason: `${label} ${sideLabel(side)} ${line}: ${detail} · ${match} (${ref})`,
  };
}
