"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { SPORTS, MARKETS, SIDES, BOOKMAKERS, OUTCOMES } from "@/lib/constants";
import { inferSelection } from "@/lib/grading";
import { krFmt } from "@/lib/format";
import { I, IC } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  hasOddsApiKey: boolean;
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
  selection: "",
  selectionSide: "home",
  line: "",
  odds: "1.95",
  stakeUnits: "1",
  outcome: "pending",
  bookmaker: "Unibet",
  tipster: "",
  externalRef: "",
  notes: "",
};
type Form = typeof empty;

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

export function AddBetModal({ open, onClose, onSaved, hasOddsApiKey }: Props) {
  const [form, setForm] = useState<Form>(empty);
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
      setForm({ ...empty, eventAt: today() });
      setError(null);
      setShowSearch(false);
      setSearchResults([]);
      setTimeout(() => firstField.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      await api.post("/api/bets", {
        ...form,
        line: form.line === "" ? null : form.line,
        externalRef: form.externalRef || null,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sides = SIDES[form.market] || [];

  return (
    <div className="ap-overlay" onClick={onClose}>
      <div className="ap-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ap-modal-head">
          <div>
            <div className="ap-card-title" style={{ fontSize: 17 }}>Logga ny bet</div>
            <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3 }}>Fyll i detaljerna nedan</div>
          </div>
          <button className="ap-close" onClick={onClose}><I p={IC.x} size={15} /></button>
        </div>

        <div className="ap-modal-body">
          {hasOddsApiKey && (
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
                {SPORTS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
          </div>

          <div className="ap-x2">
            <div className="ap-field">
              <label>Liga</label>
              <input className="ap-input" placeholder="t.ex. Premier League" value={form.league} onChange={(e) => set("league", e.target.value)} />
            </div>
            <div className="ap-field">
              <label>Match</label>
              <input className="ap-input" placeholder="t.ex. Arsenal – Chelsea" value={form.event} onChange={(e) => set("event", e.target.value)} />
            </div>
          </div>

          <div className="ap-field">
            <label>Spel / marknad</label>
            <input className="ap-input" placeholder="t.ex. Över 2.5 mål" value={form.selection} onChange={(e) => set("selection", e.target.value)} onBlur={onSelectionBlur} />
          </div>

          <div className="ap-x2">
            <div className="ap-field">
              <label>Markandstyp</label>
              <select className="ap-input" value={form.market} onChange={(e) => set("market", e.target.value)}>
                {MARKETS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
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
                {BOOKMAKERS.map((x) => <option key={x}>{x}</option>)}
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

          <div className="ap-field">
            <label>Resultat</label>
            <div className="ap-seg2">
              {RESULT_SEG.map(([v, l]) => (
                <button key={v} className={form.outcome === v ? "is-active" : ""} onClick={() => set("outcome", v)}>{l}</button>
              ))}
            </div>
          </div>

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

          {form.externalRef && (
            <div style={{ fontSize: 12, color: "var(--pos)" }}>
              ✓ Länkad till event {form.externalRef.slice(0, 8)}… — kan auto-rättas vid synk.
            </div>
          )}
          {error && <div style={{ fontSize: 13, color: "var(--red)" }}>{error}</div>}

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button className="ap-btn ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onClose}>Avbryt</button>
            <button className="ap-btn" style={{ flex: 2, justifyContent: "center" }} onClick={submit} disabled={saving}>
              {saving ? "Sparar…" : "Spara bet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
