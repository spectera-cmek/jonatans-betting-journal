// Oddsjämförelse: hitta böcker som ligger över marknadens skarpaste pris.
//
// Ingen modell och inga egna sannolikheter. Referensen är Betfair-börsens
// mittpunkt när den är likvid nog, annars avviggad Pinnacle. Edge är skillnaden
// mellan en boks pris och den referensen.
//
// Rent räknande: inga Prisma-anrop, ingen fetch. Speglar lib/fairOdds.ts.

import { devigProportional, priceEdge } from "./fairOdds";

export { priceEdge } from "./fairOdds";

/** Marknader skärmen täcker. */
export type OddsMarket = "1x2" | "totals" | "ah";

/** Utfall inom en marknad. 1X2 har tre, övriga två. */
export type OddsOutcome = "home" | "draw" | "away" | "over" | "under";

export const MARKET_LABEL: Record<OddsMarket, string> = {
  "1x2": "Matchresultat",
  totals: "Över/under mål",
  ah: "Asiatiskt handikapp",
};

/**
 * Börsen: minsta orderdjup per sida för att mitten ska duga som referens.
 *
 * Kalibrerad mot faktisk data, inte gissad. I 2 402 lagrade börsrader var
 * medianen på 1X2 omkring 33–45 och p90 runt 176–846 — betydligt tunnare än
 * enstaka storматcher antyder. En gräns på 500 släppte igenom noll matcher av
 * trettiotre; 100 släpper igenom de marknader som faktiskt har en bok bakom
 * sig. Faller kontrollen används Pinnacle, som också är skarp.
 */
export const DEFAULT_MIN_EXCHANGE_SIZE = 100;
/** Börsen: största relativa spread (lay/back − 1) som accepteras. */
export const DEFAULT_MAX_SPREAD_PCT = 5;

/**
 * Spreadgräns när orderdjupet är OKÄNT.
 *
 * The Odds API levererar börsens back och lay men inget djup. Utan ett mått på
 * hur mycket som ligger bakom priset måste spreaden ensam bära bedömningen, och
 * då krävs en snävare gräns än de 5 % som gäller när djupet går att kontrollera.
 *
 * Kalibrerad mot 1 208 börsmarknader där BÅDE djup och spread var kända
 * (TheStatsAPI-data, 2026-08-18). Andelen tunna marknader (djup < 100) per
 * spreadklass:
 *
 *     0–1 %:   0 %      3–5 %:  16 %
 *     1–2 %:   7 %      5–10 %: 32 %
 *     2–3 %:   5 %      >10 %:  66 %
 *
 * Vid 3 % är 5 % av marknaderna tunna — samma renhet som den djupbaserade
 * grinden ger idag. Vid 5 % stiger det till 10 %. Skillnaden mot att ha djupet
 * är alltså liten, men den är inte noll, och 3 % är priset för att slippa det.
 */
export const DEFAULT_MAX_SPREAD_PCT_NO_DEPTH = 3;

export const EXCHANGE_BOOK = "betfair-exchange";
export const PINNACLE_BOOK = "pinnacle";

/**
 * Börser vars back-pris aldrig är en spelbar destination.
 *
 * betfair-exchange är marknadsreferensen; matchbook är en börs på samma sätt —
 * dess "back" är ett orderbokspris, inte fastodds, och ofta tunt. Utan
 * matchbook här blev dess 10,00 på Elche "bästa pris" och en påhittad +22 %.
 * Betfair Sportsbook (betfair-sportsbook) är däremot en vanlig fastodds-bok och
 * står medvetet INTE här.
 */
export const EXCHANGE_BOOKS = new Set([EXCHANGE_BOOK, "matchbook"]);

const P_EPS = 1e-9;
const clampProb = (p: number) => Math.min(1 - P_EPS, Math.max(P_EPS, p));
const validOdds = (o: number | null | undefined): o is number =>
  typeof o === "number" && Number.isFinite(o) && o > 1;

/** Ett pris på ett utfall hos en bok. Börsen bär även motsatt sida och djup. */
export interface OutcomePrice {
  outcome: OddsOutcome;
  /** Bästa pris att spela (för börsen: bästa back). */
  odds: number | null;
  /** Börsen: bästa lay-pris. Null för fastodds-böcker. */
  layOdds?: number | null;
  /** Börsen: tillgängligt belopp på back respektive lay. */
  backSize?: number | null;
  laySize?: number | null;
}

