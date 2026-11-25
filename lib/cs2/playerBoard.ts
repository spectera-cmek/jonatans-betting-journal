// Spelartavlan: kills-props bedömda som Jonatan gör det — form, karta och
// motstånd mot bokens linje — med modellen som en referens bland andra.
//
// Allt här är rena funktioner utan databas, så att klienten kan räkna om
// träffbilden direkt när en annan linje skrivs in (böckerna Jonatan spelar
// kills hos — Spelklubben, Coolbet, Svenska Spel, NordicBet — hämtas inte
// automatiskt; Unibets linje är bara en referens för var marknaden ligger).
//
// Kills är HLTV-scoreboarden för hela kartan, övertid inräknad — samma siffra
// böckerna rättar mot.

import { mapLabel } from "./maps";

export type BoardScope = "map1" | "map2" | "map3" | "maps12";

export const BOARD_SCOPE_LABEL: Record<BoardScope, string> = {
  map1: "Karta 1",
  map2: "Karta 2",
  map3: "Karta 3",
  maps12: "Karta 1–2",
};

/** En spelad karta för spelaren. */
export interface BoardMap {
  mapId: number;
  matchId: number;
  mapNumber: number;
  mapName: string;
  playedAt: string;
  /** Motståndarlaget på kartan. */
  oppId: number;
  kills: number;
  /** Rundor spelarens lag vann / förlorade. */
  won: number;
  lost: number;
}

export interface BoardTeamRef {
  id: number;
  name: string;
  rank: number | null;
}

export interface BoardPlayer {
  playerId: number;
  nickname: string;
  teamId: number;
  side: 1 | 2;
  role: string | null;
  /** Kartor inom perioden, nyast först. */
  maps: BoardMap[];
}

export interface BoardLine {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  bookmaker: string | null;
  source: string | null;
  createdAt: string | null;
}

export interface BoardModel {
  mean: number;
  /** Linjen där modellen ger närmast 50 %. */
  median: number;
  /** P(över) per halvlinje runt medianen. */
  lines: Array<{ line: number; pOver: number }>;
}

export interface PlayerBoardData {
  scopes: BoardScope[];
  /** Matchens två lag. */
  team1: BoardTeamRef;
  team2: BoardTeamRef;
  /** Alla motståndare i historiken (namn och nuvarande rank). */
  teams: Record<number, BoardTeamRef>;
  /** P(kartan spelas på positionen), per scope. */
  mapWeights: Partial<Record<BoardScope, Array<{ map: string; w: number }>>>;
  players: BoardPlayer[];
  /** Senaste kills-linjen per `${playerId}|${scope}`. */
  lines: Record<string, BoardLine>;
  /** Modellen per `${playerId}|${scope}`. */
  model: Record<string, BoardModel>;
}

export const boardKey = (playerId: number, scope: BoardScope) => `${playerId}|${scope}`;

// ---------------------------------------------------------------------------
// Urval
// ---------------------------------------------------------------------------

/** Ett utfall att jämföra med linjen: en karta, eller karta 1+2 i en serie. */
export interface KillSample {
  kills: number;
  rounds: number;
  /** Kartorna i utfallet (en, eller två för karta 1–2). */
  maps: string[];
  playedAt: string;
  oppId: number;
  matchId: number;
  /** Rundresultat ur spelarens lags perspektiv, t.ex. "13–11" eller "13–11, 9–13". */
  score: string;
  /** Laget vann kartan (karta 1–2: vann båda). */
  won: boolean;
}

/**
 * Utfallen för en scope, nyast först. Kartlinjer jämförs mot varje enskild
 * karta (en spelares kills på en karta, oavsett om den var karta 1 eller 2 i
 * serien). Karta 1–2 jämförs mot summan av seriens två första kartor, så
 * bara serier där båda finns räknas.
 */
