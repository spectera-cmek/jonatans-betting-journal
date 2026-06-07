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

export const OUTCOME_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "bg-rowpending", text: "text-[#60A5FA]", label: "Pending" },
  win: { bg: "bg-rowwin", text: "text-pos", label: "Win" },
  loss: { bg: "bg-rowloss", text: "text-neg", label: "Loss" },
  push: { bg: "bg-rowpush", text: "text-accent-amber", label: "Push" },
  half_win: { bg: "bg-rowwin", text: "text-pos", label: "½ Win" },
  half_loss: { bg: "bg-rowloss", text: "text-neg", label: "½ Loss" },
  void: { bg: "bg-rowvoid", text: "text-text-mid", label: "Void" },
};

// Status "pill" styles (dot + uppercase label), matching the pro-terminal look.
export const STATUS_PILL: Record<
  string,
  { dot: string; text: string; ring: string; label: string }
> = {
  pending: { dot: "bg-[#60A5FA]", text: "text-[#60A5FA]", ring: "ring-[#60A5FA]/25", label: "PENDING" },
  win: { dot: "bg-pos", text: "text-pos", ring: "ring-pos/25", label: "WON" },
  loss: { dot: "bg-neg", text: "text-neg", ring: "ring-neg/25", label: "LOST" },
  push: { dot: "bg-accent-amber", text: "text-accent-amber", ring: "ring-accent-amber/25", label: "PUSH" },
  half_win: { dot: "bg-pos", text: "text-pos", ring: "ring-pos/25", label: "½ WON" },
  half_loss: { dot: "bg-neg", text: "text-neg", ring: "ring-neg/25", label: "½ LOST" },
  void: { dot: "bg-text-lo", text: "text-text-mid", ring: "ring-text-lo/25", label: "VOID" },
};
