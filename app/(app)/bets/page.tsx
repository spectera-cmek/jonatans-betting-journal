"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty } from "@/components/ui";
import { ResultBadge } from "@/components/ResultBadge";
import { AddBetModal } from "@/components/AddBetModal";
import { useBets } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import { uFmt, pctFmt, krFmt, krShort, sportTag, dateShort, daysAgo } from "@/lib/format";
import { computeMetrics, openRisk, type BetLike, type Outcome } from "@/lib/betting";
import { I, IC } from "@/components/icons";
import { SCOPES, SCOPE_LABELS } from "@/lib/constants";
import type { BetDTO, BetListDTO } from "@/lib/types";

const GRID = "62px 46px 1.5fr 1.1fr 92px 64px 52px 70px 80px 116px";
const PAGE = 100;
const RES_CHIPS: [string, string][] = [
  ["alla", "Alla"],
  ["pending", "Öppna"],
  ["win", "Vunna"],
  ["loss", "Förlorade"],
  ["push", "Push"],
];
const MONTHS_SV = ["Januari", "Februari", "Mars", "April", "Maj", "Juni", "Juli", "Augusti", "September", "Oktober", "November", "December"];

export default function BetsPage() {
  const { bets, settings, loading, reload } = useBets();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BetDTO | null>(null);
  const [q, setQ] = useState("");
  const [sport, setSport] = useState("Alla sporter");
  const [book, setBook] = useState("Alla bookmakers");
  const [market, setMarket] = useState(""); // detaljerad marknad (marketCategory)
  const [scope, setScope] = useState(""); // player | team | match
  const [res, setRes] = useState("alla");
  const [day, setDay] = useState(""); // YYYY-MM-DD, specific day
  const [year, setYear] = useState("Alla år");
  const [month, setMonth] = useState("Alla månader");
  const [sort, setSort] = useState<"date" | "stake">("date");
  const [shown, setShown] = useState(PAGE);

  // Mirror filters in the URL query so a filtered view is shareable and survives
  // reload. Read once on mount; the first write is skipped so it can't clobber.
  const urlSynced = useRef(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("q")) setQ(sp.get("q") || "");
    if (sp.has("sport")) setSport(sp.get("sport") || "Alla sporter");
    if (sp.has("book")) setBook(sp.get("book") || "Alla bookmakers");
    if (sp.has("market")) setMarket(sp.get("market") || "");
    if (sp.has("scope")) setScope(sp.get("scope") || "");
    if (sp.has("res")) setRes(sp.get("res") || "alla");
    if (sp.has("day")) setDay(sp.get("day") || "");
    if (sp.has("year")) setYear(sp.get("year") || "Alla år");
    if (sp.has("month")) setMonth(sp.get("month") || "Alla månader");
    if (sp.has("sort")) setSort(sp.get("sort") === "stake" ? "stake" : "date");
  }, []);
  useEffect(() => {
    if (!urlSynced.current) {
      urlSynced.current = true;
      return;
    }
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (sport !== "Alla sporter") sp.set("sport", sport);
    if (book !== "Alla bookmakers") sp.set("book", book);
    if (market) sp.set("market", market);
    if (scope) sp.set("scope", scope);
    if (res !== "alla") sp.set("res", res);
    if (day) sp.set("day", day);
    if (year !== "Alla år") sp.set("year", year);
    if (month !== "Alla månader") sp.set("month", month);
    if (sort !== "date") sp.set("sort", sort);
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [q, sport, book, market, scope, res, day, year, month, sort]);

  const hasKey = settings?.hasOddsApiKey ?? false;
  const unit = settings?.unitValue ?? 100;

  const sports = useMemo(() => Array.from(new Set(bets.map((b) => b.sport).filter(Boolean))) as string[], [bets]);
  const books = useMemo(() => Array.from(new Set(bets.map((b) => b.bookmaker).filter(Boolean))) as string[], [bets]);
  const markets = useMemo(
    () =>
      (Array.from(new Set(bets.map((b) => b.marketCategory).filter(Boolean))) as string[])
        .sort((a, b) => a.localeCompare(b, "sv")),
    [bets]
  );
  // Only offer scopes that actually occur in the data.
  const scopes = useMemo(
    () => SCOPES.filter((sc) => bets.some((b) => b.marketScope === sc.value)),
    [bets]
  );
  const years = useMemo(
    () => Array.from(new Set(bets.map((b) => new Date(b.eventAt ?? b.placedAt).getFullYear()))).sort((a, b) => b - a).map(String),
    [bets]
  );
  const rangeLabel = years.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[years.length - 1]}–${years[0]}`) : "";

  const filtered = useMemo(() => {
    return bets.filter((b) => {
      if (sport !== "Alla sporter" && b.sport !== sport) return false;
      if (book !== "Alla bookmakers" && b.bookmaker !== book) return false;
      if (market && b.marketCategory !== market) return false;
      if (scope && b.marketScope !== scope) return false;
      if (res === "win" && !(b.outcome === "win" || b.outcome === "half_win")) return false;
      if (res === "loss" && !(b.outcome === "loss" || b.outcome === "half_loss")) return false;
      if (res === "pending" && b.outcome !== "pending") return false;
      if (res === "push" && !(b.outcome === "push" || b.outcome === "void")) return false;
      const d = new Date(b.eventAt ?? b.placedAt);
      if (day) {
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (iso !== day) return false;
      } else {
        if (year !== "Alla år" && String(d.getFullYear()) !== year) return false;
        if (month !== "Alla månader" && String(d.getMonth() + 1) !== month) return false;
      }
      if (q) {
        const s = `${b.event} ${b.league ?? ""} ${b.selection} ${b.bookmaker ?? ""} ${b.marketCategory ?? ""} ${b.marketScope ? SCOPE_LABELS[b.marketScope] ?? "" : ""}`.toLowerCase();
        if (!s.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [bets, sport, book, market, scope, res, q, day, year, month]);

  // Sorting is a separate concern from filtering — keep `filtered` in its
  // natural (date) order for the summary stats and only reorder for display.
  const sorted = useMemo(() => {
    if (sort !== "stake") return filtered;
    return [...filtered].sort((a, b) => b.stakeUnits - a.stakeUnits);
  }, [filtered, sort]);

  // Render at most `shown` rows; reset when any filter or sort changes.
  useEffect(() => {
    setShown(PAGE);
  }, [sport, book, market, scope, res, q, day, year, month, sort]);
  const visible = useMemo(() => sorted.slice(0, shown), [sorted, shown]);
  const remaining = sorted.length - visible.length;

  const metrics = useMemo(() => {
    const likes: BetLike[] = filtered.map((b) => ({
      odds: b.odds,
      stakeUnits: b.stakeUnits,
      outcome: b.outcome as Outcome,
      closingOdds: null,
      profitUnits: b.profitUnits,
    }));
    return computeMetrics(likes);
  }, [filtered]);

  // Stake still at risk within the current filter (any combo, not just the
  // "Öppna" chip) — computeMetrics() above zeroes out pending bets, so this
  // is the only place that answers "how much money is still in play here".
  const openInFilter = useMemo(() => {
    const likes: BetLike[] = filtered.map((b) => ({
      odds: b.odds,
      stakeUnits: b.stakeUnits,
      outcome: b.outcome as Outcome,
      closingOdds: null,
      profitUnits: b.profitUnits,
    }));
    return openRisk(likes);
  }, [filtered]);

  const sel = (val: string, set: (v: string) => void, opts: string[]) => (
    <div className="ap-select">
      <select value={val} onChange={(e) => set(e.target.value)}>
        {opts.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );

  const settle = async (id: string, outcome: string) => {
    await api.post(`/api/bets/${id}/settle`, { outcome });
    reload();
  };
  const del = async (b: BetListDTO) => {
    if (!confirm(`Ta bort betet "${b.event}"?`)) return;
    await api.del(`/api/bets/${b.id}`);
    reload();
  };
  // One-click VM 2026 tag toggle (stored in the league field; drives the VM 2026 page).
  const toggleVM = async (b: BetListDTO) => {
    const isVM = (b.league ?? "").trim() === "VM 2026";
    await api.patch(`/api/bets/${b.id}`, { league: isVM ? null : "VM 2026" });
    reload();
  };
  const openEdit = async (b: BetListDTO) => {
    try {
      const full = await api.get<BetDTO>(`/api/bets/${b.id}`);
      setEditing(full);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const rowActions = (b: BetListDTO) => (
    <>
      {b.outcome === "pending" && (
        <>
          <button className="ap-iconbtn w" title="Vunnen" onClick={() => settle(b.id, "win")}>W</button>
          <button className="ap-iconbtn l" title="Förlorad" onClick={() => settle(b.id, "loss")}>L</button>
          <button className="ap-iconbtn" title="Push (insats tillbaka)" onClick={() => settle(b.id, "push")}>P</button>
        </>
      )}
      <button
        className="ap-iconbtn"
        title={(b.league ?? "").trim() === "VM 2026" ? "Ta bort VM 2026-tagg" : "Tagga som VM 2026"}
        style={{ opacity: (b.league ?? "").trim() === "VM 2026" ? 1 : 0.38 }}
        onClick={() => toggleVM(b)}
      >🏆</button>
      <button className="ap-iconbtn" title="Redigera" onClick={() => openEdit(b)}>✎</button>
      <button className="ap-iconbtn x" title="Ta bort" onClick={() => del(b)}>✕</button>
    </>
  );

  return (
    <div>
      <Topbar
        title="Alla bets"
        sub={`${bets.length} bets loggade${rangeLabel ? ` · ${rangeLabel}` : ""}`}
        actions={
          <>
            <a className="ap-btn ghost" href="/api/bets/export"><I p={IC.download} size={15} /><span className="ap-hide-sm">CSV</span></a>
            <button className="ap-btn" onClick={() => setAdding(true)}><I p={IC.plus} size={15} /><span className="ap-hide-sm">Logga bet</span></button>
          </>
        }
      />

      {/* summary strip */}
      <div className="ap-grid ap-kpi-row ap-kpi-row-5">
        <div className="ap-card"><span className="ap-label">Filtrerad P/L</span><div className="ap-num ap-kpi-val"><span className={metrics.profitUnits >= 0 ? "pos" : "neg"}>{uFmt(metrics.profitUnits, true)}</span></div></div>
        <div className="ap-card"><span className="ap-label">ROI</span><div className="ap-num ap-kpi-val"><span className={(metrics.roiPct ?? 0) >= 0 ? "pos" : "neg"}>{pctFmt(metrics.roiPct, true)}</span></div></div>
        <div className="ap-card"><span className="ap-label">Win rate</span><div className="ap-num ap-kpi-val">{pctFmt(metrics.winRatePct)}</div></div>
        <div className="ap-card"><span className="ap-label">Antal bets</span><div className="ap-num ap-kpi-val">{filtered.length}</div></div>
        <div className="ap-card">
          <span className="ap-label">Insats i spel</span>
          <div className="ap-num ap-kpi-val">{krFmt(openInFilter.stakeUnits * unit)}</div>
          {openInFilter.bets > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4 }}>
              {openInFilter.bets} öppna · retur {krFmt(openInFilter.potentialReturnUnits * unit)}
            </div>
          )}
        </div>
      </div>

      {/* filters */}
      <div className="ap-filters">
        <div className="ap-search">
          <I p={IC.search} size={16} />
          <input placeholder="Sök match, liga, spel eller bookmaker…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {sel(sport, setSport, ["Alla sporter", ...sports])}
        {sel(book, setBook, ["Alla bookmakers", ...books])}
        <div className="ap-select">
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">Alla marknader</option>
            {markets.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        {scopes.length > 0 && (
          <div className="ap-select">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Spelare / lag / match</option>
              {scopes.map((sc) => <option key={sc.value} value={sc.value}>{sc.label}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="ap-filters">
        <div className="ap-select">
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            style={{ background: "transparent", border: "none", color: "var(--txt)", font: "inherit", outline: "none" }}
          />
        </div>
        {sel(year, setYear, ["Alla år", ...years])}
        <div className="ap-select">
          <select value={month} onChange={(e) => setMonth(e.target.value)} disabled={!!day}>
            <option value="Alla månader">Alla månader</option>
            {MONTHS_SV.map((label, i) => <option key={label} value={String(i + 1)}>{label}</option>)}
          </select>
        </div>
        {(day || year !== "Alla år" || month !== "Alla månader") && (
          <button className="ap-chip" onClick={() => { setDay(""); setYear("Alla år"); setMonth("Alla månader"); }}>Rensa datum</button>
        )}
      </div>
      <div className="ap-filters">
        {RES_CHIPS.map(([v, l]) => (
          <button key={v} className={"ap-chip" + (res === v ? " is-active" : "")} onClick={() => setRes(v)}>{l}</button>
        ))}
        <div className="ap-select">
          <select value={sort} onChange={(e) => setSort(e.target.value === "stake" ? "stake" : "date")}>
            <option value="date">Sortera: Datum</option>
            <option value="stake">Sortera: Insats, störst → minst</option>
          </select>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--dim)", alignSelf: "center" }}>
          Visar <strong style={{ color: "var(--txt)" }}>{Math.min(visible.length, filtered.length)}</strong> av {filtered.length} träffar
        </div>
      </div>

      {/* table (desktop / tablet) */}
      <div className="ap-table-wrap">
        <Card style={{ padding: 0 }}>
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: GRID }}>
              <span>Datum</span><span>Sport</span><span>Match</span><span className="ap-hide-sm">Spel</span><span className="ap-hide-sm">Bookmaker</span><span className="ap-r">Odds</span><span className="ap-r">Insats</span><span className="ap-r">P/L</span><span className="ap-r">Resultat</span><span className="ap-c">·</span>
            </div>
            {loading && <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--dim2)", fontSize: 14 }}>Laddar…</div>}
            {!loading && filtered.length === 0 && (
              <Empty
                icon={<I p={IC.search} />}
                title="Inga bets matchar filtren"
                hint="Justera sökningen eller rensa filtren för att se fler."
              />
            )}
            {visible.map((b) => (
              <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: GRID }}>
                <span style={{ color: "var(--dim)", display: "flex", flexDirection: "column", gap: 2, justifyContent: "center" }}>
                  {dateShort(b.eventAt ?? b.placedAt)}
                  {b.outcome === "pending" && (
                    <span className="ap-pill flat" style={{ padding: "1px 5px", fontSize: 10, alignSelf: "flex-start" }}>{daysAgo(b.placedAt)}d</span>
                  )}
                </span>
                <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
                <span className="ap-ell">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</span>
                <span className="ap-ell ap-hide-sm" style={{ color: "var(--dim)", display: "flex", flexDirection: "column", gap: 2, justifyContent: "center" }}>
                  <span className="ap-ell">{b.selection || "—"}</span>
                  {b.marketCategory && (
                    <span className="ap-ell" style={{ fontSize: 11, color: "var(--dim2)" }}>
                      {b.marketCategory}{b.marketScope ? ` · ${SCOPE_LABELS[b.marketScope] ?? b.marketScope}` : ""}
                    </span>
                  )}
                </span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)" }}>{b.bookmaker || "—"}</span>
                <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                <span className="ap-r ap-num">{b.stakeUnits.toFixed(2)}U</span>
                <span className={"ap-r ap-num " + (b.outcome === "pending" ? "" : (b.profitUnits ?? 0) >= 0 ? "pos" : "neg")}>{b.outcome === "pending" ? "—" : krShort((b.profitUnits ?? 0) * unit, true)}</span>
                <span className="ap-r"><ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} /></span>
                <span className="ap-c" style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  {rowActions(b)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* cards (mobile) */}
      <div className="ap-betcards">
        {loading && <div className="ap-betcard-empty">Laddar…</div>}
        {!loading && filtered.length === 0 && (
          <Empty
            icon={<I p={IC.search} />}
            title="Inga bets matchar filtren"
            hint="Justera sökningen eller rensa filtren för att se fler."
          />
        )}
        {!loading && visible.map((b) => (
          <div key={b.id} className="ap-betcard">
            <div className="ap-betcard-top">
              <span className="ap-betcard-date">
                {dateShort(b.eventAt ?? b.placedAt)} <span className="ap-tag">{sportTag(b.sport)}</span>
                {b.outcome === "pending" && (
                  <span className="ap-pill flat" style={{ marginLeft: 6 }}>{daysAgo(b.placedAt)}d</span>
                )}
              </span>
              <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
            </div>
            <div className="ap-betcard-event">
              {b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}
            </div>
            <div className="ap-betcard-sel">
              {b.selection || "—"}{b.bookmaker ? ` · ${b.bookmaker}` : ""}
            </div>
            {b.marketCategory && (
              <div className="ap-betcard-sel" style={{ fontSize: 11.5, color: "var(--dim2)", marginTop: -2 }}>
                {b.marketCategory}{b.marketScope ? ` · ${SCOPE_LABELS[b.marketScope] ?? b.marketScope}` : ""}
              </div>
            )}
            <div className="ap-betcard-stats">
              <div><span>Odds</span><b className="ap-num">{b.odds.toFixed(2)}</b></div>
              <div><span>Insats</span><b className="ap-num">{b.stakeUnits.toFixed(2)}U</b></div>
              <div>
                <span>P/L</span>
                <b className={"ap-num " + (b.outcome === "pending" ? "" : (b.profitUnits ?? 0) >= 0 ? "pos" : "neg")}>
                  {b.outcome === "pending" ? "—" : krShort((b.profitUnits ?? 0) * unit, true)}
                </b>
              </div>
              <div className="ap-betcard-act">
                {rowActions(b)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* pagination */}
      {!loading && remaining > 0 && (
        <div style={{ display: "flex", justifyContent: "center", padding: "14px 0 4px" }}>
          <button className="ap-btn ghost" onClick={() => setShown((n) => n + PAGE * 2)}>
            Visa fler ({remaining} kvar)
          </button>
        </div>
      )}

      <AddBetModal
        open={adding || !!editing}
        bet={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={reload}
        hasOddsApiKey={hasKey}
      />
    </div>
  );
}
