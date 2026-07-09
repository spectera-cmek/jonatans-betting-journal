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
  devigCombinedOver,
  devigOneSided,
  devigPlayerOverJoint,
  devigPoissonGoals,
  devigProportional,
  matchKeyOf,
  type OverComponent,
  priceEdge,
  type ComboMode,
  type DevigResult,
  type FairLeg,
} from "@/lib/fairOdds";
import { fmtOdds, krFmt, pctFmt, uFmt } from "@/lib/format";

// Bet types in the bettor's terms — each maps to one de-vig method in
// lib/fairOdds so the user never has to pick the math themselves.
type BetType = "market" | "prop" | "playersgoals" | "playerou" | "multigoals";

const BET_TYPES: { id: BetType; label: string }[] = [
  { id: "market", label: "Vanlig marknad" },
  { id: "prop", label: "Prop, bara mitt odds" },
  { id: "playersgoals", label: "Spelares mål ihop" },
  { id: "playerou", label: "Spelare + Ö/U" },
  { id: "multigoals", label: "Mål över flera matcher" },
];

// One-line what-is-this per speltyp, shown under the type switch.
const TYPE_HINT: Record<BetType, string> = {
  market: "Ö/U, 1X2 eller handikapp där du ser båda/alla sidornas odds — marginalen räknas bort automatiskt.",
  prop: "Spelarprop eller målskytt där bara ditt odds syns — ange antagen marginal: props ~6–10 %, målskytt 20–40 %.",
  playersgoals: "Flera spelares mål tillsammans via deras anytime-odds — t.ex. Haaland & Vinícius Ö1,5 ihop.",
  playerou: "Spelare gör mål/assist OCH matchen går över linjen — samvariationen räknas exakt (samma match).",
  multigoals: "Mål sammanlagt över flera matcher/lag — en rad per match med dess egna Ö/U-odds, t.ex. minst 10 mål i tre matcher.",
};

const TYPE_EMPTY: Record<BetType, string> = {
  market: "Ange ditt och motsatta sidans odds (> 1).",
  prop: "Ange odds (> 1) och antagen marginal.",
  playersgoals: "Ange anytime-odds (> 1) för minst en spelare.",
  playerou: "Ange spelarens mål/assist-odds och matchens Över-odds (> 1).",
  multigoals: "Ange Över-odds (> 1) för minst en match/ett lag.",
};

const DESC_PLACEHOLDER: Record<BetType, string> = {
  market: "t.ex. Över 5,5 mål",
  prop: "t.ex. Haaland första målet",
  playersgoals: "t.ex. Haaland & Vinícius Ö1,5 mål",
  playerou: "t.ex. Bellingham mål/assist + Ö1,5",
  multigoals: "t.ex. Minst 10 mål i 3 matcher",
};

interface OuSource {
  label: string; // match/team, display only
  over: string;
  under: string; // optional → one-sided de-vig with the assumed margin
  line: string; // over-line threshold, "1" = Ö0.5 …
}

interface LegState {
  id: number;
  desc: string; // display only
  match: string; // correlation grouping via matchKeyOf()
  betType: BetType;
  odds: string; // market/prop: my odds · playerou: spelarens mål/assist-odds
  oppOdds: string; // market: opposing side
  thirdOdds: string; // market: optional 3rd outcome (1X2)
  marginPct: string; // assumed market margin for one-sided prices
  players: string[]; // playersgoals: anytime odds per player
  line: string; // playersgoals/playerou: over-line threshold
  etPct: string; // playersgoals: extra-time boost
  ouOver: string; // playerou: match over odds
  ouUnder: string; // playerou: match under odds (optional)
  sources: OuSource[]; // multigoals: one row per match/team
  totalLine: string; // multigoals: combined-goals threshold
}

const MAX_PLAYERS = 4;
const MAX_SOURCES = 6;

const emptySource = (): OuSource => ({ label: "", over: "", under: "", line: "3" });

function emptyLeg(id: number): LegState {
  return {
    id,
    desc: "",
    match: "",
    betType: "market",
    odds: "",
    oppOdds: "",
    thirdOdds: "",
    marginPct: String(DEFAULT_ONE_SIDED_MARGIN_PCT),
    players: ["", ""],
    line: "2",
    etPct: "0",
    ouOver: "",
    ouUnder: "",
    sources: [emptySource(), emptySource()],
    totalLine: "4",
  };
}

// Over-line choices: per source (Ö0.5–Ö5.5) and for the special's combined
// total (Ö0.5–Ö11.5 — multi-match specials like "10+ mål i tre matcher").
const SOURCE_LINES = Array.from({ length: 6 }, (_, i) => i + 1);
const TOTAL_LINES = Array.from({ length: 12 }, (_, i) => i + 1);
const lineLabel = (k: number) => `Ö${k - 1},5`;