export interface BookMarket {
  bookmaker: string;
  outcomes: OutcomePrice[];
}

// ---------------------------------------------------------------------------
// Börsens fair pris
// ---------------------------------------------------------------------------

export interface ExchangeMid {
  prob: number;
  /** Relativ spread (lay/back − 1) i procent. */
  spreadPct: number;
  /**
   * Minsta av de två sidornas djup — den som begränsar.
   *
   * **null betyder OKÄNT, inte noll.** Skillnaden är avgörande: en källa som
   * inte rapporterar djup (The Odds API) skulle med `0` se ut som en marknad
   * utan pengar bakom och alltid underkännas, vilket tyst hade stängt av
   * börsen som referens. Med null väljer `isLiquid` spreadvägen i stället.
   */
  size: number | null;
}

/**
 * Mittpunkten mellan bästa back och bästa lay, räknad i SANNOLIKHETSRUM:
 *   p = (1/back + 1/lay) / 2
 *
 * Att medelvärda oddsen direkt ((back+lay)/2) är skevt så fort spreaden är
 * bred, eftersom odds är en invers skala. På 1,20/1,21 spelar det ingen roll;
 * på 6,00/6,97 flyttar det fair-priset märkbart.
 *
 * Null när någon sida saknas — en ensam back-sida är bara ett pris, inte en
 * marknad, och säger inget om var mitten ligger.
 */
export function exchangeMid(price: OutcomePrice): ExchangeMid | null {
  const back = price.odds;
  const lay = price.layOdds;
  if (!validOdds(back) || !validOdds(lay)) return null;
  if (lay < back) return null; // korsad bok — data att inte lita på

  // Djup är OKÄNT (null) om någon sida saknar belopp — inte noll. The Odds API
  // lämnar båda tomma; TheStatsAPI fyllde dem. Ett `0` här hade fått varje
  // Odds-API-marknad att se pengalös ut och tyst stänga av börsen som referens.
  const backSize = price.backSize;
  const laySize = price.laySize;
  const size =
    backSize == null || laySize == null ? null : Math.min(backSize, laySize);

  return {
    prob: clampProb((1 / back + 1 / lay) / 2),
    spreadPct: (lay / back - 1) * 100,
    size,
  };
}

export interface LiquidityOptions {
  minSize?: number;
  maxSpreadPct?: number;
  /** Spreadgräns när djupet är okänt. Snävare, eftersom spreaden bär ensam. */
  maxSpreadPctNoDepth?: number;
}

/**
 * Duger börsens mitt som referens?
 *
 * Den viktigaste spärren i hela skärmen. Betfairs asiatiska handikapp ligger
 * ofta på 3 kr back mot 24 kr lay med 18 % spread — en "mittpunkt" där är brus,
 * och utan den här grinden blir varje sådan rad en påhittad 20 %-edge.
 *
 * Två vägar beroende på om djupet är känt:
 *
 *   - Djup känt (TheStatsAPI-data): djup ≥ minSize OCH spread ≤ maxSpread. Den
 *     starkare kontrollen, eftersom både pengar och spread mäts.
 *   - Djup okänt (The Odds API): spread ≤ maxSpreadNoDepth, en snävare gräns.
 *     Uppmätt på 1 208 börsmarknader att spread ≤ 3 % lämnar samma andel tunna
 *     marknader (5 %) som den djupbaserade grinden — spreaden bär nästan hela
 *     jobbet, och disagreement-spärren fångar en dålig referens i efterhand.
 */
export function isLiquid(mid: ExchangeMid, opts: LiquidityOptions = {}): boolean {
  if (mid.size == null) {
    const maxSpread = opts.maxSpreadPctNoDepth ?? DEFAULT_MAX_SPREAD_PCT_NO_DEPTH;
    return mid.spreadPct <= maxSpread;
  }
  const minSize = opts.minSize ?? DEFAULT_MIN_EXCHANGE_SIZE;
  const maxSpread = opts.maxSpreadPct ?? DEFAULT_MAX_SPREAD_PCT;
  return mid.size >= minSize && mid.spreadPct <= maxSpread;
}

// ---------------------------------------------------------------------------
// Marknadsreferens
// ---------------------------------------------------------------------------

export type ReferenceSource = "exchange" | "pinnacle" | "consensus";

