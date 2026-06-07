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
  const [accentHex, setAccentHex] = useState("#8f74ff");
  const [mode, setModeState] = useState<"dark" | "light">("dark");
  const [glow, setGlowState] = useState(true);
  const [ready, setReady] = useState(false);

  // Load persisted prefs on mount.
  useEffect(() => {
    try {
      const a = localStorage.getItem("vigg.accent");
      const m = localStorage.getItem("vigg.mode");
      const g = localStorage.getItem("vigg.glow");
      if (a) setAccentHex(a);
      if (m === "light" || m === "dark") setModeState(m);
      if (g != null) setGlowState(g === "1");
    } catch {}
    setReady(true);
  }, []);

  const setAccent = useCallback((hex: string) => {
    setAccentHex(hex);
    try { localStorage.setItem("vigg.accent", hex); } catch {}
  }, []);
  const setMode = useCallback((m: "dark" | "light") => {
    setModeState(m);
    try { localStorage.setItem("vigg.mode", m); } catch {}
  }, []);
  const setGlow = useCallback((g: boolean) => {
    setGlowState(g);
    try { localStorage.setItem("vigg.glow", g ? "1" : "0"); } catch {}
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
