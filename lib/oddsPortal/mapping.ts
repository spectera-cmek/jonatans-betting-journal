// Pure OddsPortal mapping helpers (sport slug, market target, bookmaker priority).
// Kept free of Playwright so unit tests stay offline.

export type OddsPortalSportSlug =
  | "football"
  | "tennis"
  | "basketball"
  | "baseball"
  | "hockey"
  | "american-football"
  | "mma"
  | "boxing"
  | "volleyball"
  | "handball"
  | "esports"
  | "darts"
  | "snooker"
  | "cricket"
  | "rugby-union"
  | "rugby-league"
  | "table-tennis";

export type SelectionColumn = "home" | "draw" | "away" | "over" | "under";

export interface MarketTarget {
  /** Tab / menu labels to click (first match wins). */
  tabLabels: string[];
  /** Hash fragments OddsPortal sometimes uses. */
  hashHints: string[];
  column: SelectionColumn;
  line: number | null;
  /** True when this is a player prop / niche market. */
  isProp: boolean;
  /** Free-text hints for prop pages. */
  propHints: string[];
}

export type ScrapeErrorCode =
  | "match_not_found"
  | "market_not_found"
  | "odds_not_found"
  | "blocked"
  | "before_kickoff"
  | "missing_fields"
  | "browser_error";

