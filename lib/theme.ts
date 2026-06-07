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
  { key: "violett", label: "Violett", hex: "#8f74ff", soft: "rgba(143,116,255,0.16)", text: "#16102a" },
  { key: "emerald", label: "Smaragd", hex: "#2fd98a", soft: "rgba(47,217,138,0.16)", text: "#06210f" },
  { key: "blå", label: "Blå", hex: "#4f8bff", soft: "rgba(79,139,255,0.16)", text: "#ffffff" },
  { key: "bärnsten", label: "Bärnsten", hex: "#f5a524", soft: "rgba(245,165,36,0.16)", text: "#2a1c02" },
];

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
  return {
    acc: accentHex,
    fill: hexA(accentHex, dark ? 0.18 : 0.12),
    grid: dark ? "rgba(255,255,255,0.05)" : "rgba(20,22,34,0.06)",
    pos: dark ? "#3fe0a8" : "#10a06b",
    red: dark ? "#ff6079" : "#e23b52",
    txt: dark ? "#eef0f7" : "#161a26",
    dim: dark ? "#646b81" : "#959cb1",
    line: dark ? "rgba(255,255,255,0.07)" : "rgba(20,22,34,0.09)",
    palette: [accentHex, "#3fe0a8", "#5ea8ff", "#ffb454", "#ff6079"],
  };
}
