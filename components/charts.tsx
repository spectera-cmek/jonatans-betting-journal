"use client";

import { useId, useMemo, useRef, useState } from "react";

// Reusable themeable SVG charts (no chart library). Ported from the Aurora kit.

export interface TimePoint {
  t: number; // epoch ms
  v: number; // value (already in display currency)
}

/** min/max over a numeric array without spreading it into a call — the spread
 *  form is slower and overflows the stack on long series. */
function minOf(arr: number[]): number {
  let m = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] < m) m = arr[i];
  return m;
}
function maxOf(arr: number[]): number {
  let m = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

// Cap the rendered point count — the full history is 8k+ points and the path
// string alone would be ~100 kB. Hover still resolves to a real point.
function downsample(points: TimePoint[], max = 600): TimePoint[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out: TimePoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/**
 * Line chart with hover crosshair + tooltip and max-drawdown shading.
 * X is index-spaced (one step per settled bet) like the static LineChart,
 * so idle weeks don't flatten the curve; the tooltip carries the date.
 */
export function InteractiveLineChart({
  points,
  w = 640,
  h = 200,
  stroke = "#22c55e",
  fill = "rgba(34,197,94,0.14)",
  grid = "rgba(255,255,255,0.06)",
  redSoft = "rgba(244,63,94,0.07)",
  pad = 6,
  strokeW = 3,
  formatValue = (v: number) => String(Math.round(v)),
  formatDate = (t: number) =>
    new Date(t).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }),
}: {
  points: TimePoint[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: string;
  grid?: string;
  redSoft?: string;
  pad?: number;
  strokeW?: number;
  formatValue?: (v: number) => string;
  formatDate?: (t: number) => string;
}) {
  const gid = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const pts = useMemo(() => downsample(points), [points]);

  // Max-drawdown segment (peak index -> trough index) over the visible range.
  const dd = useMemo(() => {
    let peak = -Infinity;
    let peakI = 0;
    let maxDd = 0;
    let from = 0;
    let to = 0;
    pts.forEach((p, i) => {
      if (p.v > peak) {
        peak = p.v;
        peakI = i;
      }
      const drop = peak - p.v;
      if (drop > maxDd) {
        maxDd = drop;
        from = peakI;
        to = i;
      }
    });
    return maxDd > 0 ? { from, to } : null;
  }, [pts]);

  // Geometry depends only on the series and the box. It used to sit below the
  // early return, so every pointermove re-ran three full sweeps over up to 600
  // points and rebuilt the whole path string. min/max via a loop rather than
  // Math.min(...arr) — spreading 600 elements into a call is slow and, on longer
  // series, a stack-overflow risk.
  const geom = useMemo(() => {
    const n = pts.length;
    if (n < 2) return null;
    let min = pts[0].v;
    let max = pts[0].v;
    for (let i = 1; i < n; i++) {
      if (pts[i].v < min) min = pts[i].v;
      if (pts[i].v > max) max = pts[i].v;
    }
    const range = max - min || 1;
    const x = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
    const y = (v: number) => pad + (1 - (v - min) / range) * (h - pad * 2);
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
    const gridLines = [0.25, 0.5, 0.75].map((g) => pad + g * (h - pad * 2));
    return { n, x, y, line, area, gridLines };
  }, [pts, w, h, pad]);

  if (!geom) {
    return (
      <div style={{ height: h, display: "grid", placeItems: "center", color: "var(--dim2)", fontSize: 13 }}>
        Inte tillräckligt med data i perioden
      </div>
    );
  }

  const { n, x, y, line, area, gridLines } = geom;

  const onMove = (e: React.PointerEvent) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const hv = hover != null ? pts[hover] : null;
  const frac = hover != null ? hover / (n - 1) : 0;
  // Change vs the start of the visible range. Skipped when the range starts
  // at 0 (full cumulative series) — the diff would just repeat the value.
  const diff = hv && pts[0].v !== 0 ? hv.v - pts[0].v : null;

  return (
    <div
      ref={boxRef}
      style={{ position: "relative", touchAction: "pan-y" }}
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fill} />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </linearGradient>
        </defs>
        {gridLines.map((gy, i) => (
          <line key={i} x1={pad} y1={gy} x2={w - pad} y2={gy} stroke={grid} strokeWidth="1" strokeDasharray="3 3" />
        ))}
        {dd && dd.to > dd.from && (
          <rect
            x={x(dd.from)}
            y={pad}
            width={x(dd.to) - x(dd.from)}
            height={h - pad * 2}
            fill={redSoft}
          />
        )}
        <path d={area} fill={`url(#g${gid})`} />
        {/* soft glow under the stroke (no SVG filters — just a fat translucent twin) */}
        <path d={line} fill="none" stroke={stroke} strokeWidth={strokeW * 3} strokeLinejoin="round" strokeLinecap="round" opacity="0.15" />
        <path d={line} fill="none" stroke={stroke} strokeWidth={strokeW} strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <line x1={x(hover)} y1={pad} x2={x(hover)} y2={h - pad} stroke={stroke} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        )}
        {/* White-filled dot ringed in the series colour — the reference's
            active-point treatment; reads clearly over both fill and grid. */}
        <circle
          cx={x(hover ?? n - 1)}
          cy={y(pts[hover ?? n - 1].v)}
          r="4"
          fill="var(--card)"
          stroke={stroke}
          strokeWidth="2.5"
        />
      </svg>
      {hv && (
        <div
          style={{
            position: "absolute",
            top: 6,
            left: `${frac * 100}%`,
            transform: `translateX(${frac > 0.72 ? "-100%" : frac < 0.28 ? "0%" : "-50%"})`,
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-ctl)",
            padding: "8px 11px",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            boxShadow: "var(--shadow)",
            zIndex: 5,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--dim)" }}>{formatDate(hv.t)}</div>
          <div className="ap-num" style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
            {formatValue(hv.v)}
            {diff != null && diff !== 0 && (
              <span className={diff >= 0 ? "pos" : "neg"} style={{ fontSize: 11.5, marginLeft: 7, fontWeight: 600 }}>
                {diff >= 0 ? "+" : "−"}{formatValue(Math.abs(diff))}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Two cumulative series on a shared time axis — the what-if simulator's
 * "actual vs filtered" comparison. Series are downsampled independently.
 */
export function CompareChart({
  a,
  b,
  w = 640,
  h = 210,
  colorA = "#646b81",
  colorB = "#22c55e",
  grid = "rgba(255,255,255,0.06)",
  pad = 6,
}: {
  a: TimePoint[]; // baseline (actual)
  b: TimePoint[]; // scenario (filtered)
  w?: number;
  h?: number;
  colorA?: string;
  colorB?: string;
  grid?: string;
  pad?: number;
}) {
  const sa = useMemo(() => downsample(a), [a]);
  const sb = useMemo(() => downsample(b), [b]);
  // Bounds in one pass over the combined series (up to 1200 points) — the old
  // Math.min(...all.map(...)) built four throwaway arrays and spread each into
  // a call. Memoised so a parent re-render with the same data is free.
  const geom = useMemo(() => {
    if (sa.length < 2) return null;
    let tMin = Infinity;
    let tMax = -Infinity;
    let vMin = 0;
    let vMax = 0;
    for (const s of [sa, sb]) {
      for (const p of s) {
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      }
    }
    const tR = tMax - tMin || 1;
    const vR = vMax - vMin || 1;
    const x = (t: number) => pad + ((t - tMin) / tR) * (w - pad * 2);
    const y = (v: number) => pad + (1 - (v - vMin) / vR) * (h - pad * 2);
    const path = (pts: TimePoint[]) =>
      pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    return { x, y, path, zero: y(0) };
  }, [sa, sb, w, h, pad]);

  if (!geom) {
    return (
      <div style={{ height: h, display: "grid", placeItems: "center", color: "var(--dim2)", fontSize: 13 }}>
        Inte tillräckligt med data
      </div>
    );
  }
  const { x, y, path, zero } = geom;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      <line x1={pad} y1={zero} x2={w - pad} y2={zero} stroke={grid} strokeWidth="1.4" />
      <path d={path(sa)} fill="none" stroke={colorA} strokeWidth="1.8" strokeLinejoin="round" opacity="0.85" />
      {sb.length >= 2 && (
        <path d={path(sb)} fill="none" stroke={colorB} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {sb.length >= 2 && <circle cx={x(sb[sb.length - 1].t)} cy={y(sb[sb.length - 1].v)} r="3.5" fill={colorB} />}
      <circle cx={x(sa[sa.length - 1].t)} cy={y(sa[sa.length - 1].v)} r="3" fill={colorA} />
    </svg>
  );
}

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
  const min = minOf(data);
  const max = maxOf(data);
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
      <path d={line} fill="none" stroke={stroke} strokeWidth={strokeW * 3} strokeLinejoin="round" strokeLinecap="round" opacity="0.15" />
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
  const gid = useId().replace(/:/g, "");
  if (!data || !data.length) {
    return <div style={{ height: h, display: "grid", placeItems: "center", color: "var(--dim2)", fontSize: 13 }}>Ingen data</div>;
  }
  const vals = data.map((d) => d.units);
  const max = maxOf(vals.map(Math.abs)) || 1;
  const n = data.length;
  const gap = 10;
  const bw = (w - gap * (n - 1)) / n;
  const zero = h * 0.62;
  const scale = (Math.min(zero, h - zero) - 18) / max;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }}>
      <defs>
        {/* solid at the bar tip, fading toward the zero line */}
        <linearGradient id={`pb${gid}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={pos} />
          <stop offset="100%" stopColor={pos} stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id={`pb${gid}n`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={neg} stopOpacity="0.45" />
          <stop offset="100%" stopColor={neg} />
        </linearGradient>
      </defs>
      {track && <line x1="0" y1={zero} x2={w} y2={zero} stroke={track} strokeWidth="1" />}
      {data.map((d, i) => {
        const v = d.units;
        const bh = Math.abs(v) * scale;
        const bx = i * (bw + gap);
        const by = v >= 0 ? zero - bh : zero;
        return (
          <g key={i}>
            <rect
              x={bx}
              y={by}
              width={bw}
              height={Math.max(bh, 1)}
              rx="4"
              fill={v >= 0 ? `url(#pb${gid}p)` : `url(#pb${gid}n)`}
              opacity={i === n - 1 ? 1 : 0.85}
            />
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
        // ~3° of separation between segments, matching the reference's
        // paddingAngle (skipped for slivers so they stay visible).
        const len = (d.pct / 100) * circ;
        const g = len > 6 ? (3 / 360) * circ : 0;
        const el = (
          <circle
            key={i}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={colors[i % colors.length]}
            strokeWidth={thickness}
            strokeDasharray={`${Math.max(len - g, 0.1)} ${circ - len + g}`}
            strokeDashoffset={-(offset + g / 2)}
            transform={`rotate(-90 ${c} ${c})`}
            strokeLinecap="butt"
          />
        );
        offset += len;
        return el;
      })}
      {centerLabel && (
        <text
          x={c}
          y={c - 2}
          textAnchor="middle"
          fontSize={size * 0.19}
          fontWeight="800"
          fill={centerColor}
          fontFamily="var(--mono)"
          letterSpacing="-0.02em"
        >
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text
          x={c}
          y={c + size * 0.14}
          textAnchor="middle"
          fontSize={size * 0.085}
          fontWeight="700"
          fill={centerSubColor}
          fontFamily="inherit"
          letterSpacing="0.07em"
        >
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

// Spark and HBar now live in ./miniCharts so that ui.tsx/stats.tsx can pull them
// in without this module. Re-exported here so existing import sites keep working.
export { Spark, HBar } from "./miniCharts";
