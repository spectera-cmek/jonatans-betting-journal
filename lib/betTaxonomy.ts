// Canonical structured metadata for bets.
//
// `market` is deliberately NOT represented by the semantic category below:
// it is the small grading enum (h2h/totals/spreads/other). `marketCategory`
// describes what was bet on and is what the UI should display and filter by.

export const GRADING_MARKETS = ["h2h", "totals", "spreads", "other"] as const;
export type GradingMarket = (typeof GRADING_MARKETS)[number];

export const MARKET_SCOPES = ["player", "team", "match"] as const;
export type MarketScope = (typeof MARKET_SCOPES)[number];

export const EVENT_KINDS = ["match", "outright"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const TOURNAMENT_STAGES = [
  "group",
  "round_of_32",
  "round_of_16",
  "quarterfinal",
  "semifinal",
  "third_place",
  "final",
] as const;
export type TournamentStage = (typeof TOURNAMENT_STAGES)[number];

export const VM_2026_LEAGUE = "VM 2026";
export const VM_2026_RESULT_PROVIDER = "espn";

export const GENERIC_MARKET_CATEGORIES = [
  "Matchvinnare",
  "Dubbelchans",
  "Totalt",
  "Handikapp",
  "BTTS",
  "Halvlek",
  "Hörnor",
  "Kort & fouls",
  "Skott",
  "Skott på mål",
  "Mål",
  "Räddningar",
  "Spelarpoäng",
  "Returer",
  "Assists",
  "Trepoängare",
  "Frikast",
  "Ess",
  "Vinstmetod",
  "Kombination",
  "Avancemang",
  "Första målet",
  "Specialspel",
  "Övrigt",
] as const;

export const MARKET_CATEGORIES_BY_SPORT: Record<string, readonly string[]> = {
  Football: [
    "Matchvinnare", "Dubbelchans", "Totalt", "BTTS", "Handikapp", "Hörnor",
    "Kort & fouls", "Skott", "Skott på mål", "Mål", "Frisparkar", "Offside",
    "Räddningar", "Halvlek", "Övrigt",
  ],
  Basketball: [
    "Matchvinnare", "Handikapp", "Totalt", "Spelarpoäng", "Returer", "Assists",
    "Trepoängare", "Frikast", "Steals", "Blocks", "PRA", "Halvlek", "Övrigt",
  ],
  "Ice Hockey": [
    "Matchvinnare", "Totalt", "Handikapp", "Skott", "Skott på mål", "Mål",
    "Assists", "Spelarpoäng", "Räddningar", "Utvisningar", "Period", "Övrigt",
  ],
  Tennis: [
    "Matchvinnare", "Set-vinnare", "Totalt", "Handikapp", "Tiebreak", "Ess",
    "Dubbelfel", "Övrigt",
  ],
  Baseball: [
    "Matchvinnare", "Handikapp", "Totalt", "Baser", "Träffar", "Strikeouts",
    "Home runs", "Walks", "Övrigt",
  ],
  Esports: [
    "Matchvinnare", "Handikapp", "Totalt", "Kills", "Rundor", "Kartor", "Övrigt",
  ],
  Golf: ["Matchvinnare", "Handikapp", "Slutplacering", "Specialspel", "Övrigt"],
  Other: ["Matchvinnare", "Totalt", "180s", "Game", "Rond", "Utmärkelse", "Specialspel", "Övrigt"],
};

const ALL_CATEGORY_VALUES = new Set<string>([
  ...GENERIC_MARKET_CATEGORIES,
  ...Object.values(MARKET_CATEGORIES_BY_SPORT).flat(),
]);

const EXACT_CATEGORY_ALIASES: Record<string, string> = {
  "1x2": "Matchvinnare",
  "h2h": "Matchvinnare",
  "moneyline": "Matchvinnare",
  "match winner": "Matchvinnare",
  "matchvinnare": "Matchvinnare",
  "double chance": "Dubbelchans",
  "dubbelchans": "Dubbelchans",
  "total": "Totalt",
  "totals": "Totalt",
  "över/under": "Totalt",
  "over/under": "Totalt",
  "spread": "Handikapp",
  "spreads": "Handikapp",
  "handicap": "Handikapp",
  "player points": "Spelarpoäng",
  "points": "Spelarpoäng",
  "shots on target": "Skott på mål",
  "shots on goal": "Skott på mål",
  "sog": "Skott på mål",
  "corners": "Hörnor",
  "cards": "Kort & fouls",
  "saves": "Räddningar",
  "other": "Övrigt",
  "bet builder": "Kombination",
  "kombination": "Kombination",
  "trippel": "Kombination",
  "avancemang": "Avancemang",
  "första målet": "Första målet",
  "specialspel": "Specialspel",
  "träffar": "Träffar",
  "strikeouts": "Strikeouts",
  "baser": "Baser",
  "batter walks": "Walks",
  "walks": "Walks",
  "kills": "Kills",
  "game": "Game",
  "vunna game": "Game",
  "rondgrupp": "Rond",
  "180s": "180s",
  "matchens bästa spelare": "Utmärkelse",
  "slutplacering": "Slutplacering",
  "resultat & mål": "Specialspel",
  "vinner på avslut": "Vinstmetod",
  "hur avgörs matchen": "Vinstmetod",
};

function folded(value: string): string {
  return value.trim().toLocaleLowerCase("sv-SE").replace(/\s+/g, " ");
}

/**
 * Convert raw bookmaker/selection text to one curated semantic category.
 * Unknown values intentionally become "Övrigt" so analytics never fragment
 * into hundreds of almost-identical free-text buckets.
 */
export function normalizeMarketCategory(raw: string | null | undefined): string {
  if (!raw) return "Övrigt";
  const trimmed = raw.trim();
  if (!trimmed) return "Övrigt";

  const exactCanonical = [...ALL_CATEGORY_VALUES].find(
    (value) => folded(value) === folded(trimmed)
  );
  if (exactCanonical) return exactCanonical;

  const t = folded(trimmed);
  const alias = EXACT_CATEGORY_ALIASES[t];
  if (alias) return alias;
  const has = (re: RegExp) => re.test(t);

  // Most specific rules first.
  if (has(/bet builder|kombination|same game parlay/)) return "Kombination";
  if (has(/vinstmetod|method of victory/)) return "Vinstmetod";
  if (has(/kvalificera|avancera|to qualify|reach the next round/)) return "Avancemang";
  if (has(/första målet|first goal/)) return "Första målet";
  if (has(/strikeouts?|\bk:?s\b/)) return "Strikeouts";
  if (has(/total bases|totala baser|\bbaser\b/)) return "Baser";
  if (has(/\bhits?\b|\bträffar\b/)) return "Träffar";
  if (has(/batter walks?|\bwalks?\b/)) return "Walks";
  if (has(/home runs?|\bhr\b/)) return "Home runs";
  if (has(/\bkills?\b/)) return "Kills";
  if (has(/\b180s?\b/)) return "180s";
  if (has(/slutplacering|finishing position|top \d+/)) return "Slutplacering";
  if (has(/\bpra\b|points.?rebounds?.?assists?/)) return "PRA";
  if (has(/trepoäng|trepoangare|3-?poäng|gjorda treor|\btreor\b|three[- ]point/)) return "Trepoängare";
  if (has(/frikast|free ?throws?/)) return "Frikast";
  if (has(/\bsteals?\b|bollstöld/)) return "Steals";
  if (has(/\bblocks?\b|blockerade skott/)) return "Blocks";
  if (has(/assist/)) return "Assists";
  if (has(/returer|rebound/)) return "Returer";
  if (has(/spelarpoäng|player points|\bpoäng\b|\bpoints?\b/)) return "Spelarpoäng";
  if (has(/skott på mål|skott pa mal|on target|shots on goal|\bsog\b/)) return "Skott på mål";
  if (has(/\bskott\b|\bshots?\b/)) return "Skott";
  if (has(/räddning|\bsaves?\b/)) return "Räddningar";
  if (has(/hörn|corner/)) return "Hörnor";
  if (has(/frispark|free kick/)) return "Frisparkar";
  if (has(/offside/)) return "Offside";
  if (has(/kort|foul|varnad|tackling|utvisning|booking|\bcards?\b/)) return "Kort & fouls";
  if (has(/\bess\b|\baces?\b/)) return "Ess";
  if (has(/dubbelfel|double faults?/)) return "Dubbelfel";
  if (has(/tiebreak|tie-?break/)) return "Tiebreak";
  if (has(/set-?vinnare|set winner/)) return "Set-vinnare";
  if (has(/\bperiod\b/)) return "Period";
  if (has(/utvisningar|penalty minutes/)) return "Utvisningar";
  if (has(/båda lagen|gör båda|btts|both teams/)) return "BTTS";
  if (has(/dubbelchans|double chance/)) return "Dubbelchans";
  if (has(/handikapp|handicap|spread|run ?line/)) return "Handikapp";
  if (has(/halvlek|first half|second half|halftime|paus|1:a halvlek|2:a halvlek/)) return "Halvlek";
  if (
    has(
      /matchvinnare|fulltidsresultat|resultat efter fulltid|matchodds|att vinna match|to win|vinnare|moneyline|1x2|matchresultat|outright|att kvalificera|att lyfta|trofé|head-to-head|match result/
    )
  )
    return "Matchvinnare";
  if (has(/totalt|över\/under|ö\/u|over\/under|antal mål|total|mål i match|first to|milestones/)) return "Totalt";
  if (has(/målgörare|målskytt|to score|göra mål|goalscorer/)) return "Mål";
  return "Övrigt";
}

export function isGradingMarket(value: unknown): value is GradingMarket {
  return typeof value === "string" && GRADING_MARKETS.includes(value.toLowerCase() as GradingMarket);
}

/** Map old semantic `market` values to the strict grading enum. */
export function normalizeGradingMarket(
  raw: string | null | undefined,
  categoryRaw?: string | null,
  selectionSide?: string | null
): GradingMarket {
  const value = folded(raw ?? "");
  if (isGradingMarket(value)) return value as GradingMarket;

  const category = normalizeMarketCategory(categoryRaw || raw);
  const side = folded(selectionSide ?? "");
  if (category === "Matchvinnare" && (!side || ["home", "away", "draw"].includes(side))) return "h2h";
  if (category === "Totalt" && (!side || ["over", "under"].includes(side))) return "totals";
  if (category === "Handikapp" && (!side || ["home", "away"].includes(side))) return "spreads";
  return "other";
}

export function normalizeEventKind(value: string | null | undefined): EventKind | null {
  const v = folded(value ?? "").replace(/[\s-]+/g, "_");
  if (v === "match") return "match";
  if (["outright", "future", "futures", "turnering", "turneringsspel"].includes(v)) return "outright";
  return null;
}

export function inferEventKind(
  event: string | null | undefined,
  selection?: string | null,
  explicit?: string | null
): EventKind {
  const normalized = normalizeEventKind(explicit);
  if (normalized) return normalized;
  const text = `${event ?? ""} ${selection ?? ""}`.toLocaleLowerCase("sv-SE");
  return /outright|future|turneringsspel|turneringsvinnare|vinnare av (vm|em|cup|liga)|att vinna (vm|em|world cup)|lyfta (bucklan|trofén)|kvalificera sig/.test(text)
    ? "outright"
    : "match";
}

const STAGE_ALIASES: Record<string, TournamentStage> = {
  group: "group",
  groups: "group",
  grupp: "group",
  gruppspel: "group",
  round_of_32: "round_of_32",
  "round of 32": "round_of_32",
  r32: "round_of_32",
  "sextondelsfinal": "round_of_32",
  round_of_16: "round_of_16",
  "round of 16": "round_of_16",
  r16: "round_of_16",
  åttondelsfinal: "round_of_16",
  quarterfinal: "quarterfinal",
  quarterfinals: "quarterfinal",
  kvartsfinal: "quarterfinal",
  semifinal: "semifinal",
  semifinals: "semifinal",
  semifinaler: "semifinal",
  third_place: "third_place",
  "3rd-place match": "third_place",
  bronsmatch: "third_place",
  final: "final",
};

export function normalizeTournamentStage(value: string | null | undefined): TournamentStage | null {
  if (!value) return null;
  const raw = folded(value);
  return STAGE_ALIASES[raw] ?? STAGE_ALIASES[raw.replace(/[\s-]+/g, "_")] ?? null;
}

export function inferTournamentStage(text: string | null | undefined): TournamentStage | null {
  if (!text) return null;
  const t = folded(text);
  if (/bronsmatch|third.?place|3rd.?place/.test(t)) return "third_place";
  if (/semifinal/.test(t)) return "semifinal";
  if (/kvartsfinal|quarterfinal/.test(t)) return "quarterfinal";
  if (/åttondelsfinal|round of 16|\br16\b/.test(t)) return "round_of_16";
  if (/sextondelsfinal|round of 32|\br32\b/.test(t)) return "round_of_32";
  if (/\bfinal\b/.test(t)) return "final";
  if (/grupp|group/.test(t)) return "group";
  return null;
}

export const TOURNAMENT_STAGE_LABELS: Record<TournamentStage, string> = {
  group: "Gruppspel",
  round_of_32: "Sextondelsfinal",
  round_of_16: "Åttondelsfinal",
  quarterfinal: "Kvartsfinal",
  semifinal: "Semifinal",
  third_place: "Bronsmatch",
  final: "Final",
};

export function isWorldCup2026Text(value: string | null | undefined): boolean {
  const text = folded(value ?? "");
  return /\bvm\s*2026\b|world cup\s*2026|2026 fifa world cup|fifa world cup/.test(text);
}

export function normalizeLeague(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isWorldCup2026Text(trimmed) ? VM_2026_LEAGUE : trimmed;
}
