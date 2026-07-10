// Aurora theme: accent options + chart-color builder. Mode (dark/light) and
// accent are persisted in localStorage by the ThemeProvider.

export interface Accent {
  key: string;
  label: string;
  hex: string;
  soft: string;
  text: string;
}

export const ACCENTS: Accent[] = [
  { key: "silver", label: "Silver", hex: "#e6e8f0", soft: "rgba(230,232,240,0.1)", text: "#0a0b0f" },
  { key: "violett", label: "Violett", hex: "#8f74ff", soft: "rgba(143,116,255,0.16)", text: "#16102a" },
  { key: "emerald", label: "Smaragd", hex: "#2fd98a", soft: "rgba(47,217,138,0.16)", text: "#06210f" },
  { key: "blå", label: "Blå", hex: "#4f8bff", soft: "rgba(79,139,255,0.16)", text: "#ffffff" },
  { key: "bärnsten", label: "Bärnsten", hex: "#f5a524", soft: "rgba(245,165,36,0.16)", text: "#2a1c02" },
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

export function chartColors(accentHex: string, mode: "dark" | "light"): ChartColors {
  const dark = mode === "dark";
  // A near-white/silver accent (the default "Mörk premium" look) reads as a
  // monochrome system — categorical series use a grayscale ramp instead of a
  // rainbow so the sport donut / breakdowns stay restrained. Coloured accents
  // keep the vivid palette.
  const mono = luminance(accentHex) > 0.75;
  const palette = mono
    ? dark
      ? ["#e6e8f0", "#9aa0b4", "#666c80", "#3d4254", "#262a38"]
      : ["#2e3140", "#5a6075", "#8b90a3", "#b4b9c8", "#d2d6e0"]
    : [accentHex, "#35d492", "#5ea8ff", "#ffb454", "#ff5c74"];
  return {
    acc: accentHex,
    fill: hexA(accentHex, dark ? (mono ? 0.09 : 0.18) : 0.12),
    grid: dark ? "rgba(255,255,255,0.05)" : "rgba(20,22,34,0.06)",
    pos: dark ? "#35d492" : "#10a06b",
    red: dark ? "#ff5c74" : "#e23b52",
    txt: dark ? "#f2f3f7" : "#14161c",
    dim: dark ? "#6b7080" : "#8b90a3",
    line: dark ? "rgba(255,255,255,0.06)" : "rgba(20,22,34,0.09)",
    palette,
  };
}