export interface MarketReference {
  source: ReferenceSource;
  /** Fair sannolikhet per utfall. Summerar till 1. */
  probs: Map<OddsOutcome, number>;
  /** Börsen: sämsta (minsta) djup bland utfallen. Pinnacle/konsensus: null. */
  minSize: number | null;
  /** Börsen: största spread bland utfallen. Pinnacle: marknadens overround. */
  spreadPct: number | null;
  /** Konsensus: antal böcker medianen räknades på. Null för de andra källorna. */
  bookCount?: number;
  /** Overround före normalisering — hur långt från 1 rådatan låg. */
  overround: number;
  /**
   * Största relativa avvikelse mot den ANDRA skarpa källan, när båda finns.
   * Null när bara en gick att räkna fram.
   */
  disagreement: number | null;
}

/**
 * Hur långt isär två skarpa källor får ligga innan raden inte går att lita på.
 *
 * Uppmätt fall: på Elche–Barcelona hade Pinnacle Elche på fair 8,02 medan
 * börsen sa 10,62 — 30 % isär på samma utfall. Med Pinnacle som referens såg
 * Paddy Powers 9,50 ut som +18 % EV; med börsen var samma pris −11 %. Två
 * skarpa källor som är så oense betyder att minst en är inaktuell, och API:et
 * ger ingen tidsstämpel per pris som kan avgöra vilken.
 */
export const DEFAULT_MAX_DISAGREEMENT = 0.08;

/** Största relativa skillnad mellan två sannolikhetsuppsättningar. */
function maxRelativeDiff(a: Map<OddsOutcome, number>, b: Map<OddsOutcome, number>): number {
  let worst = 0;
  for (const [k, pa] of a) {
    const pb = b.get(k);
    if (pb == null || pb <= 0) continue;
    worst = Math.max(worst, Math.abs(pa - pb) / pb);
  }
  return worst;
}

/** Normaliserar en uppsättning sannolikheter till summan 1. */
function normalize(raw: Map<OddsOutcome, number>): { probs: Map<OddsOutcome, number>; sum: number } {
  let sum = 0;
  for (const p of raw.values()) sum += p;
  const probs = new Map<OddsOutcome, number>();
  if (sum <= 0) return { probs, sum: 0 };
  for (const [k, p] of raw) probs.set(k, clampProb(p / sum));
  return { probs, sum };
}

/**
 * Referens ur börsen: mitten per utfall, normaliserad över hela marknaden.
 *
 * Normaliseringen är inte kosmetisk. Tre 1X2-mittpunkter summerar sällan exakt
 * till 1; ligger summan på 1,01 ser varje utfall 1 % sämre ut än det är, och
 * skärmen missar edges systematiskt. Ligger den på 0,99 hittar den edges som
 * inte finns.
 *
 * Kräver att SAMTLIGA utfall är likvida — en marknad där bara favoriten har
 * djup går inte att normalisera meningsfullt.
 */
export function exchangeReference(
  book: BookMarket,
  expected: OddsOutcome[],
  opts: LiquidityOptions = {}
): MarketReference | null {
  const raw = new Map<OddsOutcome, number>();
  let minSize: number | null = Infinity;
  let maxSpread = 0;

  for (const outcome of expected) {
    const price = book.outcomes.find((o) => o.outcome === outcome);
    if (!price) return null;
    const mid = exchangeMid(price);
    if (!mid || !isLiquid(mid, opts)) return null;
    raw.set(outcome, mid.prob);
    // Ett okänt djup gör hela marknadens djup okänt — det tunnaste ledet
    // bestämmer, och null är tunnare än vilken siffra som helst.
    if (mid.size == null) minSize = null;
    else if (minSize != null) minSize = Math.min(minSize, mid.size);
    maxSpread = Math.max(maxSpread, mid.spreadPct);
  }

  const { probs, sum } = normalize(raw);
  if (probs.size !== expected.length) return null;
  return {
    source: "exchange",
    probs,
    minSize: minSize === Infinity ? null : minSize,
    spreadPct: maxSpread,
    overround: sum - 1,
    disagreement: null,
  };
}

/**
 * Referens ur Pinnacle: proportionell avviggning över marknadens utfall.
 * Återanvänder `devigProportional`, som redan hanterar n utfall.
 */
