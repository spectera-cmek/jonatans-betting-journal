"use client";

import { useState } from "react";
import { Card } from "./ui";
import { MiniStat } from "./stats";
import { bonusValue } from "@/lib/tools";
import { krFmt, pctFmt } from "@/lib/format";

const num = (v: string) => parseFloat(v.replace(",", "."));

// Bonusvärdering (bettingskolan kap. 3): omsättningskravet gör att du matar
// bookiens marginal en gång per omsatt krona — det är bonusens verkliga pris.
export function BonusCard() {
  const [bonus, setBonus] = useState("500");
  const [wager, setWager] = useState("8");
  const [margin, setMargin] = useState("6");

  const b = bonusValue(num(bonus), num(wager), num(margin));

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span className="ap-label">Bonusvärdering</span>
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Vad är bonusen värd efter omsättningskravet?</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
        <div className="ap-field" style={{ width: 110 }}>
          <label>Bonus (kr)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={bonus} onChange={(e) => setBonus(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 150 }}>
          <label>Omsättningskrav (ggr)</label>
          <input className="ap-input ap-num" inputMode="decimal" value={wager} onChange={(e) => setWager(e.target.value)} />
        </div>
        <div className="ap-field" style={{ width: 150 }}>
          <label>Marginal per spel %</label>
          <input className="ap-input ap-num" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />
        </div>
      </div>

      {b == null ? (
        <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>
          Fyll i bonusbelopp, omsättningskrav och antagen marginal.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 14 }}>
            <MiniStat label="Total omsättning" value={krFmt(b.turnover)} />
            <MiniStat label="Förväntad kostnad" value={krFmt(b.expectedCost)} tone="neg" />
            <MiniStat label="Bonusens nettovärde" value={krFmt(b.netValue, true)} tone={b.netValue >= 0 ? "pos" : "neg"} />
            <MiniStat label="Du behåller" value={pctFmt(b.retained * 100)} tone={b.retained >= 0 ? undefined : "neg"} />
          </div>
          <div className={"ap-num " + (b.netValue > 0 ? "pos" : "neg")} style={{ marginTop: 14, fontSize: 14, fontWeight: 700 }}>
            {b.netValue > 0 ? `✓ Ta bonusen · ${krFmt(b.netValue, true)}` : `✗ Tacka nej · ${krFmt(b.netValue, true)}`}
          </div>
        </>
      )}

      <details className="ap-fine">
        <summary>Bra att veta</summary>
        Minimioddset påverkar inte väntevärdet — bara svängningarna. Det som avgör är marginalen på det du omsätter:
        välj låg-marginalmarknader (asian handicap, över/under ~5 %) hellre än 1X2 (~6–7 %) eller specialer (10 %+).
        Kolla alltid omsättningskrav, minimiodds och tidsram i det finstilta. Svensk licens = en bonus per bolag.
      </details>
    </Card>
  );
}
