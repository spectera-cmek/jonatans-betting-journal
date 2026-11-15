// Chart colours for the "Oddstavlan" theme. Mode (dark/light) is persisted in
// localStorage by the ThemeProvider; the accent is fixed — amber is part of the
// identity, not a preference.
//
// SVG charts take plain colour values as props, so the handful they need is
// mirrored here from app/styles/tokens.css. Keep the two in step.

export type Mode = "dark" | "light";

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface ChartColors {
  /** The single-series colour: equity curves, coverage bars. */
  acc: string;
  /** Tint under an area line. */
  fill: string;
  grid: string;
  pos: string;
  red: string;
  txt: string;
  dim: string;
  line: string;
}

/**
 * Colour is used by job, never as decoration: amber for the one series a chart
 * is about, green/red for sign (always beside a +/− and a direction, so it never
 * rests on hue alone), grey for a reference series. There is deliberately no
 * categorical rainbow — sports and markets are told apart by name, not by hue.
 *
 * Checked with the dataviz validator against each surface: green↔red↔amber stay
 * apart under simulated protan/deutan vision (ΔE 8.8 dark, 7.2 light), and every
 * mark clears 3:1. On paper the bright amber fill is too pale to be a mark, so
 * light mode draws with a deeper step of the same hue.
 */
export function chartColors(mode: Mode): ChartColors {
  if (mode === "light") {
    return {
      acc: "#b87900",
      fill: "rgba(184,121,0,0.10)",
      grid: "#e3e0d5",
      pos: "#0a7742",
      red: "#c0271e",
      txt: "#17160f",
      dim: "#6a675e",
      line: "#d2cec1",
    };
  }
  return {
    acc: "#ffb000",
    fill: "rgba(255,176,0,0.09)",
    grid: "#1d1c1a",
    pos: "#46d68c",
    red: "#ff5f56",
    txt: "#eceae3",
    dim: "#86847a",
    line: "#2b2a26",
  };
}

/** Browser chrome (address bar / PWA status bar) per mode — the page canvas. */
export const THEME_COLOR: Record<Mode, string> = { dark: "#0a0a09", light: "#f3f1ea" };