export function pinnacleReference(book: BookMarket, expected: OddsOutcome[]): MarketReference | null {
  const odds: number[] = [];
  for (const outcome of expected) {
    const price = book.outcomes.find((o) => o.outcome === outcome);
    if (!price || !validOdds(price.odds)) return null;
    odds.push(price.odds);
  }
  const probs = new Map<OddsOutcome, number>();
  let overround = 0;
  for (let i = 0; i < expected.length; i++) {
    const others = odds.filter((_, j) => j !== i);
    const d = devigProportional(odds[i], others);
    if (!d) return null;
    probs.set(expected[i], d.p);
    overround = d.overround;
  }
  return { source: "pinnacle", probs, minSize: null, spreadPct: null, overround, disagreement: null };
}

/** Median av en icke-tom talserie. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Minsta antal böcker en konsensusreferens får bygga på.
 *
 * Två böcker har ingen median värd namnet — de ger bara ett medelvärde av två
 * priser som mycket väl kan komma från samma oddsleverantör. Tre är golvet där
 * en avvikande bok kan röstas ner i stället för att flytta referensen.
 */
export const DEFAULT_MIN_CONSENSUS_BOOKS = 3;

/**
 * Referens ur mängden böcker: avvigga var och en för sig, ta MEDIANEN per
 * utfall, normalisera.
 *
 * Sista utvägen, för marknader där varken börsen eller Pinnacle noterar ett
 * pris — mindre ligor och de flesta sporter utanför fotboll. Sämre än en skarp
 * källa, och märkt som sådan via `source: "consensus"`, men skillnaden mot
 * alternativet är inte marginell: alternativet är att inte kunna räkna CLV alls.
 *
 * Median och inte medelvärde, eftersom en enda inaktuell bok annars drar hela
 * referensen med sig. Varje bok avviggas FÖRST och vägs samman efteråt — att
 * medelvärda vigade priser blandar in böckernas olika marginaler i talet.
 * Samma metod som `scanValuePlays` i lib/valueScanner.ts.
 */
export function consensusReference(
  books: BookMarket[],
  expected: OddsOutcome[],
  minBooks: number = DEFAULT_MIN_CONSENSUS_BOOKS
): MarketReference | null {
  const perOutcome = new Map<OddsOutcome, number[]>();
  for (const outcome of expected) perOutcome.set(outcome, []);

  let used = 0;
  let overroundSum = 0;

  for (const book of books) {
    // Börser hör inte hemma i en fastodds-konsensus: deras back-pris är ett
    // orderbokspris utan marginal, så det skulle dras in i medianen på helt
    // andra villkor än böckernas.
    if (EXCHANGE_BOOKS.has(book.bookmaker)) continue;

    const odds: number[] = [];
    for (const outcome of expected) {
      const price = book.outcomes.find((o) => o.outcome === outcome);
      if (!price || !validOdds(price.odds)) break;
      odds.push(price.odds);
    }
    // Bara böcker som noterar HELA marknaden — en halv marknad går inte att
    // avvigga, och att fylla ut den med en annan boks pris vore påhitt.
    if (odds.length !== expected.length) continue;

    let ok = true;
    for (let i = 0; i < expected.length; i++) {
      const d = devigProportional(
        odds[i],
        odds.filter((_, j) => j !== i)
      );
      if (!d) {
        ok = false;
        break;
      }
      perOutcome.get(expected[i])!.push(d.p);
      if (i === 0) overroundSum += d.overround;
    }
    if (ok) used += 1;
  }

  if (used < minBooks) return null;

  const raw = new Map<OddsOutcome, number>();
  for (const outcome of expected) {
    const ps = perOutcome.get(outcome)!;
    if (ps.length !== used) return null;
    raw.set(outcome, median(ps));
  }

  const { probs, sum } = normalize(raw);
  if (probs.size !== expected.length) return null;

  return {
    source: "consensus",
    probs,
    minSize: null,
    spreadPct: null,
    // Medianen av avviggade sannolikheter summerar sällan exakt till 1; det som
    // normaliseras bort rapporteras som overround, precis som för börsen.
    overround: sum - 1,
    disagreement: null,
    bookCount: used,
  };
}

/**
 * Marknadens fair pris: börsen först, Pinnacle som reserv, konsensus sist.
 *
 * Ordningen är inte godtycklig. Börsen är riktiga pengar utan marginal och
 * därmed det skarpaste priset som finns — men bara när den är likvid. Faller
 * likviditetsgrinden är avviggad Pinnacle nästa bästa, och för asiatiskt
 * handikapp i praktiken den enda användbara. Saknas båda — vanligt utanför de
 * stora fotbollsligorna — återstår medianen över böckerna, som är sämre men
 * ärligt märkt.
 */
