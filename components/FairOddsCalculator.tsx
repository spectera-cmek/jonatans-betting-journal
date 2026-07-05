"use client";

import { useMemo, useRef, useState } from "react";
import { Card } from "./ui";
import { InlineStat, MiniStat } from "./stats";
import { kellyAdvice } from "@/lib/staking";
import {
  DEFAULT_ONE_SIDED_MARGIN_PCT,
  MAX_LEGS,
  RHO_MAX,
  RHO_MIN,
  combineLegs,
  devigOneSided,
  devigPoissonGoals,
  devigProportional,
  matchKeyOf,
  priceEdge,
  type ComboMode,
  type DevigResult,
  type FairLeg,
} from "@/lib/fairOdds";
import { fmtOdds, krFmt, pctFmt, uFmt } from "@/lib/format";

interface LegState {
  id: number;
  desc: string; // display only, e.g. "Över 5,5 mål"
  match: string; // correlation grouping via matchKeyOf()
  mode: "two" | "one" | "goals";
  odds: string; // my side / goals: player A anytime odds
  oppOdds: string; // two-way: opposing side
  thirdOdds: string; // two-way: optional 3rd outcome (1X2)
  marginPct: string; // one-sided & goals: assumed market margin
  oddsB: string; // goals: optional player B anytime odds
  line: string; // goals: combined-goals threshold, "1" = Ö0.5, "2" = Ö1.5, "3" = Ö2.5
  etPct: string; // goals: extra-time boost when the special includes ET
}

function emptyLeg(id: number): LegState {
  return {
    id,
    desc: "",
    match: "",
    mode: "two",
    odds: "",
    oppOdds: "",
    thirdOdds: "",
    marginPct: String(DEFAULT_ONE_SIDED_MARGIN_PCT),
    oddsB: "",
    line: "2",
    etPct: "0",
  };
}

const num = (v: string) => parseFloat(v.replace(",", "."));

function legResult(l: LegState): DevigResult | null {
  const o = num(l.odds);
  if (l.mode === "one") return devigOneSided(o, num(l.marginPct));
  if (l.mode === "goals") {
    const players = l.oddsB.trim() === "" ? [o] : [o, num(l.oddsB)];
    const et = l.etPct.trim() === "" ? 0 : num(l.etPct);
    return devigPoissonGoals(players, parseInt(l.line, 10), num(l.marginPct), et);
  }
  const opp = num(l.oppOdds);
  // A filled-in third outcome must be valid — silently ignoring garbage would
  // skew the de-vig without the user noticing.
  const third = l.thirdOdds.trim() === "" ? null : num(l.thirdOdds);
  return devigProportional(o, third == null ? [opp] : [opp, third]);
}

