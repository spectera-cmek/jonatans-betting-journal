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
