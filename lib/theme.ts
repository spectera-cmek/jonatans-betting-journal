// Aurora theme: accent options + chart-color builder. Mode (dark/light) and
// accent are persisted in localStorage by the ThemeProvider.

export interface Accent {
  key: string;
  label: string;
  hex: string;
  soft: string;
  text: string;
}

/** Emerald leads — it is the brand accent of the terminal design. Outcome green
 *  (--pos) is a lighter shade so a win still reads apart from ordinary chrome. */
export const ACCENTS: Accent[] = [
  { key: "emerald", label: "Smaragd", hex: "#10b981", soft: "rgba(16,185,129,0.14)", text: "#04140d" },
  { key: "blå", label: "Sky", hex: "#0ea5e9", soft: "rgba(14,165,233,0.14)", text: "#04121c" },
  { key: "violett", label: "Violett", hex: "#a855f7", soft: "rgba(168,85,247,0.16)", text: "#180a26" },
  { key: "bärnsten", label: "Bärnsten", hex: "#f59e0b", soft: "rgba(245,158,11,0.16)", text: "#1f1302" },
  { key: "silver", label: "Silver", hex: "#e2e8f0", soft: "rgba(226,232,240,0.1)", text: "#020617" },
];

/** Relative luminance of a #rrggbb colour (0 = black, 1 = white). */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface ChartColors {
  acc: string;
  fill: string;
  grid: string;
  pos: string;
  red: string;
  txt: string;
  dim: string;
  line: string;
  palette: string[];
}

/** The categorical ramp used by donuts, breakdowns and stacked bars. Mirrors the
 *  per-metric accent family in globals.css so a chart slice and the KPI chip for
 *  the same thing land on the same hue. */
export const CHART_PALETTE = [
  "#10b981", // emerald
  "#0ea5e9", // sky
  "#f59e0b", // amber
  "#a855f7", // purple
  "#14b8a6", // teal
  "#ec4899", // pink
  "#f97316", // orange
  "#3b82f6", // blue
  "#06b6d4", // cyan
];

/** Stable colour per sport, so the same sport keeps its hue across the donut,
 *  the breakdown bars and the coloured dot in the bet tables. Keys are matched
 *  case-insensitively against a normalised sport name. */
export const SPORT_COLORS: Record<string, string> = {
  // canonical names (lib/constants.ts)
  football: "#10b981",
  tennis: "#14b8a6",
  basketball: "#f97316",
  "ice hockey": "#06b6d4",
  "american football": "#3b82f6",
  baseball: "#ef4444",
  mma: "#ec4899",
  boxing: "#f43f5e",
  esports: "#a855f7",
  "horse racing": "#f59e0b",
  golf: "#84cc16",
  cricket: "#8b5cf6",
  other: "#64748b",
  // Swedish aliases seen in imported rows
  fotboll: "#10b981",
  basket: "#f97316",
  ishockey: "#06b6d4",
  hockey: "#06b6d4",
  baseboll: "#ef4444",
  handboll: "#8b5cf6",
  boxning: "#f43f5e",
  esport: "#a855f7",
  trav: "#f59e0b",
  travsport: "#f59e0b",
  bordtennis: "#fb7185",
  padel: "#2dd4bf",
  övrigt: "#64748b",
};

/** Colour for a sport label; falls back to a stable hash into CHART_PALETTE so
 *  unknown sports still get a consistent (never grey-on-grey) colour. Longest
 *  key first so "American Football" doesn't match "football". */
const SPORT_COLOR_KEYS = Object.keys(SPORT_COLORS).sort((a, b) => b.length - a.length);

export function sportColor(sport?: string | null): string {
  if (!sport) return SPORT_COLORS.other;
  const key = sport.trim().toLowerCase();
  for (const k of SPORT_COLOR_KEYS) {
    if (key === k || key.startsWith(k)) return SPORT_COLORS[k];
  }
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return CHART_PALETTE[h % CHART_PALETTE.length];
}

export function chartColors(accentHex: string, mode: "dark" | "light"): ChartColors {
  const dark = mode === "dark";
  // A near-white/silver accent reads as a monochrome system — categorical series
  // use a grayscale ramp instead of a rainbow so the sport donut / breakdowns
  // stay restrained. Coloured accents keep the vivid palette.
  const mono = luminance(accentHex) > 0.75;
  const palette = mono
    ? dark
      ? ["#e2e8f0", "#94a3b8", "#64748b", "#475569", "#334155"]
      : ["#1e293b", "#475569", "#64748b", "#94a3b8", "#cbd5e1"]
    : [accentHex, ...CHART_PALETTE.filter((c) => c.toLowerCase() !== accentHex.toLowerCase())];
  return {
    acc: accentHex,
    fill: hexA(accentHex, dark ? (mono ? 0.09 : 0.35) : 0.18),
    grid: dark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.06)",
    pos: dark ? "#34d399" : "#059669",
    red: dark ? "#f43f5e" : "#e11d48",
    txt: dark ? "#f1f5f9" : "#0f172a",
    dim: dark ? "#94a3b8" : "#64748b",
    line: dark ? "rgba(148,163,184,0.16)" : "rgba(15,23,42,0.1)",
    palette,
  };
}