export function marketReference(
  books: BookMarket[],
  expected: OddsOutcome[],
  opts: LiquidityOptions & {
    /**
     * Släpp fram medianen över böckerna när ingen skarp källa finns.
     *
     * Avstängt som standard, och det är avsiktligt: EV-skärmen bygger på att
     * referensen ÄR skarp — en konsensus av samma mjuka böcker man shoppar mot
     * är delvis cirkulär och skulle tyst börja peka ut edges som inte finns.
     * CLV-mätningen har inte det problemet (den jämför ett redan taget pris mot
     * marknaden i efterhand) och slår därför på den.
     */
    allowConsensus?: boolean;
    minConsensusBooks?: number;
  } = {}
): MarketReference | null {
  const exchangeBook = books.find((b) => b.bookmaker === EXCHANGE_BOOK);
  const pinnacleBook = books.find((b) => b.bookmaker === PINNACLE_BOOK);

  // Börsens mitt räknas fram även när den är för tunn för att vara referens —
  // den duger ändå som andra åsikt att jämföra Pinnacle mot.
  const exchange = exchangeBook ? exchangeReference(exchangeBook, expected, opts) : null;
  // Den lösa börsreferensen ska bortse från ALL likviditet — den finns bara
  // för att ge en andra åsikt åt oense-kontrollen. Utan djup avgör spreaden,
  // så maxSpreadPctNoDepth måste också lyftas; annars faller den tillbaka på
  // 3 %-gränsen och tystar oense-spärren utan att något syns. Det var precis
  // vad som hände på Elche–Barcelona: börsen sa fair ~10,5, Pinnacle ~8,2, och
  // den falska +22 %-raden slank igenom eftersom den lösa börsen blev null.
  const exchangeLoose = exchangeBook
    ? exchangeReference(exchangeBook, expected, {
        minSize: 0,
        maxSpreadPct: Infinity,
        maxSpreadPctNoDepth: Infinity,
      })
    : null;
  const pinnacle = pinnacleBook ? pinnacleReference(pinnacleBook, expected) : null;

  const consensus =
    exchange || pinnacle || !opts.allowConsensus
      ? null
      : consensusReference(books, expected, opts.minConsensusBooks);

  const chosen = exchange ?? pinnacle ?? consensus;
  if (!chosen) return null;

  // Oense-kontrollen jämför alltid mot den andra SKARPA källan. Konsensus är
  // inte en sådan: den räknas bara fram när ingen av dem finns, och har då
  // inget att jämföras mot.
  const other =
    chosen.source === "exchange"
      ? pinnacle
      : chosen.source === "pinnacle"
        ? exchangeLoose
        : null;
  const disagreement = other ? maxRelativeDiff(chosen.probs, other.probs) : null;
  return { ...chosen, disagreement };
}

// ---------------------------------------------------------------------------
// Asiatiskt handikapp — teckenkonvention
// ---------------------------------------------------------------------------

/**
 * Teckenkonvention per bok för asiatiskt handikapp.
 *
 * Uppmätt problem: på Arsenal (1,167-favorit) mot Coventry lagrar bet365 och
 * Betfair hemmalinjen som `-3.5` respektive `-4`, medan Pinnacle lagrar
 * `+1.75` till oddset 1,729. Arsenal +1,75 vore ~1,02, så Pinnacles tecken är
 * inverterat mot de andras.
 *
 * Tabellen är medvetet explicit och testad i stället för en gissning i
 * förbifarten — jämförs två böcker med olika tecken blir varje AH-rad falsk
 * +EV. `verifyHandicapSigns` nedan är avsedd att köras mot verklig data innan
 * AH släpps på i UI:t.
 */
export const HANDICAP_SIGN: Record<string, 1 | -1> = {
  bet365: 1,
  "paddy-power": 1,
  "betmgm-uk": 1,
  "betfair-exchange": 1,
  pinnacle: -1,
};

/** Linjen uttryckt i gemensam konvention: negativt = laget ger handikapp. */
export function normalizeHandicap(bookmaker: string, line: number): number | null {
  const sign = HANDICAP_SIGN[bookmaker];
  if (!sign || !Number.isFinite(line)) return null;
  return line * sign;
}

