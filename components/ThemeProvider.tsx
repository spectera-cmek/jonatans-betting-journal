"use client";

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
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
  // Defaults = the terminal look: emerald accent, dark, no glow. Storage keys
  // stay namespaced "bj.*".
  const [accentHex, setAccentHex] = useState(ACCENTS[0].hex);
  const [mode, setModeState] = useState<"dark" | "light">("dark");
  const [glow, setGlowState] = useState(false);
  const [ready, setReady] = useState(false);

  // Load persisted prefs on mount. A stored accent from the previous palette no
  // longer matches any swatch — ignore it so those users land on the new default
  // rather than on an accent the Settings page can't show as selected.
  useEffect(() => {
    try {
      const a = localStorage.getItem("bj.accent");
      const m = localStorage.getItem("bj.mode");
      const g = localStorage.getItem("bj.glow");
      if (a && ACCENTS.some((x) => x.hex === a)) setAccentHex(a);
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

  const accent = useMemo(() => ACCENTS.find((a) => a.hex === accentHex) || ACCENTS[0], [accentHex]);
  const cc = useMemo(() => chartColors(accent.hex, mode), [accent.hex, mode]);

  // Held back until the stored prefs have been read. Before that the accent
  // comes from the inline script in app/layout.tsx, which sets the same three
  // custom properties on :root — an inline style here would outrank it and
  // reintroduce the flash for anyone on a non-default accent.
  const rootStyle = useMemo(
    () =>
      ready
        ? ({
            "--acc": accent.hex,
            "--acc-soft": accent.soft,
            "--acc-text": accent.text,
          } as React.CSSProperties)
        : undefined,
    [ready, accent]
  );

  const value = useMemo(
    () => ({ accent, mode, glow, cc, setAccent, setMode, setGlow }),
    [accent, mode, glow, cc, setAccent, setMode, setGlow]
  );

  return (
    <ThemeCtx.Provider value={value}>
      {/* children render immediately: the pre-paint script in app/layout.tsx has
          already put the right theme on <html>, so there is nothing to hide. */}
      <div className="ap" data-mode={mode} style={rootStyle} suppressHydrationWarning>
        {children}
      </div>
    </ThemeCtx.Provider>
  );
}
