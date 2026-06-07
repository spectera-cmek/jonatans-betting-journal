"use client";

import { useId } from "react";

// Reusable themeable SVG charts (no chart library). Ported from the Aurora kit.

export function LineChart({
  data,
  w = 560,
  h = 180,
  stroke = "#22c55e",
  fill = "rgba(34,197,94,0.14)",
  grid = "rgba(255,255,255,0.06)",
  pad = 6,
  strokeW = 2,
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: string;
  grid?: string;
  pad?: number;
  strokeW?: number;
}) {
  const gid = useId().replace(/:/g, "");
  if (!data || data.length < 2) {
    return (
      <div style={{ height: h, display: "grid", placeItems: "center", color: "var(--dim2)", fontSize: 13 }}>
        Inte tillräckligt med data än
      </div>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / range) * (h - pad * 2);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const gridLines = [0.25, 0.5, 0.75].map((g) => pad + g * (h - pad * 2));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs>
        <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
      </defs>
      {gridLines.map((gy, i) => (
        <line key={i} x1={pad} y1={gy} x2={w - pad} y2={gy} stroke={grid} strokeWidth="1" />
      ))}
      <path d={area} fill={`url(#g${gid})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={strokeW} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="3.5" fill={stroke} />
    </svg>
  );
}

export function PLBars({
  data,
  w = 560,
  h = 170,
  pos = "#22c55e",
  neg = "#ef4444",
  labelColor = "rgba(255,255,255,0.5)",
  track,
}: {
  data: { m: string; units: number }[];
  w?: number;
  h?: number;
  pos?: string;
  neg?: string;
  labelColor?: string;
  track?: string;
}) {
  if (!data || !data.length) {
    return <div style={{ height: h, display: "grid", placeItems: "center", color: "var(--dim2)", fontSize: 13 }}>Ingen data</div>;
  }
  const vals = data.map((d) => d.units);
  const max = Math.max(...vals.map(Math.abs)) || 1;
  const n = data.length;
  const gap = 10;
  const bw = (w - gap * (n - 1)) / n;
  const zero = h * 0.62;
  const scale = (Math.min(zero, h - zero) - 18) / max;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }}>
      {track && <line x1="0" y1={zero} x2={w} y2={zero} stroke={track} strokeWidth="1" />}
      {data.map((d, i) => {
        const v = d.units;
        const bh = Math.abs(v) * scale;
        const bx = i * (bw + gap);
        const by = v >= 0 ? zero - bh : zero;
        return (
          <g key={i}>
            <rect x={bx} y={by} width={bw} height={Math.max(bh, 1)} rx="3" fill={v >= 0 ? pos : neg} opacity={v >= 0 ? 1 : 0.9} />
            <text x={bx + bw / 2} y={h - 2} textAnchor="middle" fontSize="11" fill={labelColor} fontFamily="inherit">
              {d.m}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Donut({
  data,
  size = 150,
  thickness = 22,
  colors,
  track = "rgba(255,255,255,0.06)",
  centerLabel,
  centerSub,
  centerColor = "#fff",
  centerSubColor = "rgba(255,255,255,0.5)",
}: {
  data: { pct: number }[];
  size?: number;
  thickness?: number;
  colors: string[];
  track?: string;
  centerLabel?: string;
  centerSub?: string;
  centerColor?: string;
  centerSubColor?: string;
}) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={thickness} />
      {data.map((d, i) => {
        const len = (d.pct / 100) * circ;
        const el = (
          <circle
            key={i}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={colors[i % colors.length]}
            strokeWidth={thickness}
            strokeDasharray={`${len} ${circ - len}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${c} ${c})`}
            strokeLinecap="butt"
          />
        );
        offset += len;
        return el;
      })}
      {centerLabel && (
        <text x={c} y={c - 2} textAnchor="middle" fontSize={size * 0.2} fontWeight="700" fill={centerColor} fontFamily="inherit">
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text x={c} y={c + size * 0.13} textAnchor="middle" fontSize={size * 0.085} fill={centerSubColor} fontFamily="inherit" letterSpacing="0.04em">
          {centerSub}
        </text>
      )}
    </svg>
  );
}

export function Ring({
  pct,
  size = 120,
  thickness = 12,
  color = "#22c55e",
  track = "rgba(255,255,255,0.08)",
  textColor = "#fff",
  sub = "WIN RATE",
  subColor = "rgba(255,255,255,0.5)",
}: {
  pct: number;
  size?: number;
  thickness?: number;
  color?: string;
  track?: string;
  textColor?: string;
  sub?: string;
  subColor?: string;
}) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const len = (pct / 100) * circ;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={thickness} />
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        strokeDasharray={`${len} ${circ - len}`}
        strokeDashoffset={0}
        transform={`rotate(-90 ${c} ${c})`}
        strokeLinecap="round"
      />
      <text x={c} y={c} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.24} fontWeight="700" fill={textColor} fontFamily="inherit">
        {pct.toFixed(1)}%
      </text>
      <text x={c} y={c + size * 0.22} textAnchor="middle" fontSize={size * 0.085} fill={subColor} letterSpacing="0.12em" fontFamily="inherit">
        {sub}
      </text>
    </svg>
  );
}

export function Spark({ data, w = 150, h = 26, stroke = "#22c55e", strokeW = 1.6 }: { data: number[]; w?: number; h?: number; stroke?: string; strokeW?: number }) {
  if (!data || data.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * w;
  const y = (v: number) => 2 + (1 - (v - min) / range) * (h - 4);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      <path d={line} fill="none" stroke={stroke} strokeWidth={strokeW} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function HBar({ pct, color, track = "rgba(255,255,255,0.07)", h = 6, radius = 3 }: { pct: number; color: string; track?: string; h?: number; radius?: number }) {
  return (
    <div style={{ height: h, background: track, borderRadius: radius, overflow: "hidden", width: "100%" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: radius }} />
    </div>
  );
}
