"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { ACCENTS, chartColors, type Accent, type ChartColors } from "@/lib/theme";

interface ThemeState {
  accent: Accent;
  mode: "dark" | "light";
  glow: boolean;
  cc: ChartColors;
  setAccent: (hex: string) => void;
  setMode: (m: "dark" | "light") => void;
  setGlow: (g: boolean) => void;
}

const ThemeCtx = createContext<ThemeState | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Defaults = the "Mörk premium" look: silver accent, dark, no glow. The
  // storage keys are namespaced "bj.*" (new) so the redesign shows for everyone
  // regardless of accent/glow they'd saved under the old "vigg.*" keys.
  const [accentHex, setAccentHex] = useState("#e6e8f0");
  const [mode, setModeState] = useState<"dark" | "light">("dark");
  const [glow, setGlowState] = useState(false);
  const [ready, setReady] = useState(false);

  // Load persisted prefs on mount.
  useEffect(() => {
    try {
      const a = localStorage.getItem("bj.accent");
      const m = localStorage.getItem("bj.mode");
      const g = localStorage.getItem("bj.glow");
      if (a) setAccentHex(a);
      if (m === "light" || m === "dark") setModeState(m);
      if (g != null) setGlowState(g === "1");
    } catch {}
    setReady(true);
  }, []);

  const setAccent = useCallback((hex: string) => {
    setAccentHex(hex);
    try { localStorage.setItem("bj.accent", hex); } catch {}
  }, []);
  const setMode = useCallback((m: "dark" | "light") => {
    setModeState(m);
    try { localStorage.setItem("bj.mode", m); } catch {}
  }, []);
  const setGlow = useCallback((g: boolean) => {
    setGlowState(g);
    try { localStorage.setItem("bj.glow", g ? "1" : "0"); } catch {}
  }, []);

  const accent = ACCENTS.find((a) => a.hex === accentHex) || ACCENTS[0];
  const cc = chartColors(accent.hex, mode);

  const rootStyle = {
    "--acc": accent.hex,
    "--acc-soft": accent.soft,
    "--acc-text": accent.text,
  } as React.CSSProperties;

  return (
    <ThemeCtx.Provider value={{ accent, mode, glow, cc, setAccent, setMode, setGlow }}>
      <div className="ap" data-mode={mode} style={rootStyle} suppressHydrationWarning>
        {ready ? children : null}
      </div>
    </ThemeCtx.Provider>
  );
}
