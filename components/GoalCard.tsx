"use client";

import { useEffect, useState } from "react";
import { Card, Field } from "./ui";
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
    <Card>
      <div className="ap-panel-head">
        <h2 className="ap-card-title">Mål &amp; tempo</h2>
        {hasGoals && !editing && (
          <button className="ap-link" onClick={() => setEditing(true)}>Ändra mål</button>
        )}
      </div>

      {editing || !hasGoals ? (
        !hasGoals && !editing ? (
          <div className="ap-goal-empty">
            <span className="ap-note">Sätt ett vinstmål i units så ser du progress och om du ligger i fas.</span>
            <button className="ap-btn ghost" onClick={() => setEditing(true)}>
              <I p={IC.plus} size={14} /> Sätt mål
            </button>
          </div>
        ) : (
          <div className="ap-goal-form">
            <div className="ap-x2">
              <Field label="Månadsmål (U)">
                <input className="ap-input ap-num" inputMode="decimal" placeholder="t.ex. 20" value={mInput} onChange={(e) => setMInput(e.target.value)} />
              </Field>
              <Field label="Årsmål (U)">
                <input className="ap-input ap-num" inputMode="decimal" placeholder="t.ex. 200" value={yInput} onChange={(e) => setYInput(e.target.value)} />
              </Field>
            </div>
            <div className="ap-row">
              <button className="ap-btn" onClick={save}>Spara mål</button>
              {hasGoals && <button className="ap-btn ghost" onClick={() => setEditing(false)}>Avbryt</button>}
            </div>
            <span className="ap-note">Tomt fält stänger av målet. Sparas lokalt i den här webbläsaren.</span>
          </div>
        )
      ) : (
        <div className="ap-goal-rows">
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
    <div className="ap-meter">
      <div className="ap-meter-head">
        <span>{label}</span>
        <span className="ap-num">
          <em className={prog.profitUnits >= 0 ? "pos" : "neg"}>{uFmt(prog.profitUnits, true)}</em>
          <small> / {uFmt(prog.goalUnits)}</small>
        </span>
      </div>
      <div className="ap-meter-track">
        <i style={{ width: `${pct}%`, background: barColor }} />
      </div>
      <div className="ap-meter-foot">
        <span>{Math.round(prog.pct)}% av målet · {krShort(prog.profitUnits * unit, true)}</span>
        <span>
          I nuvarande takt:{" "}
          <em className={prog.onTrack ? "pos" : "neg"}>{uFmt(prog.projectedUnits, true)}</em>{" "}
          {prog.onTrack ? "✓ i fas" : "· under mål"}
        </span>
      </div>
    </div>
  );
}