const num = (v: string) => parseFloat(v.replace(",", "."));

function legResult(l: LegState): DevigResult | null {
  if (l.betType === "prop") return devigOneSided(num(l.odds), num(l.marginPct));
  if (l.betType === "playersgoals") {
    const anytime = l.players.filter((p) => p.trim() !== "").map(num);
    if (anytime.length === 0) return null;
    const et = l.etPct.trim() === "" ? 0 : num(l.etPct);
    return devigPoissonGoals(anytime, parseInt(l.line, 10), num(l.marginPct), et);
  }
  if (l.betType === "playerou") {
    const under = l.ouUnder.trim() === "" ? null : num(l.ouUnder);
    return devigPlayerOverJoint(num(l.odds), num(l.ouOver), under, parseInt(l.line, 10), num(l.marginPct));
  }
  if (l.betType === "multigoals") {
    // Rows without an over price are treated as not-yet-filled; a row with an
    // invalid over price must fail loudly (devigCombinedOver returns null).
    const comps: OverComponent[] = l.sources
      .filter((s) => s.over.trim() !== "")
      .map((s) => ({
        overOdds: num(s.over),
        underOdds: s.under.trim() === "" ? null : num(s.under),
        line: parseInt(s.line, 10),
      }));
    if (comps.length === 0) return null;
    return devigCombinedOver(comps, parseInt(l.totalLine, 10), num(l.marginPct));
  }
  const opp = num(l.oppOdds);
  // A filled-in third outcome must be valid — silently ignoring garbage would
  // skew the de-vig without the user noticing.
  const third = l.thirdOdds.trim() === "" ? null : num(l.thirdOdds);
  return devigProportional(num(l.odds), third == null ? [opp] : [opp, third]);
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
  const nextId = useRef(1);
  const [legs, setLegs] = useState<LegState[]>([emptyLeg(0)]);
  const [comboMode, setComboMode] = useState<ComboMode>("all");
  const [rho, setRho] = useState(0);
  const [offered, setOffered] = useState("");
  const [stake, setStake] = useState("1");
  const [bankroll, setBankroll] = useState(String(Math.max(1, Math.round(defaultBankrollUnits))));

  const patchLeg = (id: number, patch: Partial<LegState>) =>
    setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLeg = () => setLegs((ls) => (ls.length >= MAX_LEGS ? ls : [...ls, emptyLeg(nextId.current++)]));
  const removeLeg = (id: number) => setLegs((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.id !== id)));

  const patchPlayer = (l: LegState, idx: number, v: string) =>
    patchLeg(l.id, { players: l.players.map((p, i) => (i === idx ? v : p)) });
  const addPlayer = (l: LegState) =>
    l.players.length < MAX_PLAYERS && patchLeg(l.id, { players: [...l.players, ""] });
  const removePlayer = (l: LegState, idx: number) =>
    l.players.length > 1 && patchLeg(l.id, { players: l.players.filter((_, i) => i !== idx) });

  const patchSource = (l: LegState, idx: number, patch: Partial<OuSource>) =>
    patchLeg(l.id, { sources: l.sources.map((s, i) => (i === idx ? { ...s, ...patch } : s)) });
  const addSource = (l: LegState) =>
    l.sources.length < MAX_SOURCES && patchLeg(l.id, { sources: [...l.sources, emptySource()] });
  const removeSource = (l: LegState, idx: number) =>
    l.sources.length > 1 && patchLeg(l.id, { sources: l.sources.filter((_, i) => i !== idx) });

  const results = legs.map(legResult);
  const allValid = results.every((r) => r != null);
  const multi = legs.length >= 2;

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
  const correlated = multi && matchGroups.length > 0;

  const combo = allValid
    ? combineLegs(
        legs.map((l, i): FairLeg => ({ p: results[i]!.p, overround: results[i]!.overround, matchKey: matchKeyOf(l.match) })),
        multi ? rho : 0,
        multi ? comboMode : "all"
      )
    : null;

  const O = num(offered);
  const stakeU = num(stake);
  const bank = num(bankroll);
  const offeredValid = O > 1;
  const edge = combo && offeredValid ? priceEdge(O, combo.pAdjusted) : null;
  const advice = combo && offeredValid && bank > 0 ? kellyAdvice(O, combo.pAdjusted, bank) : null;
  const rhoActive = correlated && rho !== 0;

  const numField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts?: { width?: number; placeholder?: string }
  ) => (
    <div className="ap-field" style={{ width: opts?.width ?? 110 }}>
      <label>{label}</label>
      <input
        className="ap-input ap-num"
        inputMode="decimal"
        value={value}
        placeholder={opts?.placeholder ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );

  const marginField = (l: LegState) => numField("Antagen marginal %", l.marginPct, (v) => patchLeg(l.id, { marginPct: v }), { width: 130 });

  const lineSelect = (label: string, value: string, lines: number[], onChange: (v: string) => void, width = 96) => (
    <div className="ap-field" style={{ width }}>
      <label>{label}</label>
      <div className="ap-select">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {lines.map((k) => (
            <option key={k} value={String(k)}>
              {lineLabel(k)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  return (
    <>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <span className="ap-label">Spelet</span>
          <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Odds från spelbolagets marknad, per ben</span>
        </div>

        <details className="ap-fine" style={{ marginTop: 6 }}>
          <summary>Vilken speltyp ska jag välja?</summary>
          <div style={{ display: "grid", gap: 3, marginTop: 4 }}>
            <span>
              <strong>Vanlig marknad</strong> — Ö/U, 1X2 eller handikapp där du ser båda oddsen. Ex: Över 5,5 hörnor 1.90/1.90.
            </span>
            <span>
              <strong>Prop, bara mitt odds</strong> — spelarprop/målskytt där bara ditt odds syns. Ex: Haaland första målet
              @4.50 med ~25 % marginal.
            </span>
            <span>
              <strong>Spelares mål ihop</strong> — flera spelares mål tillsammans via anytime-odds. Ex: Haaland &amp;
              Vinícius Ö1,5 mål ihop.
            </span>
            <span>
              <strong>Spelare + Ö/U</strong> — spelare gör mål/assist och matchen går över linjen, i samma match. Ex:
              Bellingham mål/assist + Ö1,5.
            </span>
            <span>
              <strong>Mål över flera matcher</strong> — mål sammanlagt över flera matcher/lag, en rad per match med dess
              egna Ö/U-odds. Ex: minst 10 mål i tre matcher → tre rader med varje matchs Ö2,5-odds, totallinje Ö9,5.
            </span>
          </div>
        </details>

        {multi && (
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
        )}

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
                <div className="ap-field" style={{ flex: "1 1 170px", minWidth: 140 }}>
                  <label>Beskrivning (valfri)</label>
                  <input
                    className="ap-input"
                    value={l.desc}
                    placeholder={DESC_PLACEHOLDER[l.betType]}
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
                <div className="ap-field" style={{ flex: "1 1 320px", minWidth: 260 }}>
                  <label>Typ av spel</label>
                  <div className="ap-seg2">
                    {BET_TYPES.map((t) => (
                      <button
                        key={t.id}
                        className={l.betType === t.id ? "is-active" : ""}
                        onClick={() => patchLeg(l.id, { betType: t.id })}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: 8 }}>{TYPE_HINT[l.betType]}</div>

              {l.betType === "market" && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                  {numField("Mitt odds", l.odds, (v) => patchLeg(l.id, { odds: v }), { width: 96, placeholder: "1.90" })}
                  {numField("Motsatt sida", l.oppOdds, (v) => patchLeg(l.id, { oppOdds: v }), { placeholder: "1.90" })}
                  {numField("Utfall 3 (valfri)", l.thirdOdds, (v) => patchLeg(l.id, { thirdOdds: v }), { width: 120, placeholder: "—" })}
                </div>
              )}

              {l.betType === "prop" && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                  {numField("Mitt odds", l.odds, (v) => patchLeg(l.id, { odds: v }), { width: 96, placeholder: "4.50" })}
                  {marginField(l)}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="ap-btn ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      onClick={() => patchLeg(l.id, { marginPct: "6" })}
                    >
                      Props 6 %
                    </button>
                    <button
                      className="ap-btn ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      onClick={() => patchLeg(l.id, { marginPct: "30" })}
                    >
                      Målskytt 30 %
                    </button>
                  </div>
                </div>
              )}

              {l.betType === "playersgoals" && (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                    {l.players.map((p, pi) => (
                      <div key={pi} style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                        {numField(
                          `Spelare ${pi + 1} anytime`,
                          p,
                          (v) => patchPlayer(l, pi, v),
                          { width: 130, placeholder: pi === 0 ? "2.30" : "—" }
                        )}
                        {l.players.length > 1 && (
                          <button
                            className="ap-btn ghost"
                            style={{ padding: "6px 9px", fontSize: 13, lineHeight: 1.2 }}
                            onClick={() => removePlayer(l, pi)}
                            aria-label={`Ta bort spelare ${pi + 1}`}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      className="ap-btn ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      onClick={() => addPlayer(l)}
                      disabled={l.players.length >= MAX_PLAYERS}
                    >
                      + Lägg till spelare
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                    {lineSelect("Linje", l.line, SOURCE_LINES.slice(0, 4), (v) => patchLeg(l.id, { line: v }))}
                    {numField("ET-tillägg %", l.etPct, (v) => patchLeg(l.id, { etPct: v }), { placeholder: "0" })}
                    {marginField(l)}
                  </div>
                </>
              )}

              {l.betType === "playerou" && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                  {numField("Spelarens odds", l.odds, (v) => patchLeg(l.id, { odds: v }), { width: 120, placeholder: "3.00" })}
                  {numField("Över-odds", l.ouOver, (v) => patchLeg(l.id, { ouOver: v }), { width: 100, placeholder: "1.30" })}
                  {numField("Under-odds (valfri)", l.ouUnder, (v) => patchLeg(l.id, { ouUnder: v }), { width: 130, placeholder: "—" })}
                  {lineSelect("Linje", l.line, SOURCE_LINES.slice(0, 4), (v) => patchLeg(l.id, { line: v }))}
                  {marginField(l)}
                </div>
              )}

              {l.betType === "multigoals" && (
                <>
                  {l.sources.map((s, si) => (
                    <div
                      key={si}
                      style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}
                    >
                      <div className="ap-field" style={{ flex: "1 1 170px", minWidth: 140 }}>
                        <label>Match/lag {si + 1}</label>
                        <input
                          className="ap-input"
                          value={s.label}
                          placeholder="t.ex. Malmö FF–IFK Göteborg"
                          onChange={(e) => patchSource(l, si, { label: e.target.value })}
                        />
                      </div>
                      {numField("Över", s.over, (v) => patchSource(l, si, { over: v }), { width: 96, placeholder: "1.66" })}
                      {numField("Under (valfri)", s.under, (v) => patchSource(l, si, { under: v }), { width: 118, placeholder: "—" })}
                      {lineSelect("Linje", s.line, SOURCE_LINES, (v) => patchSource(l, si, { line: v }), 90)}
                      {l.sources.length > 1 && (
                        <button
                          className="ap-btn ghost"
                          style={{ padding: "6px 9px", fontSize: 13, lineHeight: 1.2 }}
                          onClick={() => removeSource(l, si)}
                          aria-label={`Ta bort match ${si + 1}`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                    <button
                      className="ap-btn ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                      onClick={() => addSource(l)}
                      disabled={l.sources.length >= MAX_SOURCES}
                    >
                      + Lägg till match
                    </button>
                    {lineSelect("Totallinje", l.totalLine, TOTAL_LINES, (v) => patchLeg(l.id, { totalLine: v }), 100)}
                    {marginField(l)}
                  </div>
                </>
              )}

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
                  {r.q != null && <InlineStat label="Spelarandel/mål" value={pctFmt(r.q * 100)} />}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 8 }}>{TYPE_EMPTY[l.betType]}</div>
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
            Fyll i {multi ? "alla ben" : "benet"} ovan så räknas fair odds ut här.
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
                sub={multi && comboMode === "any" ? `minst 1 av ${combo.n} ben` : `${combo.n} ben`}
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
          de-vig). &quot;Prop, bara mitt odds&quot; antar en marginal när motsatt odds inte visas — props bär ofta
          6–10 %, målskyttemarknader 20–40 %. &quot;Spelares mål ihop&quot; räknar Poisson på spelarnas anytime-odds
          (oberoende antas mellan spelarna) — ET-tillägget (~7 % i slutspel) används när specialen inkluderar
          förlängning men anytime-oddsen gäller 90 minuter. &quot;Minst ett ben&quot; räknar unionen 1 − Π(1−p) för
          eller-spel som &quot;X eller Y gör första målet&quot;. &quot;Spelare + Ö/U&quot; räknar som gamblingcabins
          specialspels-artikel — betingade sannolikheter över matchens måltal (Poisson) i stället för oberoende
          multiplikation, eftersom spelarben och målben i samma match samvarierar starkt; benet är då redan
          korrelationsjusterat och ska inte ρ-justeras en gång till. &quot;Mål över flera matcher&quot; backar ut
          väntade mål (λ) per match ur dess Ö/U-marknad, antar oberoende mellan matcherna och räknar totalen som
          Poisson-summan mot totallinjen — med bara en rad ifylld fungerar den som linjeflytt (t.ex. fair Ö2,5 ur
          Ö1,5-priset). Korrelationsjusteringen mellan ben är en tumregel — ben i samma match kan samvariera mer
          eller mindre än så.
        </details>
      </Card>
    </>
  );
}