export function samplesFor(maps: BoardMap[], scope: BoardScope): KillSample[] {
  // Kartorna i en serie har samma tid (seriens start): senare karta = nyare.
  const sorted = [...maps].sort((a, b) => b.playedAt.localeCompare(a.playedAt) || b.mapNumber - a.mapNumber);
  if (scope !== "maps12") {
    return sorted.map((m) => ({
      kills: m.kills,
      rounds: m.won + m.lost,
      maps: [m.mapName],
      playedAt: m.playedAt,
      oppId: m.oppId,
      matchId: m.matchId,
      score: `${m.won}–${m.lost}`,
      won: m.won > m.lost,
    }));
  }
  const byMatch = new Map<number, BoardMap[]>();
  for (const m of sorted) byMatch.set(m.matchId, [...(byMatch.get(m.matchId) ?? []), m]);
  const out: KillSample[] = [];
  for (const ms of byMatch.values()) {
    const m1 = ms.find((m) => m.mapNumber === 1);
    const m2 = ms.find((m) => m.mapNumber === 2);
    if (!m1 || !m2) continue;
    out.push({
      kills: m1.kills + m2.kills,
      rounds: m1.won + m1.lost + m2.won + m2.lost,
      maps: [m1.mapName, m2.mapName],
      playedAt: m1.playedAt,
      oppId: m1.oppId,
      matchId: m1.matchId,
      score: `${m1.won}–${m1.lost}, ${m2.won}–${m2.lost}`,
      // Vann båda kartorna (2–0 efter karta 2).
      won: m1.won > m1.lost && m2.won > m2.lost,
    });
  }
  return out.sort((a, b) => b.playedAt.localeCompare(a.playedAt));
}

export interface HitStats {
  n: number;
  over: number;
  under: number;
  /** Exakt på en heltalslinje — pengarna tillbaka, räknas varken som över eller under. */
  push: number;
  avg: number | null;
}

export function hitStats(samples: KillSample[], line: number): HitStats {
  let over = 0,
    under = 0,
    push = 0,
    sum = 0;
  for (const s of samples) {
    sum += s.kills;
    if (s.kills > line) over++;
    else if (s.kills < line) under++;
    else push++;
  }
  return { n: samples.length, over, under, push, avg: samples.length ? sum / samples.length : null };
}

/** Andel över bland de avgjorda (push borträknade), eller null utan utfall. */
export function overRate(s: HitStats): number | null {
  const d = s.over + s.under;
  return d > 0 ? s.over / d : null;
}

// ---------------------------------------------------------------------------
// Motståndets nivå
// ---------------------------------------------------------------------------

export interface RankTier {
  key: string;
  label: string;
}

const TIERS: Array<{ lo: number; hi: number; key: string; label: string }> = [
  { lo: 1, hi: 10, key: "t10", label: "topp 10" },
  { lo: 11, hi: 20, key: "t20", label: "rank 11–20" },
  { lo: 21, hi: 30, key: "t30", label: "rank 21–30" },
  { lo: 31, hi: 50, key: "t50", label: "rank 31–50" },
];

/** Nivån ur lagets nuvarande VRS-rank. Utanför topp 50 och orankade är en grupp. */
export function rankTier(rank: number | null | undefined): RankTier {
  const t = rank != null ? TIERS.find((x) => rank >= x.lo && rank <= x.hi) : undefined;
  return t ? { key: t.key, label: t.label } : { key: "rest", label: "utanför topp 50" };
}

// ---------------------------------------------------------------------------
// Bedömning
// ---------------------------------------------------------------------------

/** Vart ett underlag pekar. "thin" = för få utfall för att säga något. */
export type Lean = "over" | "under" | "even" | "thin";

/** Minsta antal avgjorda utfall innan ett underlag får peka åt något håll. */
export const MIN_SAMPLES = 4;
/** Andel över (eller under) som krävs för att ett underlag ska peka. */
export const LEAN_RATE = 0.6;