// Multi-leg fair-odds calculator for specials/bet builders: de-vig each leg,
// multiply (with optional same-match correlation), compare vs offered price.
export function FairOddsCalculator({
  defaultBankrollUnits,
  unit,
}: {
  defaultBankrollUnits: number;
  unit: number;
}) {
  const nextId = useRef(2);
  const [legs, setLegs] = useState<LegState[]>([emptyLeg(0), emptyLeg(1)]);
  const [comboMode, setComboMode] = useState<ComboMode>("all");
  const [rho, setRho] = useState(0);
  const [offered, setOffered] = useState("");
  const [stake, setStake] = useState("1");
  const [bankroll, setBankroll] = useState(String(Math.max(1, Math.round(defaultBankrollUnits))));

  const patchLeg = (id: number, patch: Partial<LegState>) =>
    setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLeg = () => setLegs((ls) => (ls.length >= MAX_LEGS ? ls : [...ls, emptyLeg(nextId.current++)]));
  const removeLeg = (id: number) => setLegs((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.id !== id)));

  const results = legs.map(legResult);
  const allValid = results.every((r) => r != null);

  // Warn about shared matches as soon as labels collide, even mid-typing.
  const matchGroups = useMemo(() => {
    const m = new Map<string, number[]>();
    legs.forEach((l, i) => {
      const k = matchKeyOf(l.match);
      if (!k) return;
      const g = m.get(k);
      if (g) g.push(i);
      else m.set(k, [i]);
    });
    return [...m.values()].filter((g) => g.length >= 2);
  }, [legs]);
  const correlated = matchGroups.length > 0;

  const combo = allValid
    ? combineLegs(
        legs.map((l, i): FairLeg => ({ p: results[i]!.p, overround: results[i]!.overround, matchKey: matchKeyOf(l.match) })),
        rho,
        comboMode
      )
    : null;

  const O = num(offered);
  const stakeU = num(stake);
  const bank = num(bankroll);
  const offeredValid = O > 1;
  const edge = combo && offeredValid ? priceEdge(O, combo.pAdjusted) : null;
  const advice = combo && offeredValid && bank > 0 ? kellyAdvice(O, combo.pAdjusted, bank) : null;
  const rhoActive = correlated && rho !== 0;

  return (
    <>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <span className="ap-label">Ben i spelet</span>
          <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Odds från spelbolagets marknad, per ben</span>
        </div>

        <div className="ap-field" style={{ marginTop: 12, maxWidth: 360 }}>
          <label>Spelet vinner om</label>
          <div className="ap-seg2">
            <button className={comboMode === "all" ? "is-active" : ""} onClick={() => setComboMode("all")}>
              Alla ben går in
            </button>
            <button className={comboMode === "any" ? "is-active" : ""} onClick={() => setComboMode("any")}>
              Minst ett ben (eller)
            </button>
          </div>
        </div>

        {legs.map((l, i) => {
          const r = results[i];
          return (
            <div key={l.id} style={{ background: "var(--card2)", borderRadius: 12, padding: "12px 14px", marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span className="ap-label">Ben {i + 1}</span>
                {legs.length > 1 && (
                  <button
                    className="ap-btn ghost"
                    style={{ padding: "3px 10px", fontSize: 13, lineHeight: 1.4 }}
                    onClick={() => removeLeg(l.id)}
                    aria-label={`Ta bort ben ${i + 1}`}
                  >
                    ×
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                <div className="ap-field" style={{ flex: "1 1 150px", minWidth: 130 }}>
                  <label>Beskrivning (valfri)</label>
                  <input
                    className="ap-input"
                    value={l.desc}
                    placeholder={
                      l.mode === "goals"
                        ? "t.ex. Haaland & Vinícius Ö1,5 mål"
                        : l.mode === "one"
                          ? "t.ex. Haaland första målet"
                          : "t.ex. Över 5,5 mål"
                    }
                    onChange={(e) => patchLeg(l.id, { desc: e.target.value })}
                  />
                </div>
                <div className="ap-field" style={{ flex: "1 1 150px", minWidth: 130 }}>
                  <label>Match</label>
                  <input
                    className="ap-input"
                    value={l.match}
                    placeholder="t.ex. Arsenal–Chelsea"
                    onChange={(e) => patchLeg(l.id, { match: e.target.value })}
                  />
                </div>
                <div className="ap-field" style={{ flex: "1 1 300px", minWidth: 240 }}>
                  <label>Oddskälla</label>
                  <div className="ap-seg2">
                    <button className={l.mode === "two" ? "is-active" : ""} onClick={() => patchLeg(l.id, { mode: "two" })}>
                      Båda sidorna
                    </button>
                    <button className={l.mode === "one" ? "is-active" : ""} onClick={() => patchLeg(l.id, { mode: "one" })}>
                      Bara min sida
                    </button>
                    <button className={l.mode === "goals" ? "is-active" : ""} onClick={() => patchLeg(l.id, { mode: "goals" })}>
                      Mål tillsammans
                    </button>
                  </div>
                </div>

                <div className="ap-field" style={{ width: l.mode === "goals" ? 110 : 96 }}>
                  <label>{l.mode === "goals" ? "Anytime A" : "Mitt odds"}</label>
                  <input
                    className="ap-input ap-num"
                    inputMode="decimal"
                    value={l.odds}
                    placeholder={l.mode === "goals" ? "2.30" : "1.90"}
                    onChange={(e) => patchLeg(l.id, { odds: e.target.value })}
                  />
                </div>
                {l.mode === "two" && (
                  <>
                    <div className="ap-field" style={{ width: 110 }}>
                      <label>Motsatt sida</label>
                      <input
                        className="ap-input ap-num"
                        inputMode="decimal"
                        value={l.oppOdds}
                        placeholder="1.90"
                        onChange={(e) => patchLeg(l.id, { oppOdds: e.target.value })}
                      />
                    </div>
                    <div className="ap-field" style={{ width: 120 }}>
                      <label>Utfall 3 (valfri)</label>
                      <input
                        className="ap-input ap-num"
                        inputMode="decimal"
                        value={l.thirdOdds}
                        placeholder="—"
                        onChange={(e) => patchLeg(l.id, { thirdOdds: e.target.value })}
                      />
                    </div>
                  </>
                )}
                {l.mode === "goals" && (
                  <>
                    <div className="ap-field" style={{ width: 130 }}>
                      <label>Anytime B (valfri)</label>
                      <input
                        className="ap-input ap-num"
                        inputMode="decimal"
                        value={l.oddsB}
                        placeholder="—"
                        onChange={(e) => patchLeg(l.id, { oddsB: e.target.value })}
                      />
                    </div>
                    <div className="ap-field" style={{ width: 96 }}>
                      <label>Linje</label>
                      <div className="ap-select">
                        <select value={l.line} onChange={(e) => patchLeg(l.id, { line: e.target.value })}>
                          <option value="1">Ö0.5</option>
                          <option value="2">Ö1.5</option>
                          <option value="3">Ö2.5</option>
                        </select>
                      </div>
                    </div>
                    <div className="ap-field" style={{ width: 110 }}>
                      <label>ET-tillägg %</label>
                      <input
                        className="ap-input ap-num"
                        inputMode="decimal"
                        value={l.etPct}
                        placeholder="0"
                        onChange={(e) => patchLeg(l.id, { etPct: e.target.value })}
                      />
                    </div>
                  </>
                )}
                {l.mode !== "two" && (
                  <div className="ap-field" style={{ width: 130 }}>
                    <label>Antagen marginal %</label>
                    <input
                      className="ap-input ap-num"
                      inputMode="decimal"
                      value={l.marginPct}
                      onChange={(e) => patchLeg(l.id, { marginPct: e.target.value })}
                    />
                  </div>
                )}
              </div>

              {r ? (
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
                  <InlineStat label="Fair %" value={pctFmt(r.p * 100)} />
                  <InlineStat label="Fair odds" value={fmtOdds(1 / r.p)} />
                  <InlineStat label="Marginal" value={pctFmt(r.overround * 100)} />
                  {r.lambda != null && (
                    <InlineStat
                      label="Väntade mål"
                      value={r.lambda.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    />
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 8 }}>
                  {l.mode === "two"
                    ? "Ange ditt och motsatta sidans odds (> 1)."
                    : l.mode === "goals"
                      ? "Ange anytime-odds (> 1) för minst en spelare."
                      : "Ange odds (> 1) och antagen marginal."}
                </div>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: 12 }}>
          <button className="ap-btn ghost" onClick={addLeg} disabled={legs.length >= MAX_LEGS}>
            + Lägg till ben
          </button>
        </div>
      </Card>

      {correlated && (
        <div
          style={{
            border: "1px solid rgba(245, 165, 36, 0.45)",
            background: "rgba(245, 165, 36, 0.07)",
            borderRadius: 12,
            padding: "12px 14px",
            marginBottom: 12,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <strong>⚠️ Samma match:</strong>{" "}
          {matchGroups.map((g) => `ben ${g.map((i) => i + 1).join(" & ")}`).join(", ")} — justera samvariationen.
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
            <input
              type="range"
              min={RHO_MIN}
              max={RHO_MAX}
              step={0.05}
              value={rho}
              onChange={(e) => setRho(parseFloat(e.target.value))}
              aria-label="Korrelation mellan ben i samma match"
              style={{ accentColor: "var(--acc)", flex: "1 1 180px", maxWidth: 320 }}
            />
            <span className="ap-num" style={{ fontWeight: 700 }}>
              ρ = {rho.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span style={{ fontSize: 11, color: "var(--dim2)" }}>0 oberoende · 0,3 måttlig · 0,5 stark</span>
          </div>
        </div>
      )}

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <span className="ap-label">Resultat</span>
          <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Vad borde specialen betala — och är erbjudandet värt det?</span>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
          <div className="ap-field" style={{ width: 120 }}>
            <label>Erbjudet odds</label>
            <input
              className="ap-input ap-num"
              inputMode="decimal"
              value={offered}
              placeholder="16.00"
              onChange={(e) => setOffered(e.target.value)}
            />
          </div>
          <div className="ap-field" style={{ width: 96 }}>
            <label>Insats (U)</label>
            <input className="ap-input ap-num" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
          </div>
          <div className="ap-field" style={{ width: 120 }}>
            <label>Bankrulle (U)</label>
            <input className="ap-input ap-num" inputMode="decimal" value={bankroll} onChange={(e) => setBankroll(e.target.value)} />
          </div>
        </div>

        {combo == null ? (
          <div style={{ fontSize: 13, color: "var(--dim2)", marginTop: 14 }}>
            Fyll i alla ben ovan så räknas fair odds ut här.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 16 }}>
              <div style={{ background: "var(--acc-soft)", borderRadius: 12, padding: "12px 14px" }}>
                <div className="ap-label">Fair odds</div>
                <div className="ap-num" style={{ fontSize: 26, fontWeight: 800, marginTop: 4, letterSpacing: "-0.02em" }}>
                  {fmtOdds(combo.fairOdds)}
                </div>
                {rhoActive && (
                  <div style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 3 }}>
                    utan korrelation {fmtOdds(combo.fairOddsIndependent)}
                  </div>
                )}
              </div>
              <MiniStat
                label="Fair sannolikhet"
                value={pctFmt(combo.pAdjusted * 100)}
                sub={comboMode === "any" ? `minst 1 av ${combo.n} ben` : `${combo.n} ben`}
              />
              <MiniStat label="Snittmarginal/ben" value={pctFmt(combo.avgOverround * 100)} />
              {edge != null && <MiniStat label="Edge (EV)" value={pctFmt(edge * 100, true)} tone={edge > 0 ? "pos" : "neg"} />}
              {edge != null && stakeU > 0 && (
                <MiniStat
                  label="EV per spel"
                  value={krFmt(edge * stakeU * unit, true)}
                  tone={edge > 0 ? "pos" : "neg"}
                  sub={`vid ${uFmt(stakeU)} insats`}
                />
              )}
              {advice != null && advice.hasEdge && (
                <MiniStat
                  label="½ Kelly (rek.)"
                  value={uFmt(advice.halfUnits)}
                  sub={`${pctFmt(advice.half * 100)} · ${krFmt(advice.halfUnits * unit)}`}
                />
              )}
            </div>

            {edge == null ? (
              <div style={{ fontSize: 12.5, color: "var(--dim2)", marginTop: 14 }}>
                Ange erbjudet odds för edge, EV och Kelly.
              </div>
            ) : (
              <div className={"ap-num " + (edge > 0 ? "pos" : "neg")} style={{ marginTop: 14, fontSize: 14, fontWeight: 700 }}>
                {edge > 0 ? "✓" : "✗"} {fmtOdds(O)} vs fair {fmtOdds(combo.fairOdds)} → {pctFmt(edge * 100, true)}
                {edge <= 0 && " · lägg inget"}
              </div>
            )}
          </>
        )}

        <details className="ap-fine">
          <summary>Så räknas det</summary>
          Fair odds bygger på att spelbolagets grundmarknad prissätter rätt sånär som på marginalen (proportionell
          de-vig). &quot;Bara min sida&quot; antar en marginal när motsatt odds inte visas. &quot;Mål tillsammans&quot; räknar
          Poisson på spelarnas anytime-odds (oberoende antas mellan spelarna) — ET-tillägget (~7 % i slutspel) används
          när specialen inkluderar förlängning men anytime-oddsen gäller 90 minuter. &quot;Minst ett ben&quot; räknar
          unionen 1 − Π(1−p) för eller-spel som &quot;X eller Y gör första målet&quot; — där behövs varje spelares
          första målskytt-odds, och målskyttemarknader bär hög marginal: anta 20–40 % i &quot;Bara min sida&quot;-läget.
          Korrelationsjusteringen är en tumregel — ben i samma match kan samvariera mer eller mindre än så.
        </details>
      </Card>
    </>
  );
}
