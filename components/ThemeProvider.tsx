"use client";

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { chartColors, THEME_COLOR, type ChartColors, type Mode } from "@/lib/theme";

interface ThemeState {
  mode: Mode;
  cc: ChartColors;
  setMode: (m: Mode) => void;
}

const ThemeCtx = createContext<ThemeState | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Dark is the default. The only stored preference is the mode ("bj.mode");
  // the accent picker and glow toggle of earlier designs are gone, and their
  // old keys (bj.accent, bj.glow) are simply never read.
  const [mode, setModeState] = useState<Mode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const m = localStorage.getItem("bj.mode");
      if (m === "light" || m === "dark") setModeState(m);
    } catch {}
    setReady(true);
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try { localStorage.setItem("bj.mode", m); } catch {}
  }, []);

  // Keep <html> in step with the chosen mode. The pre-paint script sets
  // data-mode there once at load; without this a toggle left the root on the
  // old mode until the next reload, so root-scoped rules (color-scheme, the
  // overscroll canvas) and the browser's theme-color lagged.
  useEffect(() => {
    if (!ready) return;
    document.documentElement.setAttribute("data-mode", mode);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[mode]);
  }, [mode, ready]);

  const cc = useMemo(() => chartColors(mode), [mode]);
  const value = useMemo(() => ({ mode, cc, setMode }), [mode, cc, setMode]);

  return (
    <ThemeCtx.Provider value={value}>
      {/* Children render immediately: the pre-paint script in app/layout.tsx has
          already put the right mode on <html>, so there is nothing to hide.
          Until the stored mode has been read this wrapper carries no data-mode
          of its own and inherits the tokens from <html>. */}
      <div className="ap" data-mode={ready ? mode : undefined} suppressHydrationWarning>
        {children}
      </div>
    </ThemeCtx.Provider>
  );
}
