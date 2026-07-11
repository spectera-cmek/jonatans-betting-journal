"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import {
  SPORTS,
  MARKETS,
  SIDES,
  BOOKMAKERS,
  MARKET_CATEGORIES_BY_SPORT,
  GENERIC_MARKET_CATEGORIES,
  SCOPES,
  EVENT_KINDS,
  TOURNAMENT_STAGES,
  VM_2026_LEAGUE,
} from "@/lib/constants";
import { inferSelection } from "@/lib/grading";
import { categorizeDetail } from "@/lib/categorize";
import { inferEventKind } from "@/lib/betTaxonomy";
import { evaluateBet } from "@/lib/discipline";
import { accaOdds } from "@/lib/betting";
import { I, IC } from "./icons";
import type { BetDTO } from "@/lib/types";

// One parsed accumulator leg (bet365 import shape). outcome is the raw Swedish
// token from the statement ("Vinst", "Förlust", "Pågående", "Annullerat"…).
interface LegView {
  selection?: string;
  event?: string;
  market?: string | null;
  odds?: number | null;
  outcome?: string;
}

function legOutcome(token?: string): { label: string; badge: string } {
  const t = (token || "").toLowerCase();
  if (/pågå/.test(t)) return { label: "Öppen", badge: "open" };
  if (/halv/.test(t)) return { label: "Halv", badge: "push" };
  if (/annul|återbet|cancel/.test(t)) return { label: "Void", badge: "open" };
  if (/vinst|vunn|won/.test(t)) return { label: "Vunnen", badge: "won" };
  if (/förlus|förlor|lost/.test(t)) return { label: "Förlorad", badge: "lost" };
  return { label: token || "—", badge: "open" };
}

// Förifyllning från kvitto-tolkningen (parse-screenshot). `form` är formulärfält;
// importRef/placedAt/legs/betType följer med skapande-POST:en utan synliga fält.
export interface BetPrefill {
  form: Partial<Form>;
  importRef?: string | null;
  placedAt?: string | null;
  legs?: unknown;
  betType?: string | null;
  duplicate?: { betId: string; event: string; selection: string } | null;
  queue?: { index: number; total: number };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  hasOddsApiKey: boolean;
  /** When set, the modal edits this bet (PATCH with only the changed fields). */
  bet?: BetDTO | null;
  /** When set (and not editing), the create form is prefilled from a parsed betslip. */
  prefill?: BetPrefill | null;
}

const today = () => new Date().toISOString().slice(0, 10);

const empty = {
  eventAt: today(),
  sport: "Football",
  sportKey: "",
  league: "",
  event: "",
  homeTeam: "",
  awayTeam: "",
  market: "h2h",
  marketCategory: "",
  marketScope: "",
  eventKind: "match",
  tournamentStage: "",
  selection: "",
  selectionSide: "home",
  line: "",
  odds: "1.95",
  stakeUnits: "1",
  outcome: "pending",
  bookmaker: "Unibet",
  tipster: "",
  externalRef: "",
  resultProvider: "",
  resultEventRef: "",
  notes: "",
};
type Form = typeof empty;

function formFromBet(b: BetDTO): Form {
  return {
    eventAt: (b.eventAt ?? b.placedAt).slice(0, 10),
    sport: b.sport ?? "Football",
    sportKey: b.sportKey ?? "",
    league: b.league ?? "",
    event: b.event,
    homeTeam: b.homeTeam ?? "",
    awayTeam: b.awayTeam ?? "",
    market: b.market,
    marketCategory: b.marketCategory ?? "",
    marketScope: b.marketScope ?? "",
    eventKind: b.eventKind ?? "match",
    tournamentStage: b.tournamentStage ?? "",
    selection: b.selection,
    selectionSide: b.selectionSide ?? "home",
    line: b.line != null ? String(b.line) : "",
    odds: String(b.odds),
    stakeUnits: String(b.stakeUnits),
    outcome: b.outcome,
    bookmaker: b.bookmaker ?? "Unibet",
    tipster: b.tipster ?? "",
    externalRef: b.externalRef ?? "",
    resultProvider: b.resultProvider ?? "",
    resultEventRef: b.resultEventRef ?? "",
    notes: b.notes ?? "",
  };
}

