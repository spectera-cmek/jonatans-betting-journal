"use client";

import Link from "next/link";
import { Card } from "./ui";
import { HBar } from "./charts";
import { useTheme } from "./ThemeProvider";
import { krFmt, krShort } from "@/lib/format";
import type { OpenRisk, OpenRiskGroup } from "@/lib/betting";

const TOP_N = 4;

export function OpenRiskCard({
  risk,
  groups,
  unit,
  href,
}: {
  risk: OpenRisk;
  groups: OpenRiskGroup[];
  unit: number;
  href: string;
}) {
  const { cc } = useTheme();

  if (!risk || risk.bets === 0) {
    return (
      <Card>
        <span className="ap-label">Öppen risk</span>
        <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 10 }}>Inga öppna bets just nu.</div>
      </Card>
    );
  }

  const top = groups.slice(0, TOP_N);
  const rest = groups.slice(TOP_N);
  const restStake = rest.reduce((a, g) => a + g.stakeUnits, 0);
  const restBets = rest.reduce((a, g) => a + g.bets, 0);
  const max = Math.max(1, ...top.map((g) => g.stakeUnits));

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div>
          <span className="ap-label">Öppen risk</span>
          <div className="ap-num" style={{ fontSize: 26, fontWeight: 600, marginTop: 6 }}>{krFmt(risk.stakeUnits * unit)}</div>
          <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>
            {risk.bets} öppna bets · möjlig retur <span className="pos" style={{ fontWeight: 600 }}>{krFmt(risk.potentialReturnUnits * unit)}</span>
          </div>
        </div>
        <Link href={href} className="ap-link">Visa alla öppna →</Link>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
        {top.map((g) => (
          <div key={g.key}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span>{g.key} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {g.bets} bets</span></span>
              <span className="ap-num" style={{ fontWeight: 600 }}>{krShort(g.stakeUnits * unit)}</span>
            </div>
            <HBar pct={Math.max((g.stakeUnits / max) * 100, 3)} color={cc.acc} track={cc.grid} h={7} />
          </div>
        ))}
        {rest.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--dim)", paddingTop: 2 }}>
            <span>+{rest.length} till <span style={{ color: "var(--dim2)" }}>· {restBets} bets</span></span>
            <span className="ap-num">{krShort(restStake * unit)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