function norm(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Strip MLB/NBA-style prefixes ("PHI Phillies" → "Phillies"). */
export function stripTeamPrefix(name: string): string {
  return name.replace(/^[A-Z]{2,3}\s+/, "").trim();
}

export function normalizeSearchToken(name: string): string {
  return norm(stripTeamPrefix(name));
}

/** Map journal sport/league → OddsPortal path slug. */
export function oddsPortalSportSlug(
  sport?: string | null,
  league?: string | null
): OddsPortalSportSlug {
  const s = norm(sport || "");
  const l = norm(league || "");

  if (
    s === "football" ||
    s === "soccer" ||
    s === "fotboll" ||
    l.includes("allsvenskan") ||
    l.includes("premier league") ||
    l.includes("la liga") ||
    l.includes("serie a") ||
    l.includes("bundesliga") ||
    l.includes("champions league") ||
    l.includes("europa league") ||
    l.includes("world cup") ||
    l === "vm 2026"
  ) {
    return "football";
  }
  if (s === "tennis") return "tennis";
  if (s === "basketball" || s === "basket" || l.includes("nba") || l.includes("wnba")) {
    return "basketball";
  }
  if (s === "baseball" || l.includes("mlb")) return "baseball";
  if (s === "ice hockey" || s === "hockey" || s === "ishockey" || l.includes("nhl")) {
    return "hockey";
  }
  if (s === "american football" || s === "amerikansk fotboll" || l.includes("nfl")) {
    return "american-football";
  }
  if (s === "mma" || s === "ufc" || l.includes("ufc")) return "mma";
  if (s === "boxing" || s === "boxning") return "boxing";
  if (s === "volleyball") return "volleyball";
  if (s === "handball" || s === "handboll") return "handball";
  if (s === "esports" || s === "e sport") return "esports";
  if (s === "darts") return "darts";
  if (s === "snooker") return "snooker";
  if (s === "cricket") return "cricket";
  if (s.includes("rugby") && l.includes("league")) return "rugby-league";
  if (s.includes("rugby")) return "rugby-union";
  if (s === "table tennis" || s === "pingis") return "table-tennis";

  return "football";
}

export function resolveSelectionColumn(input: {
  market: string;
  selectionSide?: string | null;
  selection?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
}): SelectionColumn {
  const side = norm(input.selectionSide || "");
  if (side === "home" || side === "1") return "home";
  if (side === "away" || side === "2") return "away";
  if (side === "draw" || side === "x") return "draw";
  if (side === "over" || side === "o") return "over";
  if (side === "under" || side === "u") return "under";

  const sel = norm(input.selection || "");
  if (sel.startsWith("over") || sel.includes(" over ") || sel.startsWith("o ")) return "over";
  if (sel.startsWith("under") || sel.includes(" under ") || sel.startsWith("u ")) return "under";
  if (sel === "draw" || sel === "x" || sel.includes("oavgjort")) return "draw";

  const home = normalizeSearchToken(input.homeTeam || "");
  const away = normalizeSearchToken(input.awayTeam || "");
  if (home && (sel === home || sel.includes(home) || home.includes(sel))) return "home";
  if (away && (sel === away || sel.includes(away) || away.includes(sel))) return "away";

  const market = norm(input.market || "");
  if (market === "totals") return "over";
  return "home";
}

/** Build OddsPortal market navigation target from a bet. */
export function resolveMarketTarget(bet: {
  market: string;
  marketCategory?: string | null;
  marketScope?: string | null;
  selection?: string | null;
  selectionSide?: string | null;
  line?: number | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  sport?: string | null;
}): MarketTarget {
  const market = norm(bet.market || "");
  const category = norm(bet.marketCategory || "");
  const scope = norm(bet.marketScope || "");
  const selection = bet.selection || "";
  const column = resolveSelectionColumn(bet);
  const line = bet.line != null && Number.isFinite(bet.line) ? bet.line : null;
  const sport = oddsPortalSportSlug(bet.sport, null);
  const twoWay = sport !== "football";

  const isProp =
    scope === "player" ||
    category.includes("skott") ||
    category.includes("shot") ||
    category.includes("assist") ||
    category.includes("points") ||
    category.includes("poang") ||
    category.includes("rebound") ||
    category.includes("goalscorer") ||
    category.includes("malskytt") ||
    /shots?|assists?|points?|rebounds?|goalscorer|malskytt|bases?|strikeouts?/i.test(
      selection
    );

  if (isProp) {
    return {
      tabLabels: ["Player Props", "Players", "Player", "Props", "Specials"],
      hashHints: ["player-props", "props"],
      column,
      line,
      isProp: true,
      propHints: [selection, category].filter(Boolean),
    };
  }

  if (market === "totals" || category.includes("total") || category.includes("mål") || category.includes("mal")) {
    return {
      tabLabels: ["Over/Under", "Over Under", "Totals", "Total Goals", "Goals O/U"],
      hashHints: ["over-under", "ou"],
      column: column === "under" ? "under" : "over",
      line,
      isProp: false,
      propHints: [],
    };
  }

  if (market === "spreads" || category.includes("handicap") || category.includes("spread") || category.includes("asian")) {
    return {
      tabLabels: ["Asian Handicap", "Handicap", "Spread", "Puck Line", "Run Line"],
      hashHints: ["ah", "asian-handicap", "handicap", "spread"],
      column: column === "away" ? "away" : "home",
      line,
      isProp: false,
      propHints: [],
    };
  }

  if (category.includes("btts") || category.includes("both teams") || /btts|both teams to score/i.test(selection)) {
    return {
      tabLabels: ["Both Teams to Score", "BTTS", "Goal/No Goal"],
      hashHints: ["bts", "btts", "both-teams-to-score"],
      column: /no|nej/i.test(selection) ? "away" : "home",
      line: null,
      isProp: false,
      propHints: [],
    };
  }

  if (/hörn|horn|corner/i.test(category + " " + selection)) {
    return {
      tabLabels: ["Corners", "Total Corners", "Corner Over/Under", "Over/Under"],
      hashHints: ["corners", "corner", "over-under"],
      column: column === "under" ? "under" : "over",
      line,
      isProp: false,
      propHints: [selection],
    };
  }

  if (/kort|card|booking/i.test(category + " " + selection)) {
    return {
      tabLabels: ["Cards", "Bookings", "Total Cards", "Over/Under"],
      hashHints: ["cards", "bookings", "over-under"],
      column: column === "under" ? "under" : "over",
      line,
      isProp: false,
      propHints: [selection],
    };
  }

  if (market === "other") {
    return {
      tabLabels: ["Specials", "Others", "Corners", "Cards", selection.slice(0, 40)].filter(Boolean),
      hashHints: ["specials", "others"],
      column,
      line,
      isProp: true,
      propHints: [selection, category].filter(Boolean),
    };
  }

  // h2h / moneyline / 1X2
  if (twoWay) {
    return {
      tabLabels: ["Home/Away", "Money Line", "Moneyline", "Winner", "Match Winner"],
      hashHints: ["home-away", "money-line", "ml"],
      column: column === "away" ? "away" : "home",
      line: null,
      isProp: false,
      propHints: [],
    };
  }

  return {
    tabLabels: ["1X2", "Full Time", "Match Result", "Home/Draw/Away"],
    hashHints: ["1x2", "home-draw-away"],
    column,
    line: null,
    isProp: false,
    propHints: [],
  };
}

/** OddsPortal bookmaker label aliases for fuzzy matching. */
const BOOKIE_ALIASES: Record<string, string[]> = {
  bet365: ["bet365", "bet 365"],
  betsson: ["betsson"],
  unibet: ["unibet", "unibetse", "unibet se"],
  expekt: ["expekt", "expektse", "expekt se"],
  nordicbet: ["nordicbet", "nordic bet"],
  betmgm: ["betmgm", "bet mgm", "mgm", "betmgm.se", "betmgm se"],
  pinnacle: ["pinnacle", "pinny"],
  betfair: ["betfair", "betfair sportsbook"],
  "888sport": ["888sport", "888 sport", "888"],
  leovegas: ["leovegas", "leo vegas"],
  atg: ["atg"],
  comeon: ["comeon", "come on"],
  betsafe: ["betsafe"],
  snabbare: ["snabbare"],
  happy: ["happybet", "happy bet", "happy", "happycasino"],
  onerush: ["onerush", "one rush"],
  coolbet: ["coolbet"],
  "10bet": ["10bet"],
};

function aliasKeysFor(raw: string): string[] {
  const n = norm(raw).replace(/\s+/g, "");
  const keys: string[] = [];
  for (const [canon, aliases] of Object.entries(BOOKIE_ALIASES)) {
    if (norm(canon).replace(/\s+/g, "") === n || aliases.some((a) => norm(a).replace(/\s+/g, "") === n)) {
      keys.push(...aliases, canon);
    }
  }
  if (!keys.length) keys.push(raw);
  return keys;
}

/** Priority list: bet bookmaker first, then Pinnacle, Bet365. */
export function bookmakerPriority(preferred?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (label: string) => {
    const key = norm(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };

  if (preferred?.trim()) {
    for (const a of aliasKeysFor(preferred.trim())) push(a);
    push(preferred.trim());
  }
  push("Pinnacle");
  push("bet365");
  push("Bet365");
  return out;
}

/** Score how well a page bookmaker label matches a wanted name (higher = better). */
export function bookmakerMatchScore(wanted: string, candidate: string): number {
  const w = norm(wanted).replace(/\s+/g, "");
  const c = norm(candidate).replace(/\s+/g, "");
  if (!w || !c) return 0;
  if (w === c) return 100;
  if (c.includes(w) || w.includes(c)) return 80;
  const wAliases = aliasKeysFor(wanted).map((a) => norm(a).replace(/\s+/g, ""));
  if (wAliases.includes(c)) return 95;
  if (wAliases.some((a) => a.length >= 4 && (c.includes(a) || a.includes(c)))) return 70;
  return 0;
}

/** Pick the best odds row given preferred bookmaker order. */
export function pickBookmakerOdds<T extends { bookmaker: string; odds: number }>(
  rows: T[],
  preferred?: string | null
): { row: T; matchedAs: string } | null {
  const valid = rows.filter((r) => r.odds > 1 && Number.isFinite(r.odds));
  if (!valid.length) return null;

  const priority = bookmakerPriority(preferred);
  for (const want of priority) {
    let best: T | null = null;
    let bestScore = 0;
    for (const row of valid) {
      const score = bookmakerMatchScore(want, row.bookmaker);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    if (best && bestScore >= 70) {
      return { row: best, matchedAs: best.bookmaker };
    }
  }

  return { row: valid[0], matchedAs: valid[0].bookmaker };
}

/** Build OddsPortal search query from teams / event. */
export function buildSearchQuery(input: {
  homeTeam?: string | null;
  awayTeam?: string | null;
  event?: string | null;
}): string {
  const home = stripTeamPrefix((input.homeTeam || "").trim());
  const away = stripTeamPrefix((input.awayTeam || "").trim());
  if (home && away) return `${home} ${away}`;
  if (home) return home;
  if (away) return away;
  const event = (input.event || "").replace(/\s+vs\.?\s+/i, " ").replace(/\s+[–—@]\s+/g, " ").trim();
  return event;
}

/** Strip OddsPortal country suffixes: "Univ. Craiova (Rou)" → "Univ. Craiova". */
export function stripCountrySuffix(name: string): string {
  return name.replace(/\s*\([A-Za-z]{2,4}\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function teamTokens(name: string): string[] {
  return normalizeSearchToken(stripCountrySuffix(stripTeamPrefix(name)))
    .split(" ")
    .filter((p) => p.length >= 3 && !["fc", "cf", "sc", "afc", "united", "city", "the"].includes(p));
}

function titleHasTeam(titleNorm: string, team: string): boolean {
  const full = normalizeSearchToken(stripCountrySuffix(stripTeamPrefix(team)));
  if (!full) return false;
  if (titleNorm.includes(full)) return true;
  const tokens = teamTokens(team);
  if (!tokens.length) return false;
  // Distinctive last token is enough ("Craiova" matches "Univ. Craiova").
  return titleNorm.includes(tokens[tokens.length - 1]);
}

/** True if candidate match title looks like our event. */
export function matchTitleLooksLike(
  title: string,
  homeTeam?: string | null,
  awayTeam?: string | null
): boolean {
  const t = normalizeSearchToken(stripCountrySuffix(title));
  if (!t) return false;
  if (homeTeam && awayTeam) {
    return titleHasTeam(t, homeTeam) && titleHasTeam(t, awayTeam);
  }
  if (homeTeam) return titleHasTeam(t, homeTeam);
  if (awayTeam) return titleHasTeam(t, awayTeam);
  return false;
}

/** Prefer match date within ±2 days of eventAt. */
export function dateWithinWindow(
  candidateIso: string | null | undefined,
  eventAt: Date | null | undefined,
  windowDays = 2
): boolean {
  if (!eventAt || !candidateIso) return true; // no date → don't reject
  const c = Date.parse(candidateIso);
  if (!Number.isFinite(c)) return true;
  const diff = Math.abs(c - eventAt.getTime());
  return diff <= windowDays * 24 * 60 * 60 * 1000;
}
