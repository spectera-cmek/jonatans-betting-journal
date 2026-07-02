"use client";

// "Läckor & Edge": where money leaks and where the edge is, computed live from
// the full bet history via lib/edge (never hardcoded). Sits on the Insikter page.

import { useMemo } from "react";
import { Card } from "./ui";
import { HBar } from "./charts";
import { useTheme } from "./ThemeProvider";
import { computeEdgeSegments, type EdgeSegment } from "@/lib/edge";
import { krFmt, krShort, pctFmt } from "@/lib/format";
import type { BetListDTO } from "@/lib/types";
import type { ChartColors } from "@/lib/theme";

function SegmentRows({
  segments,
  unit,
  max,
  color,
  cc,
}: {
  segments: EdgeSegment[];
  unit: number;
  max: number;
  color: string;
  cc: ChartColors;
}) {
  if (segments.length === 0) {
    return <span style={{ color: "var(--dim2)", fontSize: 13 }}>Inget segment kvalificerar sig ännu.</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      {segments.map((s) => (
        <div key={`${s.dim}:${s.key}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: 13, marginBottom: 6 }}>
            <span style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 7 }}>
              <span className="ap-tag" style={{ flexShrink: 0 }}>{s.dim}</span>
              <span className="ap-ell">
                {s.key} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {s.settled} bets</span>
              </span>
            </span>
            <span className="ap-num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              <em className={s.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>
                {krShort(s.profitUnits * unit, true)}
              </em>
              <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{pctFmt(s.roiPct, true)}</span>
            </span>
          </div>
          <HBar pct={Math.max((Math.abs(s.profitUnits) / max) * 100, 3)} color={color} track={cc.grid} h={7} />
        </div>
      ))}
    </div>
  );
}

export function EdgePanel({ bets, unit }: { bets: BetListDTO[]; unit: number }) {
  const { cc } = useTheme();
  const seg = useMemo(() => computeEdgeSegments(bets), [bets]);
  if (seg.leaks.length === 0 && seg.edges.length === 0) return null;
  const max = Math.max(1, ...[...seg.leaks, ...seg.edges].map((s) => Math.abs(s.profitUnits)));

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Läckor &amp; Edge</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>beräknat live ur hela historiken</span>
      </div>

      <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16, gap: 22 }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span className="neg" style={{ fontWeight: 700, fontSize: 13.5 }}>Läckor</span>
            <span style={{ fontSize: 12, color: "var(--dim2)" }}>
              har kostat <b className="ap-num neg">{krFmt(Math.abs(seg.leakUnits) * unit)}</b>
            </span>
          </div>
          <SegmentRows segments={seg.leaks} unit={unit} max={max} color={cc.red} cc={cc} />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span className="pos" style={{ fontWeight: 700, fontSize: 13.5 }}>Edges</span>
            <span style={{ fontSize: 12, color: "var(--dim2)" }}>
              har gett <b className="ap-num pos">{krFmt(seg.edgeUnits * unit, true)}</b>
            </span>
          </div>
          <SegmentRows segments={seg.edges} unit={unit} max={max} color={cc.pos} cc={cc} />
        </div>
      </div>

      <p style={{ fontSize: 11.5, color: "var(--dim2)", lineHeight: 1.55, marginTop: 16, marginBottom: 0 }}>
        Segment över marknad, oddsspann, singel/ack och insatsstorlek med minst {seg.minSettled} avgjorda spel.
        Odds-platshållare (1.01) är exkluderade ur oddsspannen. Testa reglerna i simulatorn längre ner.
      </p>
    </Card>
  );
}
