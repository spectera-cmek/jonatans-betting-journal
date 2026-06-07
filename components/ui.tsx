"use client";

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
}: {
  label: string;
  value: string;
  delta?: string;
  deltaPos?: boolean;
  spark?: number[];
  valueClass?: string;
}) {
  const { cc } = useTheme();
  return (
    <div className="ap-card">
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
