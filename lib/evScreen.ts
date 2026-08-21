// EV-skärmen: läser lagrade bookmakerpriser, sätter fair line ur börsen eller
// Pinnacle, och rankar utfall där en bok ligger över.
//
// Ingen modell inblandad — marknaden är facit. Se lib/marketOdds.ts för matten.

import { shotsPrisma as prisma } from "./shotsDb";
import {
  DEFAULT_MAX_DISAGREEMENT,
  MARKET_LABEL,
  normalizeHandicap,
  priceMarket,
  verifyHandicapSigns,
  type BookMarket,
  type LiquidityOptions,
  type OddsMarket,
  type OddsOutcome,
  type OutcomePrice,
} from "./marketOdds";
import { EV_LEAGUE_REGISTRY } from "./oddsApiMap";

/**
 * Ligor skärmen täcker — Premier League, LaLiga, Serie A och Bundesliga.
 *
 * Kommer från `EV_LEAGUE_REGISTRY` och inte längre från skottmodellens
 * `SHOT_LEAGUES`. Det gamla beroendet drog dessutom in `lib/theStatsApi` i
 * EV-kedjan via `shotData`, trots att TheStatsAPI är utkopplat härifrån.
 */
export const EV_LEAGUES = EV_LEAGUE_REGISTRY;

export const EV_MARKETS: OddsMarket[] = ["1x2", "totals", "ah"];

const OUTCOMES: Record<OddsMarket, OddsOutcome[]> = {
  "1x2": ["home", "draw", "away"],
  totals: ["over", "under"],
  ah: ["home", "away"],
};

export interface EvRow {
  matchId: string;
  leagueKey: string;
  leagueLabel: string;
  kickoffAt: string;
  homeTeam: string;
  awayTeam: string;

  market: OddsMarket;
  marketLabel: string;
  outcome: OddsOutcome;
  /** "Arsenal", "Oavgjort", "Över 2,5" — vad man faktiskt spelar. */
  outcomeLabel: string;
  line: number | null;

  fairProb: number;
  fairOdds: number;
  bestBook: string | null;
  bestOdds: number | null;
  /** EV per satsad enhet. 0.03 = +3 %. */
  edge: number;

  /** Vilken referens som användes och hur mycket den gick att lita på. */
  refSource: "exchange" | "pinnacle";
  refMinSize: number | null;
  refSpreadPct: number | null;
  refOverround: number;
  /** Hur långt isär de två skarpa källorna låg. Null när bara en fanns. */
  refDisagreement: number | null;

