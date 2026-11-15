"use client";

import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import { Spark } from "./miniCharts";
import { I, IC, sportIcon } from "./icons";
import type { LucideIcon } from "lucide-react";
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

const CONTROL_TAGS = new Set(["input", "select", "textarea"]);

/**
 * A labelled form field: `.ap-field` wrapper + its `<label>`, wired together so
 * the label is the control's accessible name and clicking it focuses the
 * control. The first native input/select/textarea among the children (also one
 * level down, e.g. inside an `.ap-select` wrapper) is given a generated id —
 * or keeps its own. A field without a native control (segmented buttons, a
 * custom picker) becomes a labelled group instead.
 */
export function Field({
  label,
  children,
  className,
  ...rest
}: { label: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const uid = useId();
  let controlId: string | undefined;

  const bind = (nodes: React.ReactNode, depth: number): React.ReactNode =>
    Children.map(nodes, (child) => {
      if (controlId || !isValidElement<{ id?: string; children?: React.ReactNode }>(child)) return child;
      if (typeof child.type !== "string") return child;
      if (CONTROL_TAGS.has(child.type)) {
        controlId = child.props.id ?? uid;
        return child.props.id ? child : cloneElement(child, { id: controlId });
      }
      if (depth < 2 && child.props.children != null) {
        const bound = bind(child.props.children, depth + 1);
        return controlId ? cloneElement(child, undefined, bound) : child;
      }
      return child;
    });

  const body = bind(children, 0);
  const labelId = uid + "-label";

  return (
    <div
      className={"ap-field" + (className ? " " + className : "")}
      {...(controlId ? {} : { role: "group", "aria-labelledby": labelId })}
      {...rest}
    >
      <label id={labelId} htmlFor={controlId}>
        {label}
      </label>
      {body}
    </div>
  );
}

/** Small "?" beside a label; the explanation shows on hover or focus. */
export function Hint({ children, size = 12 }: { children: React.ReactNode; size?: number }) {
  return (
    <span className="ap-tip" tabIndex={0} role="note">
      <I p={IC.helpCircle} size={size} />
      <span className="ap-tip-body">{children}</span>
    </span>
  );
}

/**
 * KPI cell: micro-label (+ optional hint) on top, the figure in monospace
 * below, and a footer with a trend and a secondary figure. Cells sit in a ruled
 * strip (.ap-kpi-row / .ap-kpi-grid). The figure is neutral unless `tone` says
 * its sign means something — colour is never decoration here.
 */
export function Kpi({
  label,
  value,
  delta,
  deltaPos,
  spark,
  valueClass,
  tone,
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
  /** Explanation shown on hover next to the label. */
  hint?: React.ReactNode;
  /** Footer-left text, e.g. "2 vinster i rad". */
  trend?: React.ReactNode;
  trendTone?: "pos" | "neg" | "flat";
  /** Footer-right secondary figure. */
  meta?: React.ReactNode;
}) {
  const { cc } = useTheme();
  const valueTone = tone === "pos" ? "t-pos " : tone === "neg" ? "t-red " : "";
  const hasSpark = !!spark && spark.length > 1;

  return (
    <div className="ap-card ap-kpi">
      <div className="ap-kpi-head">
        <span className="ap-label">
          {label}
          {hint && <Hint>{hint}</Hint>}
        </span>
        {delta && !hasSpark ? <span className={"ap-pill " + (deltaPos ? "pos" : "neg")}>{delta}</span> : null}
      </div>

      {hasSpark && (
        <span className="ap-kpi-spark" aria-hidden="true">
          <Spark data={spark!} w={64} h={18} stroke={tone === "neg" ? cc.red : tone === "pos" ? cc.pos : cc.acc} />
        </span>
      )}

      <div className={"ap-num ap-kpi-val " + valueTone + (valueClass || "")}>{value}</div>

      {(trend || meta) && (
        <div className="ap-kpi-foot">
          {trend && (
            <span className={"ap-kpi-trend " + (trendTone ?? "flat")}>
              {trendTone === "pos" && <I p={IC.trendUp} size={12} />}
              {trendTone === "neg" && <I p={IC.trendDown} size={12} />}
              {trend}
            </span>
          )}
          {meta && <span className="ap-kpi-meta">{meta}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Title row *inside* a padded panel: title + subtitle on the left, controls on
 * the right. Wraps on narrow screens so the controls drop under the title.
 * (A padding-less panel uses the .ap-card-head strip instead.)
 */
export function PanelHead({
  title,
  sub,
  hint,
  actions,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ap-panel-head">
      <div className="ap-panel-head-main">
        <h2 className="ap-panel-head-title">
          {title}
          {hint && <Hint size={13}>{hint}</Hint>}
        </h2>
        {sub && <div className="ap-panel-head-sub">{sub}</div>}
      </div>
      {actions && <div className="ap-panel-head-actions">{actions}</div>}
    </div>
  );
}

/**
 * Sport glyph followed by a label. Pass the *raw* sport name — the glyph is
 * derived from it. Neutral on purpose: a sport is told apart by its glyph and
 * tag, not by a hue of its own. The label defaults to the short tag (sportTag)
 * because the table's sport column is narrow; pass `long` where there is room.
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
  return (
    <span className="ap-sport" title={sport || undefined}>
      {showIcon ? (
        <span className="ap-sport-ico" aria-hidden="true">
          <I p={sportIcon(sport)} size={14} />
        </span>
      ) : (
        <span className="ap-sport-dot" aria-hidden="true" />
      )}
      <span className="ap-ell">{long ? sport || "—" : sportTag(sport)}</span>
    </span>
  );
}

/** Rule between groups of panels: title on the left, a note on the right.
 *  `id` makes it a target for the page's anchor tabs. */
export function SectionHead({
  title,
  sub,
  id,
}: {
  title: string;
  sub?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="ap-sec" id={id}>
      <h2 className="ap-sec-title">{title}</h2>
      {sub && <div className="ap-sec-sub">{sub}</div>}
    </div>
  );
}

/** Pulsing placeholder block while data loads. */
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
      <Skeleton w={130} h={22} style={{ marginTop: 10 }} />
      {chartH != null && <Skeleton h={chartH} style={{ marginTop: 14 }} />}
    </div>
  );
}

/** Empty state: optional icon, a title line and a dim hint line. */
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
      {icon && <div className="ap-empty-icon" aria-hidden="true"><I p={icon} size={20} /></div>}
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
