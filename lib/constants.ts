// Shared option lists for forms & dropdowns.

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
export const GENERIC_MARKET_CATEGORIES = [
  "Matchvinnare", "Dubbelchans", "Totalt", "Handikapp", "BTTS", "Halvlek",
  "Hörnor", "Kort & fouls", "Skott", "Skott på mål", "Räddningar",
  "Spelarpoäng", "Returer", "Assists", "Trepoängare", "Frikast", "Ess",
  "Vinstmetod", "Övrigt",
];

export const MARKET_CATEGORIES_BY_SPORT: Record<string, string[]> = {
  Football: [
    "Matchvinnare", "Dubbelchans", "Totalt", "BTTS", "Handikapp", "Hörnor",
    "Kort & fouls", "Skott", "Skott på mål", "Frisparkar", "Offside",
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
};

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

export const BOOKMAKERS = [
  "Unibet",
  "Bet365",
  "Pinnacle",
  "Betsson",
  "LeoVegas",
  "Svenska Spel",
  "ATG",
  "Betfair",
  "Other",
];

export const OUTCOMES: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "win", label: "Win" },
  { value: "loss", label: "Loss" },
  { value: "push", label: "Push" },
  { value: "half_win", label: "Half win" },
  { value: "half_loss", label: "Half loss" },
  { value: "void", label: "Void" },
];