export function leanOf(s: HitStats, minN = MIN_SAMPLES): Lean {
  const r = overRate(s);
  if (r == null || s.over + s.under < minN) return "thin";
  if (r >= LEAN_RATE) return "over";
  if (r <= 1 - LEAN_RATE) return "under";
  return "even";
}

export interface MapRow {
  map: string;
  label: string;
  /** P(kartan spelas på positionen). */
  w: number;
  stats: HitStats;
}

export interface CardView {
  playerId: number;
  nickname: string;
  role: string | null;
  side: 1 | 2;
  teamId: number;
  line: number;
  /** Var linjen kom ifrån: bokens sparade, inskriven nu, eller modellens. */
  lineFrom: "book" | "typed" | "model" | "form";
  book: BoardLine | null;
  form: { samples: KillSample[]; stats: HitStats; lean: Lean };
  map: {
    rows: MapRow[];
    lean: Lean;
    /** Karta 1–2: förväntade kills ur snittet på de troliga kartorna. */
    expected: number | null;
    /** Kartornas viktade andel över (kartlinjer). */
    rate: number | null;
    n: number;
  };
  h2h: { opponent: BoardTeamRef; samples: KillSample[]; stats: HitStats; lean: Lean };
  tier: { label: string; stats: HitStats; lean: Lean };
  model: { mean: number | null; median: number | null; pOver: number | null };
  /** Hur många underlag som pekar över respektive under. */
  signal: { over: number; under: number; counted: number };
}

/** Antal kartor (eller serier) i formgrafen. */
export const FORM_N = 10;

function modelPOver(m: BoardModel | undefined, line: number): number | null {
  if (!m) return null;
  const hit = m.lines.find((x) => Math.abs(x.line - line) < 1e-9);
  return hit ? hit.pOver : null;
}

/**
 * Ett spelarkort för en scope och linje. Utan given linje används bokens
 * sparade, annars modellens medianlinje, annars medianen av formen.
 */
export function buildCard(data: PlayerBoardData, player: BoardPlayer, scope: BoardScope, typedLine?: number | null): CardView {
  const key = boardKey(player.playerId, scope);
  const book = data.lines[key] ?? null;
  const model = data.model[key];
  const samples = samplesFor(player.maps, scope);

  let line: number;
  let lineFrom: CardView["lineFrom"];
  if (typedLine != null && Number.isFinite(typedLine)) {
    line = typedLine;
    lineFrom = "typed";
  } else if (book) {
    line = book.line;
    lineFrom = "book";
  } else if (model) {
    line = model.median;
    lineFrom = "model";
  } else {
    const ks = samples.slice(0, FORM_N).map((s) => s.kills).sort((a, b) => a - b);
    line = ks.length ? Math.floor(ks[Math.floor(ks.length / 2)]) + 0.5 : 0.5;
    lineFrom = "form";
  }

  // Form: de senaste, äldst först så att grafen läses vänster → höger.
  const recent = samples.slice(0, FORM_N);
  const formStats = hitStats(recent, line);
  const form = { samples: [...recent].reverse(), stats: formStats, lean: leanOf(formStats) };

  // Kartan: utfall på de kartor som troligen spelas på positionen.
  const mapAxis = mapAxisFor(data, player, scope, line, samples);

  // Motståndet: tidigare möten med just det här laget, och lag på samma nivå.
  const opponent = player.side === 1 ? data.team2 : data.team1;
  const h2hSamples = samples.filter((s) => s.oppId === opponent.id);
  const h2hStats = hitStats(h2hSamples, line);
  const tier = rankTier(opponent.rank);
  const tierSamples = samples.filter((s) => rankTier(data.teams[s.oppId]?.rank).key === tier.key);
  const tierStats = hitStats(tierSamples, line);

  const h2h = { opponent, samples: h2hSamples, stats: h2hStats, lean: leanOf(h2hStats) };
  const tierView = { label: tier.label, stats: tierStats, lean: leanOf(tierStats) };

  const leans = [form.lean, mapAxis.lean, tierView.lean, h2h.lean].filter((l) => l !== "thin");
  return {
    playerId: player.playerId,
    nickname: player.nickname,
    role: player.role,
    side: player.side,
    teamId: player.teamId,
    line,
    lineFrom,
    book,
    form,
    map: mapAxis,
    h2h,
    tier: tierView,
    model: { mean: model?.mean ?? null, median: model?.median ?? null, pOver: modelPOver(model, line) },
    signal: { over: leans.filter((l) => l === "over").length, under: leans.filter((l) => l === "under").length, counted: leans.length },
  };
}