  /** Alla böckers pris på utfallet, för detaljvyn. */
  books: Array<{ bookmaker: string; odds: number }>;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Matchgrupperad vy
//
// EvRow är en rad per UTFALL och bara de som passerar minEdge — bra för att
// hitta edges, oanvändbart för att jämföra en match. Strukturen nedan bär hela
// matchen: varje marknad, varje utfall, varje boks pris, även de negativa.
// Utan de negativa går det inte att se att en bok ligger efter marknaden.
// ---------------------------------------------------------------------------

export interface EvMatchOutcome {
  outcome: OddsOutcome;
  /** "Arsenal", "Oavgjort", "Över 2,5" — vad man faktiskt spelar. */
  outcomeLabel: string;
  /** Kort etikett för kolumnhuvuden: "1", "X", "2", "Ö 2,5". */
  shortLabel: string;
  fairProb: number;
  fairOdds: number;
  bestBook: string | null;
  bestOdds: number | null;
  /** EV per satsad enhet. 0.03 = +3 %. */
  edge: number;
  /**
   * Pris per bok, i samma ordning som EvMatch.books. null = boken saknar pris.
   * En array i stället för ett objekt per utfall: med ~20 böcker och ~10 utfall
   * per match sparar det en tredjedel av svarets storlek.
   */
  prices: Array<number | null>;
}

export interface EvMatchMarket {
  market: OddsMarket;
  marketLabel: string;
  line: number | null;
  /** Referensens overround före normalisering. 0.056 = 5,6 % marginal. */
  overround: number;
  /**
   * Utbetalning om man tar bästa spelbara pris på varje utfall:
   * 1 / Σ(1/bästa odds). 0,981 visas som 98,1 %.
   *
   * Det spelbolagen kallar utbetalningsprocent, fast räknat tvärs över alla
   * böcker. **Över 100 % betyder arbitrage** — då går alla utfall att täcka med
   * vinst. Null när något utfall saknar spelbart pris, för då finns ingen
   * fullständig kombination att räkna på.
   */
  bestPayout: number | null;
  refSource: "exchange" | "pinnacle";
  refMinSize: number | null;
  refSpreadPct: number | null;
  refDisagreement: number | null;
  outcomes: EvMatchOutcome[];
  /** Bästa EV i marknaden. */
  bestEdge: number;
}

export interface EvMatch {
  matchId: string;
  leagueKey: string;
  leagueLabel: string;
  kickoffAt: string;
  homeTeam: string;
  awayTeam: string;
  /** Böckerna som har minst ett pris i matchen — kolumnordning för rutnätet. */
  books: string[];
  markets: EvMatchMarket[];
  /** Bästa EV i hela matchen, för sortering. */
  bestEdge: number;
  /** Marknader som hölls tillbaka för att de skarpa källorna var oense. */
  suppressed: number;
  capturedAt: string;
}

export interface EvMeta {
  leagues: Array<{ key: string; label: string }>;
  fixtures: number;
  pricedOutcomes: number;
  /** Böcker vars handikappstecken inte gick att verifiera mot verkligheten. */
  handicapSignWarnings: string[];
  /** Marknader som hölls tillbaka för att de skarpa källorna var oense. */
  suppressedDisagreement: number;
  /** true när inga priser finns lagrade alls. */
  missingPrices: boolean;
  capturedAt: string | null;
  dbConfigured: boolean;
}

export interface EvScreenOptions {
  leagueKeys?: string[];
  markets?: OddsMarket[];
  /** Lägsta EV som tas med, som andel (0.02 = 2 %). */
  minEdge?: number;
  horizonDays?: number;
  limit?: number;
  liquidity?: LiquidityOptions;
  /** Största tillåtna avvikelse mellan börsen och Pinnacle. */
  maxDisagreement?: number;
}

interface PriceRow {
  matchId: string;
  bookmaker: string;
  market: string;
  outcome: string;
  line: number | null;
  odds: number;
  layOdds: number | null;
  backSize: number | null;
  laySize: number | null;
  capturedAt: Date;
}

const fmtLine = (n: number) => String(n).replace(".", ",");

function outcomeLabel(
  market: OddsMarket,
  outcome: OddsOutcome,
  line: number | null,
  home: string,
  away: string
): string {
  if (market === "1x2") {
    return outcome === "home" ? home : outcome === "away" ? away : "Oavgjort";
  }
  if (market === "totals") {
    return `${outcome === "over" ? "Över" : "Under"} ${line == null ? "" : fmtLine(line)}`.trim();
  }
  // Handikapp: linjen hör till laget, och tecknet är redan normaliserat.
  const team = outcome === "home" ? home : away;
  const own = outcome === "home" ? line : line == null ? null : -line;
  return own == null ? team : `${team} ${own > 0 ? "+" : ""}${fmtLine(own)}`;
}

/** Kort etikett för kolumnhuvuden i rutnätet: "1", "X", "2", "Ö 2,5". */
function shortOutcomeLabel(
  market: OddsMarket,
  outcome: OddsOutcome,
  line: number | null
): string {
  if (market === "1x2") {
    return outcome === "home" ? "1" : outcome === "away" ? "2" : "X";
  }
  if (market === "totals") {
    return `${outcome === "over" ? "Ö" : "U"} ${line == null ? "" : fmtLine(line)}`.trim();
  }
  const own = outcome === "home" ? line : line == null ? null : -line;
  const side = outcome === "home" ? "1" : "2";
  return own == null ? side : `${side} ${own > 0 ? "+" : ""}${fmtLine(own)}`;
}

/**
 * Grupperar prisrader till marknader som går att prissätta.
 *
 * 1X2 grupperas per match. Över/under per match och linje. Handikapp per match
 * och NORMALISERAD hemmalinje — böckerna lagrar tecknet olika, och bortasidan
 * ligger på den spegelvända linjen.
 */
function groupMarkets(rows: PriceRow[]): Map<string, { market: OddsMarket; line: number | null; books: BookMarket[] }> {
  const groups = new Map<string, { market: OddsMarket; line: number | null; byBook: Map<string, OutcomePrice[]> }>();

  for (const r of rows) {
    const market = r.market as OddsMarket;
    if (!EV_MARKETS.includes(market)) continue;

    let line: number | null = null;
    let outcome = r.outcome as OddsOutcome;

    if (market === "totals") {
      if (r.line == null) continue;
      line = r.line;
    } else if (market === "ah") {
      const norm = normalizeHandicap(r.bookmaker, r.line ?? NaN);
      if (norm == null) continue;
      // Nyckeln är alltid hemmalagets linje; bortasidans är spegelvänd.
      line = outcome === "home" ? norm : -norm;
    }

    const key = `${r.matchId}|${market}|${line ?? "-"}`;
    let g = groups.get(key);
    if (!g) {
      g = { market, line, byBook: new Map() };
      groups.set(key, g);
    }
    const list = g.byBook.get(r.bookmaker) ?? [];
    list.push({
      outcome,
      odds: r.odds,
      layOdds: r.layOdds,
      backSize: r.backSize,
      laySize: r.laySize,
    });
    g.byBook.set(r.bookmaker, list);
  }

  const out = new Map<string, { market: OddsMarket; line: number | null; books: BookMarket[] }>();
  for (const [key, g] of groups) {
    out.set(key, {
      market: g.market,
      line: g.line,
      books: [...g.byBook.entries()].map(([bookmaker, outcomes]) => ({ bookmaker, outcomes })),
    });
  }
  return out;
}

export async function buildEvScreen(
  opts: EvScreenOptions = {}
): Promise<{ rows: EvRow[]; meta: EvMeta }> {
  const leagues = opts.leagueKeys?.length
    ? EV_LEAGUES.filter((l) => opts.leagueKeys!.includes(l.key))
    : EV_LEAGUES;
  const markets = opts.markets?.length ? opts.markets : EV_MARKETS;
  const minEdge = opts.minEdge ?? 0;
  const horizonDays = opts.horizonDays ?? 14;
  const limit = opts.limit ?? 300;
  const maxDisagreement = opts.maxDisagreement ?? DEFAULT_MAX_DISAGREEMENT;

  const now = new Date();
  const until = new Date(now.getTime() + horizonDays * 86_400_000);
  const leagueLabels = new Map(EV_LEAGUES.map((l) => [l.key, l.label]));

  const fixtures = await prisma.shotMatch.findMany({
    where: {
      leagueKey: { in: leagues.map((l) => l.key) },
      status: "scheduled",
      kickoffAt: { gte: now, lte: until },
    },
    orderBy: { kickoffAt: "asc" },
    select: {
      id: true,
      leagueKey: true,
      kickoffAt: true,
      homeTeamName: true,
      awayTeamName: true,
    },
  });

  if (fixtures.length === 0) {
    return {
      rows: [],
      meta: {
        leagues: EV_LEAGUES.map((l) => ({ key: l.key, label: l.label })),
        fixtures: 0,
        pricedOutcomes: 0,
        suppressedDisagreement: 0,
        handicapSignWarnings: [],
        missingPrices: true,
        capturedAt: null,
        dbConfigured: true,
      },
    };
  }

  const prices = (await prisma.marketPrice.findMany({
    where: { matchId: { in: fixtures.map((f) => f.id) }, market: { in: markets } },
    select: {
      matchId: true, bookmaker: true, market: true, outcome: true, line: true,
      odds: true, layOdds: true, backSize: true, laySize: true, capturedAt: true,
    },
  })) as PriceRow[];

  // Kontrollera handikappens teckenkonvention mot verkligheten innan de visas.
  // Favoriten är laget med lägst 1X2-pris hos vilken bok som helst.
  const favouriteByMatch = new Map<string, "home" | "away">();
  for (const f of fixtures) {
    const x2 = prices.filter((p) => p.matchId === f.id && p.market === "1x2");
    const home = Math.min(...x2.filter((p) => p.outcome === "home").map((p) => p.odds), Infinity);
    const away = Math.min(...x2.filter((p) => p.outcome === "away").map((p) => p.odds), Infinity);
    if (Number.isFinite(home) && Number.isFinite(away)) {
      favouriteByMatch.set(f.id, home <= away ? "home" : "away");
    }
  }
  const signSamples = prices
    .filter((p) => p.market === "ah" && p.line != null)
    .map((p) => ({
      bookmaker: p.bookmaker,
      line: p.line as number,
      odds: p.odds,
      isFavourite: favouriteByMatch.get(p.matchId) === p.outcome,
    }));
  const handicapSignWarnings = verifyHandicapSigns(signSamples);

  const byMatch = new Map<string, PriceRow[]>();
  for (const p of prices) {
    const list = byMatch.get(p.matchId);
    if (list) list.push(p);
    else byMatch.set(p.matchId, [p]);
  }

  const rows: EvRow[] = [];
  let pricedOutcomes = 0;
  let suppressed = 0;
  let latest: Date | null = null;

  for (const f of fixtures) {
    const matchPrices = byMatch.get(f.id);
    if (!matchPrices?.length) continue;
    for (const p of matchPrices) {
      if (!latest || p.capturedAt > latest) latest = p.capturedAt;
    }

    for (const g of groupMarkets(matchPrices).values()) {
      // Handikapp visas bara när teckenkonventionen gick att verifiera —
      // hellre ingen marknad än en påhittad edge.
      if (g.market === "ah" && handicapSignWarnings.length > 0) continue;

      const priced = priceMarket(g.books, OUTCOMES[g.market], opts.liquidity);
      if (!priced) continue;
      pricedOutcomes += priced.outcomes.length;

      // Är de två skarpa källorna för oense är minst en inaktuell, och EV:n
      // byter tecken beroende på vilken som råkade väljas. Hellre ingen rad.
      const disagreement = priced.reference.disagreement;
      if (disagreement != null && disagreement > maxDisagreement) {
        suppressed += 1;
        continue;
      }

      for (const o of priced.outcomes) {
        if (o.bestOdds == null || o.bestBook == null) continue;
        if (o.edge < minEdge) continue;

        const books: Array<{ bookmaker: string; odds: number }> = [];
        for (const b of g.books) {
          const price = b.outcomes.find((x) => x.outcome === o.outcome);
          if (price?.odds != null) books.push({ bookmaker: b.bookmaker, odds: price.odds });
        }
        books.sort((a, b) => b.odds - a.odds);

        rows.push({
          matchId: f.id,
          leagueKey: f.leagueKey,
          leagueLabel: leagueLabels.get(f.leagueKey) ?? f.leagueKey,
          kickoffAt: f.kickoffAt.toISOString(),
          homeTeam: f.homeTeamName,
          awayTeam: f.awayTeamName,
          market: g.market,
          marketLabel: MARKET_LABEL[g.market],
          outcome: o.outcome,
          outcomeLabel: outcomeLabel(g.market, o.outcome, g.line, f.homeTeamName, f.awayTeamName),
          line: g.line,
          fairProb: o.fairProb,
          fairOdds: o.fairOdds,
          bestBook: o.bestBook,
          bestOdds: o.bestOdds,
          edge: o.edge,
          refSource: priced.reference.source,
          refMinSize: priced.reference.minSize,
          refSpreadPct: priced.reference.spreadPct,
          refOverround: priced.reference.overround,
          refDisagreement: priced.reference.disagreement,
          books,
          capturedAt: (matchPrices[0]?.capturedAt ?? new Date()).toISOString(),
        });
      }
    }
  }

  rows.sort((a, b) => b.edge - a.edge);

  return {
    rows: rows.slice(0, limit),
    meta: {
      leagues: EV_LEAGUES.map((l) => ({ key: l.key, label: l.label })),
      fixtures: fixtures.length,
      pricedOutcomes,
      suppressedDisagreement: suppressed,
      handicapSignWarnings,
      missingPrices: prices.length === 0,
      capturedAt: latest ? latest.toISOString() : null,
      dbConfigured: true,
    },
  };
}

/**
 * Bygger den matchgrupperade jämförelsevyn.
 *
 * Samma matte och samma spärrar som `buildEvScreen` — skillnaden är formen:
 * här behålls ALLA utfall, även de med negativ EV, eftersom vyn ska visa hur
 * varje bok ligger mot marknaden och inte bara var det finns en edge.
 *
 * `minEdge` filtrerar därför MATCHER (matchens bästa EV måste nå tröskeln), inte
 * enskilda utfall. Annars hade en match visats med hål i rutnätet.
 */
export async function buildEvMatches(
  opts: EvScreenOptions = {}
): Promise<{ matches: EvMatch[]; meta: EvMeta }> {
  const leagues = opts.leagueKeys?.length
    ? EV_LEAGUES.filter((l) => opts.leagueKeys!.includes(l.key))
    : EV_LEAGUES;
  const markets = opts.markets?.length ? opts.markets : EV_MARKETS;
  const minEdge = opts.minEdge ?? 0;
  const horizonDays = opts.horizonDays ?? 14;
  const limit = opts.limit ?? 100;
  const maxDisagreement = opts.maxDisagreement ?? DEFAULT_MAX_DISAGREEMENT;

  const now = new Date();
  const until = new Date(now.getTime() + horizonDays * 86_400_000);
  const leagueLabels = new Map(EV_LEAGUES.map((l) => [l.key, l.label]));

  const fixtures = await prisma.shotMatch.findMany({
    where: {
      leagueKey: { in: leagues.map((l) => l.key) },
      status: "scheduled",
      kickoffAt: { gte: now, lte: until },
    },
    orderBy: { kickoffAt: "asc" },
    select: { id: true, leagueKey: true, kickoffAt: true, homeTeamName: true, awayTeamName: true },
  });

  const emptyMeta = (missing: boolean): EvMeta => ({
    leagues: EV_LEAGUES.map((l) => ({ key: l.key, label: l.label })),
    fixtures: fixtures.length,
    pricedOutcomes: 0,
    suppressedDisagreement: 0,
    handicapSignWarnings: [],
    missingPrices: missing,
    capturedAt: null,
    dbConfigured: true,
  });

  if (fixtures.length === 0) return { matches: [], meta: emptyMeta(true) };

  const prices = (await prisma.marketPrice.findMany({
    where: { matchId: { in: fixtures.map((f) => f.id) }, market: { in: markets } },
    select: {
      matchId: true, bookmaker: true, market: true, outcome: true, line: true,
      odds: true, layOdds: true, backSize: true, laySize: true, capturedAt: true,
    },
  })) as PriceRow[];

  if (prices.length === 0) return { matches: [], meta: emptyMeta(true) };

  // Samma teckenkontroll som den flata vyn — handikapp visas inte förrän
  // konventionen går att verifiera mot verkligheten.
  const favouriteByMatch = new Map<string, "home" | "away">();
  for (const f of fixtures) {
    const x2 = prices.filter((p) => p.matchId === f.id && p.market === "1x2");
    const home = Math.min(...x2.filter((p) => p.outcome === "home").map((p) => p.odds), Infinity);
    const away = Math.min(...x2.filter((p) => p.outcome === "away").map((p) => p.odds), Infinity);
    if (Number.isFinite(home) && Number.isFinite(away)) {
      favouriteByMatch.set(f.id, home <= away ? "home" : "away");
    }
  }
  const handicapSignWarnings = verifyHandicapSigns(
    prices
      .filter((p) => p.market === "ah" && p.line != null)
      .map((p) => ({
        bookmaker: p.bookmaker,
        line: p.line as number,
        odds: p.odds,
        isFavourite: favouriteByMatch.get(p.matchId) === p.outcome,
      }))
  );

  const byMatch = new Map<string, PriceRow[]>();
  for (const p of prices) {
    const list = byMatch.get(p.matchId);
    if (list) list.push(p);
    else byMatch.set(p.matchId, [p]);
  }

  const matches: EvMatch[] = [];
  let pricedOutcomes = 0;
  let suppressedTotal = 0;
  let latest: Date | null = null;

  for (const f of fixtures) {
    const matchPrices = byMatch.get(f.id);
    if (!matchPrices?.length) continue;
    for (const p of matchPrices) if (!latest || p.capturedAt > latest) latest = p.capturedAt;

    // Kolumnordning: böcker med flest priser först, så rutnätet fylls från
    // vänster. Referensböckerna sorteras in av UI:t, inte här.
    const bookCounts = new Map<string, number>();
    for (const p of matchPrices) bookCounts.set(p.bookmaker, (bookCounts.get(p.bookmaker) ?? 0) + 1);
    const books = [...bookCounts.keys()].sort(
      (a, b) => (bookCounts.get(b) ?? 0) - (bookCounts.get(a) ?? 0) || a.localeCompare(b)
    );
    const bookIndex = new Map(books.map((b, i) => [b, i]));

    const evMarkets: EvMatchMarket[] = [];
    let suppressed = 0;

    for (const g of groupMarkets(matchPrices).values()) {
      if (g.market === "ah" && handicapSignWarnings.length > 0) continue;

      const priced = priceMarket(g.books, OUTCOMES[g.market], opts.liquidity);
      if (!priced) continue;
      pricedOutcomes += priced.outcomes.length;

      const disagreement = priced.reference.disagreement;
      if (disagreement != null && disagreement > maxDisagreement) {
        suppressed += 1;
        continue;
      }

      const outcomes: EvMatchOutcome[] = [];
      for (const o of priced.outcomes) {
        const prices_: Array<number | null> = new Array(books.length).fill(null);
        for (const b of g.books) {
          const price = b.outcomes.find((x) => x.outcome === o.outcome);
          const idx = bookIndex.get(b.bookmaker);
          if (price?.odds != null && idx != null) prices_[idx] = price.odds;
        }
        outcomes.push({
          outcome: o.outcome,
          outcomeLabel: outcomeLabel(g.market, o.outcome, g.line, f.homeTeamName, f.awayTeamName),
          shortLabel: shortOutcomeLabel(g.market, o.outcome, g.line),
          fairProb: o.fairProb,
          fairOdds: o.fairOdds,
          bestBook: o.bestBook,
          bestOdds: o.bestOdds,
          edge: o.edge,
          prices: prices_,
        });
      }
      if (outcomes.length === 0) continue;

      // Utbetalning vid bästa spelbara pris. Summan av inverterade odds under 1
      // betyder att marknaden går att täcka med vinst.
      let inverseSum = 0;
      let allPriced = true;
      for (const o of outcomes) {
        if (o.bestOdds == null || o.bestOdds <= 1) { allPriced = false; break; }
        inverseSum += 1 / o.bestOdds;
      }

      // En linje som ingen spelbar bok kvoterar fullt ut är ingen jämförelse.
      // Referensens alternativa totals-linjer hämtas för att kunna PRISSÄTTA de
      // linjer böckerna faktiskt ligger på — inte för att visas i sig. Utan det
      // här filtret fylls varje match av nio rader där bara Pinnacle står, och
      // svaret växer från 44 kB till 199 kB utan att säga något.
      if (!allPriced) continue;

      evMarkets.push({
        market: g.market,
        marketLabel: MARKET_LABEL[g.market],
        line: g.line,
        overround: priced.reference.overround,
        bestPayout: allPriced && inverseSum > 0 ? 1 / inverseSum : null,
        refSource: priced.reference.source,
        refMinSize: priced.reference.minSize,
        refSpreadPct: priced.reference.spreadPct,
        refDisagreement: disagreement,
        outcomes,
        bestEdge: Math.max(...outcomes.map((o) => (o.bestOdds == null ? -Infinity : o.edge))),
      });
    }

    suppressedTotal += suppressed;
    if (evMarkets.length === 0) continue;

    // 1X2 först, sedan över/under efter linje, sedan handikapp — samma ordning
    // varje gång, så ögat hittar rätt marknad utan att leta.
    const order: Record<OddsMarket, number> = { "1x2": 0, totals: 1, ah: 2 };
    evMarkets.sort(
      (a, b) => order[a.market] - order[b.market] || (a.line ?? 0) - (b.line ?? 0)
    );

    matches.push({
      matchId: f.id,
      leagueKey: f.leagueKey,
      leagueLabel: leagueLabels.get(f.leagueKey) ?? f.leagueKey,
      kickoffAt: f.kickoffAt.toISOString(),
      homeTeam: f.homeTeamName,
      awayTeam: f.awayTeamName,
      books,
      markets: evMarkets,
      bestEdge: Math.max(...evMarkets.map((m) => m.bestEdge)),
      suppressed,
      capturedAt: (matchPrices[0]?.capturedAt ?? new Date()).toISOString(),
    });
  }

  const qualified = matches.filter((m) => Number.isFinite(m.bestEdge) && m.bestEdge >= minEdge);
  qualified.sort((a, b) => b.bestEdge - a.bestEdge);

  return {
    matches: qualified.slice(0, limit),
    meta: {
      leagues: EV_LEAGUES.map((l) => ({ key: l.key, label: l.label })),
      fixtures: fixtures.length,
      pricedOutcomes,
      suppressedDisagreement: suppressedTotal,
      handicapSignWarnings,
      missingPrices: false,
      capturedAt: latest ? latest.toISOString() : null,
      dbConfigured: true,
    },
  };
}
