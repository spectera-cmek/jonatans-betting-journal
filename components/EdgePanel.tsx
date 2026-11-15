"use client";

// "Läckor & Edge": where money leaks and where the edge is, computed live from
// the bet history via lib/edge (never hardcoded).
//
// The history spans more than one era. Read over all of it, a segment that has
// been printing money for the last six months still shows as a leak because of
// how it went two years ago — so every row carries both the selected window and
// the all-time number, and says so when the two disagree.

import { useMemo } from "react";
import { Card } from "./ui";
import { HBar } from "./miniCharts";
import { useTheme } from "./ThemeProvider";
import { computeEdgeSegments, type EdgeSegment } from "@/lib/edge";
import { filterByPeriod, minSettledFor } from "@/lib/periods";
import { krFmt, krShort, pctFmt } from "@/lib/format";
import type { BetListDTO } from "@/lib/types";
import type { ChartColors } from "@/lib/theme";

/** All-time ROI for the same segment, keyed by dimension + segment name. */
type Baseline = Map<string, EdgeSegment>;

function baselineKey(s: { dim: string; key: string }): string {
  return `${s.dim}:${s.key}`;
}

function SegmentRows({
  segments,
  unit,
  max,
  color,
  cc,
  baseline,
  showBaseline,
}: {
  segments: EdgeSegment[];
  unit: number;
  max: number;
  color: string;
  cc: ChartColors;
  baseline: Baseline;
  /** Off when the selected window *is* the whole history. */
  showBaseline: boolean;
}) {
  if (segments.length === 0) {
    return <span style={{ color: "var(--dim2)", fontSize: "var(--fs-md)" }}>Inget segment kvalificerar sig ännu.</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {segments.map((s) => {
        const all = showBaseline ? baseline.get(baselineKey(s)) : undefined;
        // A sign flip between the window and the whole history is the thing
        // worth noticing: it means the old verdict no longer holds.
        const flipped = all != null && Math.sign(all.profitUnits) !== Math.sign(s.profitUnits);
        return (
          <div key={baselineKey(s)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: "var(--fs-md)", marginBottom: 6 }}>
              <span style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 7 }}>
                <span className="ap-tag" style={{ flexShrink: 0 }}>{s.dim}</span>
                <span className="ap-ell">
                  {s.key} <span style={{ color: "var(--dim2)", fontSize: "var(--fs-sm)" }}>· {s.settled} bets</span>
                </span>
              </span>
              <span className="ap-num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                <em className={s.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>
                  {krShort(s.profitUnits * unit, true)}
                </em>
                <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{pctFmt(s.roiPct, true)}</span>
              </span>
            </div>
            <HBar pct={Math.max((Math.abs(s.profitUnits) / max) * 100, 3)} color={color} track={cc.grid} h={3} />
            {showBaseline && (
              <div style={{ fontSize: "var(--fs-xs)", color: "var(--dim2)", marginTop: 5 }}>
                {all ? (
                  <>
                    Hela historiken:{" "}
                    <span className={all.profitUnits >= 0 ? "pos" : "neg"}>{pctFmt(all.roiPct, true)}</span> över{" "}
                    {all.settled.toLocaleString("sv-SE")} avgjorda
                    {flipped && (
                      <b style={{ color: "var(--acc-ink)" }}> · har vänt</b>
                    )}
                  </>
                ) : (
                  <>För få avgjorda i hela historiken för en jämförelse.</>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function EdgePanel({
  bets,
  unit,
  days,
  periodLabel,
}: {
  bets: BetListDTO[];
  unit: number;
  /** Trailing window in days; null = the whole history. */
  days: number | null;
  periodLabel: string;
}) {
  const { cc } = useTheme();
  const minSettled = minSettledFor(days);
  const windowBets = useMemo(() => filterByPeriod(bets, days), [bets, days]);
  const seg = useMemo(() => computeEdgeSegments(windowBets, minSettled), [windowBets, minSettled]);
  // All-time baseline at the same floor, so a row's comparison is like for like.
  const baseline = useMemo<Baseline>(() => {
    if (!days) return new Map();
    const all = computeEdgeSegments(bets, minSettled);
    return new Map([...all.leaks, ...all.edges].map((s) => [baselineKey(s), s]));
  }, [bets, days, minSettled]);

  if (seg.leaks.length === 0 && seg.edges.length === 0) {
    return (
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <span className="ap-label">Läckor &amp; Edge</span>
          <span style={{ color: "var(--dim2)", fontSize: "var(--fs-sm)" }}>{periodLabel.toLowerCase()}</span>
        </div>
        <p style={{ fontSize: "var(--fs-md)", color: "var(--dim2)", marginTop: 14, marginBottom: 0, lineHeight: 1.55 }}>
          Inget segment når {minSettled} avgjorda spel inom {periodLabel.toLowerCase()}. Välj en längre period.
        </p>
      </Card>
    );
  }

  const max = Math.max(1, ...[...seg.leaks, ...seg.edges].map((s) => Math.abs(s.profitUnits)));

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Läckor &amp; Edge</span>
        <span style={{ color: "var(--dim2)", fontSize: "var(--fs-sm)" }}>
          {days ? `beräknat live · ${periodLabel.toLowerCase()}` : "beräknat live ur hela historiken"}
        </span>
      </div>

      <div className="ap-split" style={{ marginTop: 12 }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span className="neg" style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>Läckor</span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)" }}>
              har kostat <b className="ap-num neg">{krFmt(Math.abs(seg.leakUnits) * unit)}</b>
            </span>
          </div>
          <SegmentRows segments={seg.leaks} unit={unit} max={max} color={cc.red} cc={cc} baseline={baseline} showBaseline={!!days} />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span className="pos" style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>Edges</span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)" }}>
              har gett <b className="ap-num pos">{krFmt(seg.edgeUnits * unit, true)}</b>
            </span>
          </div>
          <SegmentRows segments={seg.edges} unit={unit} max={max} color={cc.pos} cc={cc} baseline={baseline} showBaseline={!!days} />
        </div>
      </div>

      <p style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)", lineHeight: 1.55, marginTop: 16, marginBottom: 0 }}>
        Segment över marknad, oddsspann, singel/ack och insatsstorlek med minst {seg.minSettled} avgjorda spel
        {days ? ` inom ${periodLabel.toLowerCase()}` : ""}. Odds-platshållare (1.01) är exkluderade ur oddsspannen.
        Testa reglerna i simulatorn längre ner.
      </p>
    </Card>
  );
}
