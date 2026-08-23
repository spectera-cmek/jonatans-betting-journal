"use client";

import { useId, useMemo } from "react";

// The two tiny primitives that components/ui.tsx and components/stats.tsx need.
// They used to live in charts.tsx, which meant importing ui.tsx — i.e. nearly
// every page — dragged all seven full-size chart components into the bundle for
// the sake of a sparkline and a progress bar. Kept as their own module so the
// heavy charts stay on the routes that actually draw them.

/** Inline trend line for KPI cards. Fills a faint wash under the stroke so it
 *  reads as a mini area chart rather than a stray squiggle. */
export function Spark({
  data,
  w = 150,
  h = 26,
  stroke = "var(--pos)",
  strokeW = 1.8,
  fill = true,
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  strokeW?: number;
  fill?: boolean;
}) {
  const gid = useId().replace(/:/g, "");
  // A Spark sits in every KPI card, so this ran on each parent re-render.
  // Memoised, and min/max via a loop rather than Math.min(...data) — spreading
  // a long series into a call is both slower and stack-limited.
  const geom = useMemo(() => {
    if (!data || data.length < 2) return null;
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const range = max - min || 1;
    const x = (i: number) => (i / (data.length - 1)) * w;
    const y = (v: number) => 2 + (1 - (v - min) / range) * (h - 4);
    const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return { line, area: `${line} L${w},${h} L0,${h} Z` };
  }, [data, w, h]);

  if (!geom) return <svg width={w} height={h} />;
  const { line, area } = geom;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      {fill && (
        <defs>
          <linearGradient id={`sp${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.3" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={area} fill={`url(#sp${gid})`} />}
      <path d={line} fill="none" stroke={stroke} strokeWidth={strokeW} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function HBar({ pct, color, track = "var(--hover)", h = 6, radius = 999 }: { pct: number; color: string; track?: string; h?: number; radius?: number }) {
  return (
    <div style={{ height: h, background: track, borderRadius: radius, overflow: "hidden", width: "100%" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: radius }} />
    </div>
  );
}