/**
 * Kontrollerar teckenkonventionen mot verkligheten.
 *
 * Ett handikapp ska prissättas dyrare ju mer laget ger bort. Är favoriten
 * (lägst 1X2-odds) prissatt UNDER 2,00 på en linje som efter normalisering
 * säger att laget *får* övertag, är tecknet fel för den boken.
 *
 * Returnerar böcker vars konvention inte stämmer. Är listan icke-tom ska AH
 * inte visas — hellre ingen marknad än en påhittad edge.
 */
export function verifyHandicapSigns(
  samples: Array<{ bookmaker: string; line: number; odds: number; isFavourite: boolean }>
): string[] {
  const bad = new Set<string>();
  for (const s of samples) {
    const line = normalizeHandicap(s.bookmaker, s.line);
    if (line == null || !validOdds(s.odds)) continue;
    // Favoriten som ger bort mål (negativ linje) ska ligga över jämnt pris.
    if (s.isFavourite && line <= -0.5 && s.odds < 1.5) bad.add(s.bookmaker);
    // Favoriten som får övertag (positiv linje) ska ligga klart under jämnt.
    if (s.isFavourite && line >= 0.5 && s.odds > 1.5) bad.add(s.bookmaker);
  }
  return [...bad];
}

// ---------------------------------------------------------------------------
// Prissättning av en rad
// ---------------------------------------------------------------------------

export interface PricedOutcome {
  outcome: OddsOutcome;
  /** Marknadens fair sannolikhet. */
  fairProb: number;
  fairOdds: number;
  /** Bästa pris bland böckerna, referensboken exkluderad. */
  bestBook: string | null;
  bestOdds: number | null;
  /** EV per satsad enhet. 0.03 = 3 %. */
  edge: number;
}

export interface PricedMarket {
  reference: MarketReference;
  outcomes: PricedOutcome[];
  /** Bästa raden i marknaden, för sortering. */
  best: PricedOutcome | null;
}

/**
 * Går det att lägga ett spel hos boken?
 *
 * Börsen är referens, aldrig destination. Två skäl, båda uppmätta:
 *
 * 1. Dess back-pris är ofta bara några kronor djupt. Elche till 10,50 med fyra
 *    kronor bakom är inget spelbart pris, men såg ut som +31 % EV mot Pinnacle
 *    innan den här spärren fanns.
 * 2. Även när priset finns är det börsen som sätter facit. Att shoppa mot sin
 *    egen referens är cirkulärt.
 */
export function isShoppable(bookmaker: string): boolean {
  return !EXCHANGE_BOOKS.has(bookmaker);
}

/**
 * Prissätter en marknad: fair odds per utfall och edge mot bästa tillgängliga
 * pris.
 *
 * Både referensboken och börsen utesluts ur prisjakten — se `isShoppable`.
 */
export function priceMarket(
  books: BookMarket[],
  expected: OddsOutcome[],
  opts: LiquidityOptions = {}
): PricedMarket | null {
  const reference = marketReference(books, expected, opts);
  if (!reference) return null;

  const refBook = reference.source === "exchange" ? EXCHANGE_BOOK : PINNACLE_BOOK;
  const outcomes: PricedOutcome[] = [];

  for (const outcome of expected) {
    const fairProb = reference.probs.get(outcome);
    if (fairProb == null) continue;

    let bestBook: string | null = null;
    let bestOdds: number | null = null;
    for (const b of books) {
      if (b.bookmaker === refBook || !isShoppable(b.bookmaker)) continue;
      const price = b.outcomes.find((o) => o.outcome === outcome);
      if (!price || !validOdds(price.odds)) continue;
      if (bestOdds == null || price.odds > bestOdds) {
        bestOdds = price.odds;
        bestBook = b.bookmaker;
      }
    }

    outcomes.push({
      outcome,
      fairProb,
      fairOdds: 1 / clampProb(fairProb),
      bestBook,
      bestOdds,
      edge: bestOdds == null ? 0 : priceEdge(bestOdds, fairProb),
    });
  }

  const withPrice = outcomes.filter((o) => o.bestOdds != null);
  const best = withPrice.length
    ? withPrice.reduce((a, b) => (b.edge > a.edge ? b : a))
    : null;
  return { reference, outcomes, best };
}
