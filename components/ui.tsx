"use client";

import { useEffect, useRef, useState } from "react";
import { Spark } from "./charts";
import { I, IC, sportIcon } from "./icons";
import type { LucideIcon } from "lucide-react";
import { sportColor } from "@/lib/theme";
import { sportTag } from "@/lib/format";
import { useTheme } from "./ThemeProvider";

export function Card({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={"ap-card " + className} style={style}>
      {children}
    </div>
  );
}

/** One of the six per-metric hues. Drives both the icon chip and the hero
 *  number, so a card reads as a single coloured unit. */
export type Accent = "emerald" | "sky" | "amber" | "purple" | "teal" | "pink" | "pos" | "red";

const ACCENT_HEX: Record<Accent, string> = {
  emerald: "#10b981",
  sky: "#0ea5e9",
  amber: "#f59e0b",
  purple: "#a855f7",
  teal: "#14b8a6",
  pink: "#ec4899",
  pos: "#34d399",
  red: "#f43f5e",
};

/**
 * KPI card: micro-label (+ optional hint) and a tinted icon chip on top, the
 * hero number in monospace below, and a footer with a trend and a secondary
 * figure. Every part except label/value is optional, so the same component
 * covers both the dense strips and the six-across dashboard row.
 */
export function Kpi({
  label,
  value,
  delta,
  deltaPos,
  spark,
  valueClass,
  tone,
  accent,
  icon,
  hint,
  trend,
  trendTone,
  meta,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  deltaPos?: boolean;
  spark?: number[];
  valueClass?: string;
  tone?: "pos" | "neg";
  /** Per-metric hue for the icon chip, hero number and sparkline. */
  accent?: Accent;
  /** Line icon rendered inside the chip (from IC). */
  icon?: LucideIcon;
  /** Explanation shown on hover next to the label. */
  hint?: React.ReactNode;
  /** Footer-left text, e.g. "+12,4 % mot förra perioden". */
  trend?: React.ReactNode;
  trendTone?: "pos" | "neg" | "flat";
  /** Footer-right secondary figure. */
  meta?: React.ReactNode;
}) {
  const { cc } = useTheme();
  // An explicit tone (win/loss colouring) wins over the decorative accent.
  const valueTone = tone === "pos" ? "pos" : tone === "neg" ? "red" : accent;
  const sparkStroke = accent ? ACCENT_HEX[accent] : cc.acc;

  return (
    <div className={"ap-card ap-kpi" + (tone ? ` is-${tone}` : "")}>
      <div className="ap-kpi-head">
        <span className="ap-label">
          {label}
          {hint && (
            <span className="ap-tip" tabIndex={0} role="note">
              <I p={IC.helpCircle} size={12} />
              <span className="ap-tip-body">{hint}</span>
            </span>
          )}
        </span>
        {icon ? (
          <span className={"ap-chip-icon" + (accent ? ` is-${accent}` : "")} aria-hidden="true">
            <I p={icon} size={16} />
          </span>
        ) : delta ? (
          <span className={"ap-pill " + (deltaPos ? "pos" : "neg")}>{delta}</span>
        ) : null}
      </div>

      <div className={"ap-num ap-kpi-val " + (valueTone ? `t-${valueTone} ` : "") + (valueClass || "")}>
        {value}
      </div>

      {spark && spark.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <Spark data={spark} w={150} h={26} stroke={sparkStroke} />
        </div>
      )}

      {(trend || meta || (icon && delta)) && (
        <div className="ap-kpi-foot">
          <span className={"ap-kpi-trend " + (trendTone ?? "flat")}>
            {trendTone === "pos" && <I p={IC.trendUp} size={13} />}
            {trendTone === "neg" && <I p={IC.trendDown} size={13} />}
            {trend ?? (icon && delta ? delta : null)}
          </span>
          {meta && <span className="ap-kpi-meta">{meta}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Panel header used *inside* a card: tinted icon chip + title + subtitle on the
 * left, controls (segmented toggles, links) on the right. Wraps on narrow
 * screens so the controls drop under the title instead of squeezing it.
 */
export function PanelHead({
  icon,
  accent,
  title,
  sub,
  hint,
  actions,
}: {
  icon?: LucideIcon;
  accent?: Accent;
  title: React.ReactNode;
  sub?: React.ReactNode;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ap-panel-head">
      <div className="ap-panel-head-main">
        {icon && (
          <span className={"ap-chip-icon" + (accent ? ` is-${accent}` : "")} aria-hidden="true">
            <I p={icon} size={16} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="ap-panel-head-title">
            {title}
            {hint && (
              <span className="ap-tip" tabIndex={0} role="note" style={{ marginLeft: 6 }}>
                <I p={IC.helpCircle} size={13} />
                <span className="ap-tip-body">{hint}</span>
              </span>
            )}
          </div>
          {sub && <div className="ap-panel-head-sub">{sub}</div>}
        </div>
      </div>
      {actions && <div className="ap-panel-head-actions">{actions}</div>}
    </div>
  );
}

/**
 * Sport glyph in the sport's colour, followed by a label. Pass the *raw* sport
 * name — colour and glyph are derived from it. The label defaults to the short
 * tag (sportTag) because the table's sport column is only ~46px wide; pass
 * `long` where there is room for the full name.
 */
export function SportMark({
  sport,
  long = false,
  showIcon = true,
}: {
  sport?: string | null;
  long?: boolean;
  showIcon?: boolean;
}) {
  const color = sportColor(sport);
  return (
    <span className="ap-sport" title={sport || undefined}>
      {showIcon ? (
        <span className="ap-sport-ico" style={{ color }} aria-hidden="true">
          <I p={sportIcon(sport)} size={14} />
        </span>
      ) : (
        <span className="ap-sport-dot" style={{ background: color }} aria-hidden="true" />
      )}
      <span className="ap-ell">{long ? sport || "—" : sportTag(sport)}</span>
    </span>
  );
}

/** Section header between card groups: icon chip + title, optional right-aligned sub. */
export function SectionHead({
  icon,
  title,
  sub,
}: {
  icon?: LucideIcon;
  title: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="ap-sec">
      {icon && (
        <div className="ap-sec-icon" aria-hidden="true">
          <I p={icon} size={15} />
        </div>
      )}
      <div className="ap-sec-title">{title}</div>
      {sub && <div className="ap-sec-sub">{sub}</div>}
    </div>
  );
}

/** Shimmering placeholder block while data loads. */
export function Skeleton({
  w,
  h = 14,
  style,
}: {
  w?: number | string;
  h?: number | string;
  style?: React.CSSProperties;
}) {
  return <div className="ap-skel" style={{ width: w ?? "100%", height: h, ...style }} aria-hidden="true" />;
}

/** A card-shaped skeleton: label line + value line (+ optional chart block). */
export function SkeletonCard({ chartH }: { chartH?: number }) {
  return (
    <div className="ap-card">
      <Skeleton w={90} h={10} />
      <Skeleton w={130} h={24} style={{ marginTop: 14 }} />
      {chartH != null && <Skeleton h={chartH} style={{ marginTop: 14 }} />}
    </div>
  );
}

/** Polished empty state: optional icon, a title line and a dim hint line. */
export function Empty({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: React.ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="ap-empty">
      {icon && <div className="ap-empty-icon" aria-hidden="true"><I p={icon} size={22} /></div>}
      <div className="ap-empty-title">{title}</div>
      {hint && <div className="ap-empty-hint">{hint}</div>}
    </div>
  );
}

/**
 * Animates a number change with an ease-out count-up (~0.65 s). The formatter
 * runs on every frame, so pass one that rounds (krFmt/uFmt/pctFmt all do).
 */
export function CountUp({
  value,
  format,
  duration = 650,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
}) {
  // Starts at 0 so the very first data render gets the count-up too.
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = value;
    if (from === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(from + (value - from) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{format(shown)}</>;
}
