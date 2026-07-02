"use client";

import { useEffect, useRef, useState } from "react";
import { Spark } from "./charts";
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

export function Kpi({
  label,
  value,
  delta,
  deltaPos,
  spark,
  valueClass,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  deltaPos?: boolean;
  spark?: number[];
  valueClass?: string;
  tone?: "pos" | "neg";
}) {
  const { cc } = useTheme();
  return (
    <div className={"ap-card ap-lift ap-kpi" + (tone ? ` is-${tone}` : "")}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span className="ap-label">{label}</span>
        {delta && <span className={"ap-pill " + (deltaPos ? "pos" : "neg")}>{delta}</span>}
      </div>
      <div className={"ap-num ap-kpi-val " + (valueClass || "")}>{value}</div>
      {spark && spark.length > 1 && (
        <div style={{ marginTop: 8 }}>
          <Spark data={spark} w={150} h={26} stroke={cc.acc} />
        </div>
      )}
    </div>
  );
}

/** Section header between card groups: icon chip + title, optional right-aligned sub. */
export function SectionHead({
  icon,
  title,
  sub,
}: {
  icon?: React.ReactNode;
  title: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="ap-sec">
      {icon && (
        <div className="ap-sec-icon" aria-hidden="true">
          {icon}
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
  icon?: React.ReactNode;
}) {
  return (
    <div className="ap-empty">
      {icon && <div className="ap-empty-icon" aria-hidden="true">{icon}</div>}
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
