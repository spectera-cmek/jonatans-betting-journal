// Shared option lists for forms & dropdowns.

import {
  GENERIC_MARKET_CATEGORIES as TAXONOMY_MARKET_CATEGORIES,
  MARKET_CATEGORIES_BY_SPORT as TAXONOMY_CATEGORIES_BY_SPORT,
  TOURNAMENT_STAGE_LABELS,
  VM_2026_LEAGUE,
} from "./betTaxonomy";

export { TOURNAMENT_STAGE_LABELS, VM_2026_LEAGUE };

export const SPORTS = [
  "Football",
  "Tennis",
  "Basketball",
  "Ice Hockey",
  "American Football",
  "Baseball",
  "MMA",
  "Boxing",
  "Esports",
  "Horse Racing",
  "Golf",
  "Cricket",
  "Other",
];

export const MARKETS: { value: string; label: string }[] = [
  { value: "h2h", label: "H2H / Moneyline (1X2)" },
  { value: "totals", label: "Totals (Over/Under)" },
  { value: "spreads", label: "Spread / Handicap" },
  { value: "other", label: "Other (manual settle)" },
];

export const SIDES: Record<string, { value: string; label: string }[]> = {
  h2h: [
    { value: "home", label: "Home" },
    { value: "away", label: "Away" },
    { value: "draw", label: "Draw" },
  ],
  totals: [
    { value: "over", label: "Over" },
    { value: "under", label: "Under" },
  ],
  spreads: [
    { value: "home", label: "Home" },
    { value: "away", label: "Away" },
  ],
  other: [],
};

// Detaljerad marknad ("vad" du bettat på) — en semantisk dimension fristående
// från MARKETS ovan (som bara är avräkningstyp för auto-rättning). Värdena
// matchar normalizeMarket() i lib/categorize.ts så backfill och dropdown rimmar.
// Sportnycklarna är de engelska SPORTS-värdena. Övriga sporter får GENERIC + fritext.
export const GENERIC_MARKET_CATEGORIES: string[] = [...TAXONOMY_MARKET_CATEGORIES];

export const MARKET_CATEGORIES_BY_SPORT: Record<string, string[]> =
  Object.fromEntries(
    Object.entries(TAXONOMY_CATEGORIES_BY_SPORT).map(([sport, categories]) => [
      sport,
      [...categories],
    ])
  );

// Vem/vad spelet avser. Lagras lowercase (likt selectionSide).
export const SCOPES: { value: string; label: string }[] = [
  { value: "player", label: "Spelare" },
  { value: "team", label: "Lag" },
  { value: "match", label: "Match (totalt)" },
];

export const SCOPE_LABELS: Record<string, string> = {
  player: "Spelare",
  team: "Lag",
  match: "Match (totalt)",
};

/** How the bet is put together. "betbuilder" is a same-match multi (bet365
 *  Bet Builder, Unibet Bygg bet); "accumulator" spans several matches. Both are
 *  multis — use isMultiBet() rather than comparing to "accumulator". */
export const BET_TYPES: { value: string; label: string }[] = [
  { value: "single", label: "Singel" },
  { value: "accumulator", label: "Kombination" },
  { value: "betbuilder", label: "Bet Builder" },
];

export const EVENT_KINDS: { value: string; label: string }[] = [
  { value: "match", label: "Match" },
  { value: "outright", label: "Turneringsspel / futures" },
];

export const TOURNAMENT_STAGES: { value: string; label: string }[] =
  Object.entries(TOURNAMENT_STAGE_LABELS).map(([value, label]) => ({ value, label }));

// Sorterat efter användning i databasen (mest frekvent först), sedan övriga.
export const BOOKMAKERS = [
  "Bet365",
  "Unibet",
  "Expekt",
  "Coolbet",
  "1X2",
  "Betsson",
  "Svenska Spel",
  "Betinia",
  "Campobet",
  "Mr Green",
  "Interwetten",
  "BetMGM",
  "Happy",
  "ComeOn",
  "ATG",
  "DBET",
  "LuckyCasino",
  "LeoVegas",
  "Onerush",
  "Snabbare",
  "GoGoCasino",
  "Betsafe",
  "888sport",
  "x3000",
  "HappyCasino",
  "Flax",
  "Lodur",
  "FrankFred",
  "Lucky",
  "Pinnacle",
  "Betfair",
  "Other",
];

/** Lowercase, letters and digits only, utan diakriter — "Mr. Green", "mr green"
 *  och "okänd" faller ihop till en nyckel så stavningsvarianter av samma
 *  bookmaker landar på ett kanoniskt namn. */
const bookmakerKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Suffixes a betslip tends to hang on the brand ("Bet365 Sportsbook",
 *  "Unibet.se"). Stripped one at a time, longest first, only when what remains
 *  matches a known bookmaker — so an unknown "SomeCasino" is left alone. */
const BOOKMAKER_SUFFIXES = ["sportsbook", "sverige", "sweden", "sport", "com", "net", "se", "dk", "no", "fi"];

/** Shorthands that no amount of punctuation-stripping turns into the canonical
 *  name. Mirrors the OddsPortal aliases in lib/oddsPortal/mapping.ts. */
const BOOKMAKER_ALIASES: Record<string, string> = {
  b365: "Bet365",
  "888": "888sport",
  happybet: "Happy",
};

const BOOKMAKERS_BY_KEY = new Map(BOOKMAKERS.map((b) => [bookmakerKey(b), b]));

/** Unreadable brand on a betslip — treated as "no bookmaker", never as a name. */
const UNKNOWN_BOOKMAKERS = new Set(["okand", "okantbolag", "unknown", "null", "na", "none", "ingen"]);

/**
 * Canonical bookmaker name (bet365 / BET 365 / Bet365.se → Bet365), so the same
 * book logged from a screenshot, a statement import and the form ends up as one
 * value in filters, analytics and CLV lookups. Unknown names are kept as typed;
 * an empty or explicitly-unknown value returns null.
 */
export function normalizeBookmaker(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let key = bookmakerKey(s);
  if (!key) return s;
  if (UNKNOWN_BOOKMAKERS.has(key)) return null;

  const match = (k: string) => BOOKMAKER_ALIASES[k] ?? BOOKMAKERS_BY_KEY.get(k);
  const direct = match(key);
  if (direct) return direct;

  // "Bet365 Sportsbook Sverige" → drop suffixes until something known remains.
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of BOOKMAKER_SUFFIXES) {
      if (key.length > suffix.length && key.endsWith(suffix)) {
        const shorter = key.slice(0, -suffix.length);
        const hit = match(shorter);
        if (hit) return hit;
        key = shorter;
        stripped = true;
        break;
      }
    }
  }
  return s;
}

export const OUTCOMES: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "win", label: "Win" },
  { value: "loss", label: "Loss" },
  { value: "push", label: "Push" },
  { value: "half_win", label: "Half win" },
  { value: "half_loss", label: "Half loss" },
  { value: "void", label: "Void" },
];
