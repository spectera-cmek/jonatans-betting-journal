"use client";

import { useEffect, useState } from "react";
import { Card } from "./ui";
import { I, IC } from "./icons";
import { uFmt, krShort } from "@/lib/format";
import {
  goalProgress,
  monthElapsedFraction,
  yearElapsedFraction,
  type GoalProgress,
} from "@/lib/goals";

// Goals are personal targets kept client-side (like the theme prefs) — no DB
// schema change, so nothing here can break the server.
const LS_MONTH = "vigg.goal.monthU";
const LS_YEAR = "vigg.goal.yearU";

function readGoal(key: string): number {
  if (typeof window === "undefined") return 0;
  const v = Number(window.localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function GoalCard({
  monthProfitUnits,
  yearProfitUnits,
  unit,
}: {
  monthProfitUnits: number;
  yearProfitUnits: number;
  unit: number;
}) {
  const [monthGoal, setMonthGoal] = useState(0);
  const [yearGoal, setYearGoal] = useState(0);
  const [editing, setEditing] = useState(false);
  const [mInput, setMInput] = useState("");
  const [yInput, setYInput] = useState("");

  useEffect(() => {
    const mg = readGoal(LS_MONTH);
    const yg = readGoal(LS_YEAR);
    setMonthGoal(mg);
    setYearGoal(yg);
    setMInput(mg ? String(mg) : "");
    setYInput(yg ? String(yg) : "");
  }, []);

  const save = () => {
    const mg = Number(mInput.replace(",", ".")) > 0 ? Number(mInput.replace(",", ".")) : 0;
    const yg = Number(yInput.replace(",", ".")) > 0 ? Number(yInput.replace(",", ".")) : 0;
    if (typeof window !== "undefined") {
      mg ? localStorage.setItem(LS_MONTH, String(mg)) : localStorage.removeItem(LS_MONTH);
      yg ? localStorage.setItem(LS_YEAR, String(yg)) : localStorage.removeItem(LS_YEAR);
    }
    setMonthGoal(mg);
    setYearGoal(yg);
    setEditing(false);
  };

  const hasGoals = monthGoal > 0 || yearGoal > 0;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="ap-label">Mål &amp; tempo</span>
        {hasGoals && !editing && (
          <button className="ap-link" onClick={() => setEditing(true)}>Ändra mål</button>
        )}
      </div>

      {editing || !hasGoals ? (
        <div style={{ marginTop: 14 }}>
          {!hasGoals && !editing ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "var(--dim)" }}>
                Sätt ett vinstmål i units så ser du progress och om du ligger i fas.
              </span>
              <button className="ap-btn" onClick={() => setEditing(true)}>
                <I p={IC.plus} size={15} /> Sätt mål
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="ap-x2">
                <div className="ap-field">
                  <label>Månadsmål (U)</label>
                  <input className="ap-input ap-num" inputMode="decimal" placeholder="t.ex. 20" value={mInput} onChange={(e) => setMInput(e.target.value)} />
                </div>
                <div className="ap-field">
                  <label>Årsmål (U)</label>
                  <input className="ap-input ap-num" inputMode="decimal" placeholder="t.ex. 200" value={yInput} onChange={(e) => setYInput(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="ap-btn" onClick={save}>Spara mål</button>
                {hasGoals && <button className="ap-btn ghost" onClick={() => setEditing(false)}>Avbryt</button>}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>
                Tomt fält stänger av målet. Sparas lokalt i den här webbläsaren.
              </span>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
          {monthGoal > 0 && (
            <GoalRow
              label="Den här månaden"
              prog={goalProgress(monthGoal, monthProfitUnits, monthElapsedFraction())}
              unit={unit}
            />
          )}
          {yearGoal > 0 && (
            <GoalRow
              label="I år"
              prog={goalProgress(yearGoal, yearProfitUnits, yearElapsedFraction())}
              unit={unit}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function GoalRow({ label, prog, unit }: { label: string; prog: GoalProgress; unit: number }) {
  const pct = Math.max(0, Math.min(100, prog.pct));
  const reached = prog.profitUnits >= prog.goalUnits;
  const barColor = reached ? "var(--pos)" : prog.profitUnits >= 0 ? "var(--acc)" : "var(--red)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 13, marginBottom: 7 }}>
        <span style={{ color: "var(--dim)" }}>{label}</span>
        <span className="ap-num" style={{ fontWeight: 600 }}>
          <em className={prog.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{uFmt(prog.profitUnits, true)}</em>
          <span style={{ color: "var(--dim2)" }}> / {uFmt(prog.goalUnits)}</span>
        </span>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 20, background: "var(--card2)", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: barColor, borderRadius: 20, transition: "width 0.4s ease" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--dim2)", marginTop: 6 }}>
        <span>{Math.round(prog.pct)}% av målet · {krShort(prog.profitUnits * unit, true)}</span>
        <span>
          I nuvarande takt:{" "}
          <em className={prog.onTrack ? "pos" : "neg"} style={{ fontStyle: "normal", fontWeight: 600 }}>
            {uFmt(prog.projectedUnits, true)}
          </em>{" "}
          {prog.onTrack ? "✓ i fas" : "· under mål"}
        </span>
      </div>
    </div>
  );
}
