"use client";

import { useMemo, useRef, useState } from "react";

// Themeable SVG charts (no chart library). Colours default to CSS tokens
// (--chart, --line2 …) so a chart is right in both modes without props.
//
// The plots stretch to their container (preserveAspectRatio="none"), which
// would distort anything with a shape — so strokes are non-scaling, and
// everything that must stay undistorted (axis labels, the last-value tag, the
// marker, the tooltip) is HTML laid over the SVG.

export interface TimePoint {
  t: number; // epoch ms
  v: number; // value (already in display currency)
}

// Cap the rendered point count — the full history is 8k+ points and the path
// string alone would be ~100 kB. Hover still resolves to a real point.
function downsample<T>(points: T[], max = 600): T[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/** Round tick values (1/2/5 × 10ⁿ) inside [min, max]. */
function niceTicks(min: number, max: number, target = 4): number[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

const defaultDate = (t: number) =>
  new Date(t).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

function Empty({ h, children }: { h: number; children: React.ReactNode }) {
  return (
    <div className="ap-chart-empty" style={{ height: h }}>
      {children}
    </div>
  );
}

/**
 * Value scale in the right-hand gutter: round ticks, plus (optionally) a filled
 * tag at the series' last value — the "price tag" of a dealing screen. Ticks
 * that would collide with the tag are dropped rather than overlapped.
 */
function Axis({
  ticks,
  y,
  h,
  format,
  last,
}: {
  ticks: number[];
  y: (v: number) => number;
  h: number;
  format: (v: number) => string;
  last?: number;
}) {
  const lastY = last != null ? y(last) : null;
  // Labels are absolutely positioned, so the gutter is sized by an invisible
  // copy of the widest one (see .ap-chart-axis::after).
  let widest = last != null ? format(last) : "";
  for (const t of ticks) {
    const s = format(t);
    if (s.length > widest.length) widest = s;
  }
  return (
    <div className="ap-chart-axis" style={{ height: h }} data-w={widest} aria-hidden="true">
      {ticks.map((t) => {
        const ty = y(t);
        if (ty < 5 || ty > h - 5) return null;
        if (lastY != null && Math.abs(ty - lastY) < 13) return null;
        return (
          <span key={t} style={{ top: ty }}>
            {format(t)}
          </span>
        );
      })}
      {lastY != null && (
        <span className="ap-chart-last" style={{ top: Math.min(h - 8, Math.max(8, lastY)) }}>
          {format(last!)}
        </span>
      )}
    </div>
  );
}

interface LinePlotProps {
  values: number[];
  /** Epoch ms per value. Enables the date in the tooltip and the x-axis ends. */
  times?: number[];
  interactive: boolean;
  /** Shade the deepest peak-to-trough fall. */
  drawdown?: boolean;
  w: number;
  h: number;
  stroke: string;
  fill: string;
  grid: string;
  redSoft: string;
  pad: number;
  strokeW: number;
  formatValue: (v: number) => string;
  formatAxis: (v: number) => string;
  formatDate: (t: number) => string;
  emptyText: string;
}

function LinePlot({
  values,
  times,
  interactive,
  drawdown,
  w,
  h,
  stroke,
  fill,
  grid,
  redSoft,
  pad,
  strokeW,
  formatValue,
  formatAxis,
  formatDate,
  emptyText,
}: LinePlotProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Max-drawdown segment (peak index -> trough index) over the visible range.
  const dd = useMemo(() => {
    if (!drawdown) return null;
    let peak = -Infinity;
    let peakI = 0;
    let maxDd = 0;
    let from = 0;
    let to = 0;
    values.forEach((v, i) => {
      if (v > peak) {
        peak = v;
        peakI = i;
      }
      const drop = peak - v;
      if (drop > maxDd) {
        maxDd = drop;
        from = peakI;
        to = i;
      }
    });
    return maxDd > 0 && to > from ? { from, to } : null;
  }, [values, drawdown]);

  // Geometry depends only on the series and the box, so a pointermove never
  // rebuilds the path. min/max via a loop rather than Math.min(...arr) —
  // spreading a long series into a call is slow and stack-limited.
  const geom = useMemo(() => {
    const n = values.length;
    if (n < 2) return null;
    let min = values[0];
    let max = values[0];
    for (let i = 1; i < n; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    const range = max - min || 1;
    const x = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
    const y = (v: number) => pad + (1 - (v - min) / range) * (h - pad * 2);
    const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
    return { n, x, y, line, area, ticks: niceTicks(min, max), hasZero: min < 0 && max > 0 };
  }, [values, w, h, pad]);

  if (!geom) return <Empty h={h}>{emptyText}</Empty>;

  const { n, x, y, line, area, ticks, hasZero } = geom;
  const last = values[n - 1];

  const onMove = (e: React.PointerEvent) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const at = hover ?? n - 1;
  const frac = hover != null ? hover / (n - 1) : 0;
  const hv = hover != null ? values[hover] : null;
  // Change vs the start of the visible range. Skipped when the range starts
  // at 0 (full cumulative series) — the diff would just repeat the value.
  const diff = hv != null && values[0] !== 0 ? hv - values[0] : null;

  const label =
    times && n > 1
      ? `Linjediagram: ${formatValue(values[0])} den ${formatDate(times[0])} till ${formatValue(last)} den ${formatDate(times[n - 1])}`
      : `Linjediagram: från ${formatValue(values[0])} till ${formatValue(last)}`;

  return (
    <div className="ap-chart">
      <div className="ap-chart-row">
        <div
          ref={boxRef}
          className="ap-chart-plot"
          style={{ height: h }}
          {...(interactive
            ? { onPointerMove: onMove, onPointerDown: onMove, onPointerLeave: () => setHover(null) }
            : {})}
        >
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={label}>
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                y1={y(t)}
                x2={w}
                y2={y(t)}
                stroke={t === 0 && hasZero ? "var(--line)" : grid}
                strokeWidth="1"
                strokeDasharray={t === 0 && hasZero ? undefined : "1 3"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {dd && <rect x={x(dd.from)} y={0} width={x(dd.to) - x(dd.from)} height={h} fill={redSoft} />}
            <path d={area} fill={fill} />
            <path
              d={line}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeW}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {hover != null && (
              <line
                x1={x(hover)}
                y1={0}
                x2={x(hover)}
                y2={h}
                stroke="var(--dim2)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {dd && (
            <span className="ap-chart-dd" style={{ left: `${((x(dd.from) + x(dd.to)) / 2 / w) * 100}%` }} aria-hidden="true">
              Max DD
            </span>
          )}
          {/* The marker: HTML so it stays a true square at any plot width. The
              panel-coloured ring separates it from the line it sits on. */}
          <i
            className="ap-chart-dot"
            style={{ left: `${(x(at) / w) * 100}%`, top: y(values[at]), background: stroke }}
            aria-hidden="true"
          />
          {hv != null && (
            <div
              className="ap-chart-tip"
              style={{
                left: `${(x(at) / w) * 100}%`,
                transform: `translateX(${frac > 0.72 ? "calc(-100% - 10px)" : "10px"})`,
              }}
            >
              {times && <div className="ap-chart-tip-date">{formatDate(times[at])}</div>}
              <div className="ap-num ap-chart-tip-val">
                {formatValue(hv)}
                {diff != null && diff !== 0 && (
                  <span className={diff >= 0 ? "pos" : "neg"}>
                    {diff >= 0 ? "+" : "−"}
                    {formatValue(Math.abs(diff))}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
        <Axis ticks={ticks} y={y} h={h} format={formatAxis} last={last} />
      </div>
      {times && (
        <div className="ap-chart-x" aria-hidden="true">
          <span>{formatDate(times[0])}</span>
          <span>{formatDate(times[n - 1])}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Line chart with hover crosshair + tooltip, a value scale and max-drawdown
 * shading. X is index-spaced (one step per settled bet), so idle weeks don't
 * flatten the curve; the tooltip carries the date.
 */
export function InteractiveLineChart({
  points,
  w = 640,
  h = 200,
  stroke = "var(--chart)",
  fill = "var(--chart-fill)",
  grid = "var(--line)",
  redSoft = "var(--red-soft)",
  pad = 6,
  strokeW = 1.75,
  formatValue = (v: number) => String(Math.round(v)),
  formatAxis,
  formatDate = defaultDate,
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
  /** Shorter format for the scale; defaults to formatValue. */
  formatAxis?: (v: number) => string;
  formatDate?: (t: number) => string;
}) {
  const pts = useMemo(() => downsample(points), [points]);
  const values = useMemo(() => pts.map((p) => p.v), [pts]);
  const times = useMemo(() => pts.map((p) => p.t), [pts]);
  return (
    <LinePlot
      values={values}
      times={times}
      interactive
      drawdown
      w={w}
      h={h}
      stroke={stroke}
      fill={fill}
      grid={grid}
      redSoft={redSoft}
      pad={pad}
      strokeW={strokeW}
      formatValue={formatValue}
      formatAxis={formatAxis ?? formatValue}
      formatDate={formatDate}
      emptyText="Inte tillräckligt med data i perioden"
    />
  );
}

/** Static line over an index axis, with the same value scale. */
export function LineChart({
  data,
  w = 560,
  h = 180,
  stroke = "var(--chart)",
  fill = "var(--chart-fill)",
  grid = "var(--line)",
  pad = 6,
  strokeW = 1.75,
  formatValue = (v: number) => String(Math.round(v)),
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: string;
  grid?: string;
  pad?: number;
  strokeW?: number;
  formatValue?: (v: number) => string;
}) {
  const values = useMemo(() => downsample(data ?? []), [data]);
  return (
    <LinePlot
      values={values}
      interactive={false}
      w={w}
      h={h}
      stroke={stroke}
      fill={fill}
      grid={grid}
      redSoft="none"
      pad={pad}
      strokeW={strokeW}
      formatValue={formatValue}
      formatAxis={formatValue}
      formatDate={defaultDate}
      emptyText="Inte tillräckligt med data än"
    />
  );
}

/**
 * Two cumulative series on a shared time axis — the what-if simulator's
 * "actual vs filtered" comparison. Series are downsampled independently. The
 * reference series is grey and thinner; the scenario is the one in colour.
 */
export function CompareChart({
  a,
  b,
  w = 640,
  h = 210,
  colorA = "var(--dim2)",
  colorB = "var(--chart)",
  grid = "var(--line)",
  pad = 6,
  formatValue = (v: number) => String(Math.round(v)),
}: {
  a: TimePoint[]; // baseline (actual)
  b: TimePoint[]; // scenario (filtered)
  w?: number;
  h?: number;
  colorA?: string;
  colorB?: string;
  grid?: string;
  pad?: number;
  formatValue?: (v: number) => string;
}) {
  const sa = useMemo(() => downsample(a), [a]);
  const sb = useMemo(() => downsample(b), [b]);
  // Bounds in one pass over the combined series (up to 1200 points).
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
    return { y, path, ticks: niceTicks(vMin, vMax) };
  }, [sa, sb, w, h, pad]);

  if (!geom) return <Empty h={h}>Inte tillräckligt med data</Empty>;
  const { y, path, ticks } = geom;
  return (
    <div className="ap-chart">
      <div className="ap-chart-row">
        <div className="ap-chart-plot" style={{ height: h }}>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            width="100%"
            height={h}
            preserveAspectRatio="none"
            role="img"
            aria-label="Jämförelsediagram: verkligt utfall mot scenario"
          >
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                y1={y(t)}
                x2={w}
                y2={y(t)}
                stroke={t === 0 ? "var(--line)" : grid}
                strokeWidth="1"
                strokeDasharray={t === 0 ? undefined : "1 3"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={path(sa)} fill="none" stroke={colorA} strokeWidth="1.25" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {sb.length >= 2 && (
              <path
                d={path(sb)}
                fill="none"
                stroke={colorB}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
        <Axis ticks={ticks} y={y} h={h} format={formatValue} last={sb.length >= 2 ? sb[sb.length - 1].v : undefined} />
      </div>
    </div>
  );
}

/**
 * Result per period as bars off a zero line. Plain HTML: the columns fill the
 * panel's width at any size, and each bar is a real hover target with its value.
 * Green above the line, red below — the direction says it as well as the hue.
 */
export function PLBars({
  data,
  h = 170,
  pos = "var(--pos)",
  neg = "var(--red)",
  formatValue = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}U`,
}: {
  data: { m: string; units: number }[];
  h?: number;
  pos?: string;
  neg?: string;
  formatValue?: (v: number) => string;
}) {
  if (!data || !data.length) return <Empty h={h}>Ingen data</Empty>;
  let maxPos = 0;
  let maxNeg = 0;
  for (const d of data) {
    if (d.units > maxPos) maxPos = d.units;
    if (-d.units > maxNeg) maxNeg = -d.units;
  }
  const span = maxPos + maxNeg || 1;
  const zero = (maxPos / span) * 100; // % from the top of the plot
  return (
    <div
      className="ap-plbars"
      style={{ height: h }}
      role="img"
      aria-label={"Stapeldiagram, resultat per period: " + data.map((d) => `${d.m} ${formatValue(d.units)}`).join(", ")}
    >
      <div className="ap-plbars-plot">
        <i className="ap-plbars-zero" style={{ top: `${zero}%` }} />
        {data.map((d, i) => {
          const size = (Math.abs(d.units) / span) * 100;
          return (
            <div key={i} className="ap-plbar" title={`${d.m}: ${formatValue(d.units)}`}>
              <i
                style={{
                  top: `${d.units >= 0 ? zero - size : zero}%`,
                  height: `max(${size}%, 1px)`,
                  background: d.units >= 0 ? pos : neg,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="ap-plbars-x" aria-hidden="true">
        {data.map((d, i) => (
          <span key={i}>{d.m}</span>
        ))}
      </div>
    </div>
  );
}

export function Donut({
  data,
  size = 150,
  thickness = 22,
  colors,
  track = "var(--card2)",
  centerLabel,
  centerSub,
  centerColor = "var(--txt)",
  centerSubColor = "var(--dim2)",
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
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={[centerLabel, centerSub].filter(Boolean).join(" ") || "Cirkeldiagram"}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={thickness} />
      {data.map((d, i) => {
        // A 2px gap of panel colour between segments (skipped for slivers so
        // they stay visible).
        const len = (d.pct / 100) * circ;
        const g = len > 6 ? 2 : 0;
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
        <text x={c} y={c - 2} textAnchor="middle" fontSize={size * 0.18} fontWeight="500" fill={centerColor} fontFamily="var(--mono)" letterSpacing="-0.02em">
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text x={c} y={c + size * 0.14} textAnchor="middle" fontSize={size * 0.08} fontWeight="600" fill={centerSubColor} fontFamily="var(--disp)" letterSpacing="0.1em">
          {centerSub}
        </text>
      )}
    </svg>
  );
}

// Spark and HBar live in ./miniCharts so that ui.tsx/stats.tsx can pull them in
// without this module. Re-exported here so existing import sites keep working.
export { Spark, HBar } from "./miniCharts";