/** Kartor under den här sannolikheten visas inte — de spelas nästan aldrig på positionen. */
const MIN_MAP_W = 0.08;

function mapAxisFor(data: PlayerBoardData, player: BoardPlayer, scope: BoardScope, line: number, samples: KillSample[]): CardView["map"] {
  if (scope === "maps12") {
    // Karta 1–2 är två kartor: förväntade kills = summan av spelarens snitt
    // på varje position, viktat med vetot. Kartor utan utfall får hans snitt.
    const perMap = samplesFor(player.maps, "map1");
    const overall = perMap.length ? perMap.reduce((a, s) => a + s.kills, 0) / perMap.length : null;
    let expected = 0;
    let known = true;
    const rows = new Map<string, MapRow>();
    for (const pos of ["map1", "map2"] as const) {
      for (const { map, w } of data.mapWeights[pos] ?? []) {
        const on = perMap.filter((s) => s.maps[0] === map);
        const avg = on.length ? on.reduce((a, s) => a + s.kills, 0) / on.length : overall;
        if (avg == null) known = false;
        else expected += w * avg;
        if (w >= MIN_MAP_W) {
          const r = rows.get(map);
          const stats = hitStats(on, line / 2);
          rows.set(map, { map, label: mapLabel(map), w: (r?.w ?? 0) + w, stats });
        }
      }
    }
    const exp = known && (data.mapWeights.map1?.length ?? 0) > 0 ? expected : null;
    const lean: Lean = exp == null ? "thin" : exp >= line + 1 ? "over" : exp <= line - 1 ? "under" : "even";
    const n = [...rows.values()].reduce((a, r) => a + r.stats.n, 0);
    return { rows: [...rows.values()].sort((a, b) => b.w - a.w).slice(0, 3), lean: n < MIN_SAMPLES ? "thin" : lean, expected: exp, rate: null, n };
  }
  const weights = (data.mapWeights[scope] ?? []).filter((x) => x.w >= MIN_MAP_W).sort((a, b) => b.w - a.w);
  const rows: MapRow[] = weights.map(({ map, w }) => ({ map, label: mapLabel(map), w, stats: hitStats(samples.filter((s) => s.maps[0] === map), line) }));
  // Kartornas andel över, viktad med hur troligt varje karta spelas.
  let wSum = 0,
    rSum = 0,
    n = 0;
  for (const r of rows) {
    const rate = overRate(r.stats);
    n += r.stats.over + r.stats.under;
    if (rate == null) continue;
    wSum += r.w;
    rSum += r.w * rate;
  }
  const rate = wSum > 0 ? rSum / wSum : null;
  const lean: Lean = rate == null || n < MIN_SAMPLES ? "thin" : rate >= LEAN_RATE ? "over" : rate <= 1 - LEAN_RATE ? "under" : "even";
  return { rows: rows.slice(0, 3), lean, expected: null, rate, n };
}

/** Ordning på tavlan: flest underlag åt samma håll först, sedan formens styrka. */
export function signalStrength(c: CardView): number {
  const agree = Math.max(c.signal.over, c.signal.under);
  const r = overRate(c.form.stats);
  return agree * 10 + (r == null ? 0 : Math.abs(r - 0.5) * 2);
}