interface SearchEvent {
  id: string;
  sportKey: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  homePrice: number | null;
  awayPrice: number | null;
  drawPrice: number | null;
}

const RESULT_SEG: [string, string][] = [
  ["pending", "Öppen"],
  ["win", "Vunnen"],
  ["loss", "Förlorad"],
  ["push", "Push"],
];

export function AddBetModal({ open, onClose, onSaved, hasOddsApiKey, bet, prefill }: Props) {
  const editing = !!bet;
  const [form, setForm] = useState<Form>(empty);
  const initial = useRef<Form>(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  const [searchSport, setSearchSport] = useState("soccer_epl");
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<SearchEvent[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    if (open) {
      const f = bet
        ? formFromBet(bet)
        : prefill
          ? { ...empty, eventAt: today(), ...prefill.form }
          : { ...empty, eventAt: today() };
      initial.current = f;
      setForm(f);
      setError(null);
      setShowSearch(false);
      setSearchResults([]);
      setTimeout(() => firstField.current?.focus(), 50);
    }
  }, [open, bet, prefill]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Live leak/edge check against the personal loss-analysis rules.
  const verdict = useMemo(
    () =>
      evaluateBet({
        sport: form.sport,
        selection: form.selection,
        market: form.market,
        odds: parseFloat(form.odds) || null,
        stakeUnits: parseFloat(form.stakeUnits) || null,
        betType: bet?.betType ?? "single",
      }),
    [form.sport, form.selection, form.market, form.odds, form.stakeUnits, bet]
  );

  // Accumulator-ben: från den redigerade betet (JSON-sträng) eller, vid kvitto-
  // import, direkt från prefillens legs-array så användaren kan bekräfta dem.
  const legs = useMemo<LegView[]>(() => {
    if (bet?.legs) {
      try {
        const arr = JSON.parse(bet.legs);
        return Array.isArray(arr) ? (arr as LegView[]) : [];
      } catch {
        return [];
      }
    }
    if (!bet && Array.isArray(prefill?.legs)) return prefill!.legs as LegView[];
    return [];
  }, [bet, prefill]);
  const comboOdds = useMemo(
    () => accaOdds(legs.map((l) => Number(l.odds)).filter((o) => Number.isFinite(o) && o > 1)),
    [legs]
  );

  if (!open) return null;

  const set = (k: keyof Form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const o = parseFloat(form.odds) || 0;
  const s = parseFloat(form.stakeUnits) || 0;
  const potential = s * o;
  const profit = s * (o - 1);

  const onSelectionBlur = () => {
    const inferred = inferSelection(form.selection, form.homeTeam, form.awayTeam);
    if (inferred.market) set("market", inferred.market);
    if (inferred.side) set("selectionSide", inferred.side);
    if (inferred.line != null) set("line", String(inferred.line));
    // Auto-tagga detaljerad marknad + scope — bara om fälten är tomma (skriv inte över ett val).
    const det = categorizeDetail(form.selection, form.event, [], form.homeTeam, form.awayTeam);
    if (!form.marketCategory && det.marketCategory && det.marketCategory !== "Övrigt") set("marketCategory", det.marketCategory);
    if (!form.marketScope && det.marketScope) set("marketScope", det.marketScope);
    const kind = inferEventKind(form.event, form.selection);
    if (kind === "outright" && form.eventKind !== kind) set("eventKind", kind);
  };

  const runSearch = async () => {
    setSearching(true);
    try {
      const res = await api.get<{ events: SearchEvent[] }>(
        `/api/odds/search?sport=${encodeURIComponent(searchSport)}&q=${encodeURIComponent(searchQ)}`
      );
      setSearchResults(res.events || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const pickEvent = (ev: SearchEvent) => {
    setForm((f) => ({
      ...f,
      event: `${ev.homeTeam} – ${ev.awayTeam}`,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      sportKey: ev.sportKey,
      externalRef: ev.id,
      eventAt: ev.commenceTime.slice(0, 10),
      selection: ev.homeTeam,
      selectionSide: "home",
      odds: ev.homePrice ? String(ev.homePrice) : f.odds,
    }));
    setShowSearch(false);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing && bet) {
        // PATCH only what changed — keeps imported payouts (profitUnits)
        // intact unless outcome/odds/stake actually moved.
        const payload: Record<string, unknown> = {};
        for (const k of Object.keys(form) as (keyof Form)[]) {
          if (k === "outcome") continue; // settlement has its own audited endpoint
          if (form[k] !== initial.current[k]) payload[k] = form[k] === "" ? null : form[k];
        }
        if (Object.keys(payload).length > 0) {
          await api.patch(`/api/bets/${bet.id}`, payload);
        }
      } else {
        await api.post("/api/bets", {
          ...form,
          line: form.line === "" ? null : form.line,
          externalRef: form.externalRef || null,
          // Kvitto-metadata från tolkningen (dedupe-referens, speltid, kombo-ben).
          ...(prefill?.importRef ? { importRef: prefill.importRef } : {}),
          ...(prefill?.placedAt ? { placedAt: prefill.placedAt } : {}),
          ...(prefill?.legs ? { legs: prefill.legs } : {}),
          ...(prefill?.betType ? { betType: prefill.betType } : {}),
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sides = SIDES[form.market] || [];
  // Imported bets carry values outside the standard option lists (Swedish
  // market categories, other bookmakers/sports) — keep them selectable.
  const sportOpts = SPORTS.includes(form.sport) ? SPORTS : [form.sport, ...SPORTS];
  const marketOpts = MARKETS.some((m) => m.value === form.market)
    ? MARKETS
    : [{ value: form.market, label: form.market }, ...MARKETS];
  const bookOpts = BOOKMAKERS.includes(form.bookmaker) ? BOOKMAKERS : [form.bookmaker, ...BOOKMAKERS];
  // Detalj-marknad: curated lista per sport (fallback generisk); behåll ett
  // importerat/avvikande värde valbart.
  const catBase = MARKET_CATEGORIES_BY_SPORT[form.sport] ?? GENERIC_MARKET_CATEGORIES;
  const catOpts = form.marketCategory && !catBase.includes(form.marketCategory)
    ? [form.marketCategory, ...catBase]
    : catBase;

  return (
    <div className="ap-overlay" onClick={onClose}>
      <div className="ap-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ap-modal-head">
          <div>
            <div className="ap-card-title" style={{ fontSize: 17 }}>{editing ? "Redigera bet" : "Logga ny bet"}</div>
            <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3 }}>
              {editing
                ? "Bara ändrade fält sparas"
                : prefill
                  ? `Tolkad från kvitto${prefill.queue && prefill.queue.total > 1 ? ` · bet ${prefill.queue.index + 1} av ${prefill.queue.total}` : ""} — kontrollera fälten`
                  : "Fyll i detaljerna nedan"}
            </div>
          </div>
          <button className="ap-close" onClick={onClose}><I p={IC.x} size={15} /></button>
        </div>

        <div className="ap-modal-body">
          {hasOddsApiKey && !editing && (
            <div className="ap-field">
              <button type="button" className="ap-link" style={{ textAlign: "left" }} onClick={() => setShowSearch((v) => !v)}>
                {showSearch ? "▾ Dölj event-sök" : "▸ Sök event (autofyll + auto-rättning)"}
              </button>
              {showSearch && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="ap-input" style={{ flex: "0 0 150px" }} value={searchSport} onChange={(e) => setSearchSport(e.target.value)} placeholder="sport key" />
                    <input className="ap-input" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="lagnamn…" />
                    <button className="ap-btn" onClick={runSearch} disabled={searching}>{searching ? "…" : "Sök"}</button>
                  </div>
                  {searchResults.length > 0 && (
                    <div className="ap-eventlist">
                      {searchResults.map((ev) => (
                        <button key={ev.id} className="ap-eventrow" onClick={() => pickEvent(ev)}>
                          <span>{ev.homeTeam} – {ev.awayTeam}</span>
                          <span className="ap-num" style={{ color: "var(--dim2)", fontSize: 12 }}>
                            {ev.homePrice?.toFixed(2) ?? "—"} / {ev.drawPrice?.toFixed(2) ?? "—"} / {ev.awayPrice?.toFixed(2) ?? "—"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="ap-x2">
            <div className="ap-field">
              <label>Datum</label>
              <input ref={firstField} className="ap-input" type="date" value={form.eventAt} onChange={(e) => set("eventAt", e.target.value)} />
            </div>
            <div className="ap-field">
              <label>Sport</label>
              <select className="ap-input" value={form.sport} onChange={(e) => set("sport", e.target.value)}>
                {sportOpts.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
          </div>

          <div className="ap-x2">
            <div className="ap-field">
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Liga</span>
                <button
                  type="button"
                  onClick={() => set("league", form.league.trim() === VM_2026_LEAGUE ? "" : VM_2026_LEAGUE)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: 0, color: form.league.trim() === VM_2026_LEAGUE ? "var(--pos)" : "var(--dim2)" }}
                >VM 2026</button>
              </label>
              <input className="ap-input" placeholder="t.ex. Premier League" value={form.league} onChange={(e) => set("league", e.target.value)} />
            </div>
            <div className="ap-field">
              <label>Match</label>
              <input className="ap-input" placeholder="t.ex. Arsenal – Chelsea" value={form.event} onChange={(e) => set("event", e.target.value)} />
            </div>
          </div>

          <div className="ap-x2">
            <div className="ap-field">
              <label>Eventtyp</label>
              <select className="ap-input" value={form.eventKind} onChange={(e) => set("eventKind", e.target.value)}>
                {EVENT_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
              </select>
            </div>
            <div className="ap-field">
              <label>Turneringsfas</label>
              <select className="ap-input" value={form.tournamentStage} onChange={(e) => set("tournamentStage", e.target.value)}>
                <option value="">— ej angiven —</option>
                {TOURNAMENT_STAGES.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label>Spel / marknad</label>
            <input className="ap-input" placeholder="t.ex. Över 2.5 mål" value={form.selection} onChange={(e) => set("selection", e.target.value)} onBlur={onSelectionBlur} />
          </div>

          <div className="ap-x2">
            <div className="ap-field">
              <label>Marknad (detalj)</label>
              <select className="ap-input" value={form.marketCategory} onChange={(e) => set("marketCategory", e.target.value)}>
                <option value="">— välj —</option>
                {catOpts.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="ap-field">
              <label>Avser</label>
              <select className="ap-input" value={form.marketScope} onChange={(e) => set("marketScope", e.target.value)}>
                <option value="">—</option>
                {SCOPES.map((sc) => <option key={sc.value} value={sc.value}>{sc.label}</option>)}
              </select>
            </div>
          </div>

          {legs.length > 1 && (
            <div className="ap-field">
              <label>
                Ben i kombinationen ({legs.length}){comboOdds > 1 ? ` · kombinerat odds ${comboOdds.toFixed(2)}` : ""}
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {legs.map((l, i) => {
                  const oc = legOutcome(l.outcome);
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        background: "var(--card2)",
                        border: "1px solid var(--line)",
                        borderRadius: 10,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div className="ap-ell" style={{ fontSize: 12.5, fontWeight: 600 }}>{l.selection || "—"}</div>
                        {l.event && <div className="ap-ell" style={{ fontSize: 11, color: "var(--dim2)" }}>{l.event}</div>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <span className="ap-num" style={{ fontSize: 12.5, color: "var(--dim)" }}>
                          {Number(l.odds) > 1 ? Number(l.odds).toFixed(2) : "—"}
                        </span>
                        <span className={"ap-badge " + oc.badge}>{oc.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="ap-x2">
            <div className="ap-field">
              <label>Avräkning (auto-rättning)</label>
              <select className="ap-input" value={form.market} onChange={(e) => set("market", e.target.value)}>
                {marketOpts.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {sides.length > 0 ? (
              <div className="ap-field">
                <label>Sida</label>
                <select className="ap-input" value={form.selectionSide} onChange={(e) => set("selectionSide", e.target.value)}>
                  {sides.map((sd) => <option key={sd.value} value={sd.value}>{sd.label}</option>)}
                </select>
              </div>
            ) : (
              <div className="ap-field">
                <label>Linje</label>
                <input className="ap-input ap-num" type="number" step="0.25" value={form.line} onChange={(e) => set("line", e.target.value)} placeholder="t.ex. 2.5" />
              </div>
            )}
          </div>

          {sides.length > 0 && (form.market === "totals" || form.market === "spreads") && (
            <div className="ap-field">
              <label>Linje</label>
              <input className="ap-input ap-num" type="number" step="0.25" value={form.line} onChange={(e) => set("line", e.target.value)} placeholder="2.5 / -1.5" />
            </div>
          )}

          <div className="ap-x2">
            <div className="ap-field">
              <label>Bookmaker</label>
              <select className="ap-input" value={form.bookmaker} onChange={(e) => set("bookmaker", e.target.value)}>
                {bookOpts.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div className="ap-field">
              <label>Tipster (valfritt)</label>
              <input className="ap-input" value={form.tipster} onChange={(e) => set("tipster", e.target.value)} />
            </div>
          </div>

          <div className="ap-x2">
            <div className="ap-field">
              <label>Odds (decimal)</label>
              <input className="ap-input ap-num" type="number" step="0.01" min="1.01" value={form.odds} onChange={(e) => set("odds", e.target.value)} />
            </div>
            <div className="ap-field">
              <label>Insats (U)</label>
              <input className="ap-input ap-num" type="number" step="0.25" min="0" value={form.stakeUnits} onChange={(e) => set("stakeUnits", e.target.value)} />
            </div>
          </div>

          {!editing && (
            <div className="ap-field">
              <label>Resultat</label>
              <div className="ap-seg2">
                {RESULT_SEG.map(([v, l]) => (
                  <button key={v} className={form.outcome === v ? "is-active" : ""} onClick={() => set("outcome", v)}>{l}</button>
                ))}
              </div>
            </div>
          )}

          <div className="ap-field">
            <label>Anteckningar (valfritt)</label>
            <textarea
              className="ap-input"
              rows={2}
              style={{ resize: "vertical", minHeight: 38 }}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>

          {verdict.notes.length > 0 && (
            <div
              style={{
                borderRadius: 10,
                padding: "10px 12px",
                background: "var(--hover, rgba(255,255,255,.04))",
                border: `1px solid ${verdict.level === "edge" ? "var(--pos)" : verdict.level === "warn" ? "var(--red)" : "var(--line, rgba(255,255,255,.08))"}33`,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 11, color: "var(--dim2)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
                Disciplinvakt
              </span>
              {verdict.notes.map((n, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, lineHeight: 1.45 }}>
                  <span className={n.tone} style={{ fontWeight: 700 }}>{n.tone === "pos" ? "✓" : "⚠"}</span>
                  <span style={{ color: n.tone === "pos" ? "var(--pos)" : "var(--red)" }}>{n.text}</span>
                </div>
              ))}
            </div>
          )}

          <div className="ap-payout">
            <div>
              <div style={{ fontSize: 11.5, color: "var(--dim2)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Möjlig utbetalning</div>
              <div className="ap-num" style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{potential.toFixed(2)}U</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11.5, color: "var(--dim2)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Vinst</div>
              <div className="ap-num pos" style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>+{profit.toFixed(2)}U</div>
            </div>
          </div>

          {!editing && prefill?.duplicate && (
            <div
              style={{
                borderRadius: 10,
                padding: "10px 12px",
                background: "var(--hover, rgba(255,255,255,.04))",
                border: "1px solid var(--red)55",
                fontSize: 12.5,
                lineHeight: 1.45,
              }}
            >
              <span style={{ color: "var(--red)", fontWeight: 700 }}>⚠ Redan loggad:</span>{" "}
              {prefill.duplicate.event} — {prefill.duplicate.selection}
              {prefill.importRef ? ` (Ref ${prefill.importRef})` : ""}. Spara ändå?
            </div>
          )}

          {form.externalRef && !editing && (
            <div style={{ fontSize: 12, color: "var(--pos)" }}>
              ✓ Länkad till event {form.externalRef.slice(0, 8)}… — kan auto-rättas vid synk.
            </div>
          )}
          {form.resultEventRef && (
            <div style={{ fontSize: 12, color: "var(--pos)" }}>
              Länkad till {form.resultProvider || "resultatkälla"}-match {form.resultEventRef}.
            </div>
          )}
          {error && <div style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>}

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button className="ap-btn ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onClose}>Avbryt</button>
            <button className="ap-btn" style={{ flex: 2, justifyContent: "center" }} onClick={submit} disabled={saving}>
              {saving ? "Sparar…" : editing ? "Spara ändringar" : "Spara bet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
