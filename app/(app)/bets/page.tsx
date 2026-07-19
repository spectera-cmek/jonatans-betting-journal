"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty } from "@/components/ui";
import { ResultBadge } from "@/components/ResultBadge";
import { AddBetModal, type BetPrefill } from "@/components/AddBetModal";
import { ScreenshotImportButton } from "@/components/ScreenshotImportButton";
import { BetTags } from "@/components/BetTags";
import { SettlementDialog } from "@/components/SettlementDialog";
import type { ParsedBetWithDupe } from "@/lib/betslipExtract";
import { StatTile } from "@/components/stats";
import { useBets } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import { uFmt, pctFmt, krShort, sportTag, dateShort } from "@/lib/format";
import { computeMetrics, type BetLike, type Outcome } from "@/lib/betting";
import { I, IC } from "@/components/icons";
import {
  SCOPES,
  SCOPE_LABELS,
  EVENT_KINDS,
  TOURNAMENT_STAGES,
  VM_2026_LEAGUE,
} from "@/lib/constants";
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
  const [settling, setSettling] = useState<BetListDTO | null>(null);
  // Kö av kvitto-tolkade bets som gås igenom en och en i modalen.
  const [queue, setQueue] = useState<ParsedBetWithDupe[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [q, setQ] = useState("");
  const [sport, setSport] = useState("Alla sporter");
  const [league, setLeague] = useState("");
  const [book, setBook] = useState("Alla bookmakers");
  const [market, setMarket] = useState(""); // detaljerad marknad (marketCategory)
  const [scope, setScope] = useState(""); // player | team | match
  const [eventKind, setEventKind] = useState("");
  const [stage, setStage] = useState("");
  const [res, setRes] = useState("alla");
  const [day, setDay] = useState(""); // YYYY-MM-DD, specific day
  const [year, setYear] = useState("Alla år");
  const [month, setMonth] = useState("Alla månader");
  const [shown, setShown] = useState(PAGE);
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Mirror filters in the URL query so a filtered view is shareable and survives
  // reload. Read once on mount; the first write is skipped so it can't clobber.
  const urlSynced = useRef(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("q")) setQ(sp.get("q") || "");
    if (sp.has("sport")) setSport(sp.get("sport") || "Alla sporter");
    if (sp.has("league")) setLeague(sp.get("league") || "");
    if (sp.has("book")) setBook(sp.get("book") || "Alla bookmakers");
    if (sp.has("market")) setMarket(sp.get("market") || "");
    if (sp.has("scope")) setScope(sp.get("scope") || "");
    if (sp.has("eventKind")) setEventKind(sp.get("eventKind") || "");
    if (sp.has("stage")) setStage(sp.get("stage") || "");
    if (sp.has("res")) setRes(sp.get("res") || "alla");
    if (sp.has("day")) setDay(sp.get("day") || "");
    if (sp.has("year")) setYear(sp.get("year") || "Alla år");
    if (sp.has("month")) setMonth(sp.get("month") || "Alla månader");
    if (sp.has("sort")) setSortOrder((sp.get("sort") as "desc" | "asc") || "desc");
  }, []);
  useEffect(() => {
    if (!urlSynced.current) {
      urlSynced.current = true;
      return;
    }
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (sport !== "Alla sporter") sp.set("sport", sport);
    if (league) sp.set("league", league);
    if (book !== "Alla bookmakers") sp.set("book", book);
    if (market) sp.set("market", market);
    if (scope) sp.set("scope", scope);
    if (eventKind) sp.set("eventKind", eventKind);
    if (stage) sp.set("stage", stage);
    if (res !== "alla") sp.set("res", res);
    if (day) sp.set("day", day);
    if (year !== "Alla år") sp.set("year", year);
    if (month !== "Alla månader") sp.set("month", month);
    if (sortOrder !== "desc") sp.set("sort", sortOrder);
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [q, sport, league, book, market, scope, eventKind, stage, res, day, year, month, sortOrder]);

  const hasKey = settings?.hasOddsApiKey ?? false;
  const unit = settings?.unitValue ?? 100;

  // Nästa kvitto-tolkade bet i kön → förifyllning för modalen (kr → units här).
  const prefill = useMemo<BetPrefill | null>(() => {
    const p = queue[queueIndex];
    if (!p) return null;
    const form: BetPrefill["form"] = {
      eventAt: (p.eventAt ?? p.placedAt ?? new Date().toISOString()).slice(0, 10),
      event: p.event,
      selection: p.selection,
      market: p.market,
      odds: p.odds != null ? String(p.odds) : "",
      stakeUnits: p.stakeKr != null ? String(+(p.stakeKr / unit).toFixed(2)) : "",
    };
    if (p.sport) form.sport = p.sport;
    if (p.league) form.league = p.league;
    if (p.homeTeam) form.homeTeam = p.homeTeam;
    if (p.awayTeam) form.awayTeam = p.awayTeam;
    if (p.marketCategory) form.marketCategory = p.marketCategory;
    if (p.marketScope) form.marketScope = p.marketScope;
    if (p.selectionSide) form.selectionSide = p.selectionSide;
    if (p.line != null) form.line = String(p.line);
    if (p.bookmaker) form.bookmaker = p.bookmaker;
    return {
      form,
      importRef: p.importRef,
      placedAt: p.placedAt,
      legs: p.legs && p.legs.length ? p.legs : undefined,
      betType: p.betType === "accumulator" ? "accumulator" : undefined,
      duplicate: p.duplicate,
      queue: { index: queueIndex, total: queue.length },
    };
  }, [queue, queueIndex, unit]);

  const closeModal = () => {
    setAdding(false);
    setEditing(null);
    // Kvitto-kön: gå vidare till nästa bet, eller töm när sista är hanterad.
    if (queue.length) {
      if (queueIndex + 1 < queue.length) setQueueIndex(queueIndex + 1);
      else {
        setQueue([]);
        setQueueIndex(0);
      }
    }
  };

  const sports = useMemo(() => Array.from(new Set(bets.map((b) => b.sport).filter(Boolean))) as string[], [bets]);
  const leagues = useMemo(
    () => (Array.from(new Set(bets.map((b) => b.league).filter(Boolean))) as string[]).sort((a, b) => a.localeCompare(b, "sv")),
    [bets]
  );
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
      if (league && b.league !== league) return false;
      if (book !== "Alla bookmakers" && b.bookmaker !== book) return false;
      if (market && b.marketCategory !== market) return false;
      if (scope && b.marketScope !== scope) return false;
      if (eventKind && b.eventKind !== eventKind) return false;
      if (stage && b.tournamentStage !== stage) return false;
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
        const s = `${b.event} ${b.league ?? ""} ${b.selection} ${b.bookmaker ?? ""} ${b.marketCategory ?? ""} ${b.marketScope ? SCOPE_LABELS[b.marketScope] ?? "" : ""} ${b.eventKind} ${b.tournamentStage ?? ""}`.toLowerCase();
        if (!s.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [bets, sport, league, book, market, scope, eventKind, stage, res, q, day, year, month]);

  // Render at most `shown` rows; reset when any filter or sort order changes.
  useEffect(() => {
    setShown(PAGE);
  }, [sport, league, book, market, scope, eventKind, stage, res, q, day, year, month, sortOrder]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      const da = new Date(a.eventAt ?? a.placedAt).getTime();
      const db = new Date(b.eventAt ?? b.placedAt).getTime();
      return sortOrder === "desc" ? db - da : da - db;
    });
    return list;
  }, [filtered, sortOrder]);

  const visible = useMemo(() => sorted.slice(0, shown), [sorted, shown]);
  const remaining = sorted.length - visible.length;
  const advancedCount = [
    sport !== "Alla sporter",
    !!league,
    book !== "Alla bookmakers",
    !!market,
    !!scope,
    !!eventKind,
    !!stage,
    !!day,
    year !== "Alla år",
    month !== "Alla månader",
  ].filter(Boolean).length;

  const clearAdvanced = () => {
    setSport("Alla sporter");
    setLeague("");
    setBook("Alla bookmakers");
    setMarket("");
    setScope("");
    setEventKind("");
    setStage("");
    setDay("");
    setYear("Alla år");
    setMonth("Alla månader");
  };

  const metrics = useMemo(() => {
    const likes: BetLike[] = filtered.map((b) => ({
      odds: b.odds,
      stakeUnits: b.stakeUnits,
      outcome: b.outcome as Outcome,
      closingOdds: b.closingOdds,
      profitUnits: b.profitUnits,
    }));
    return computeMetrics(likes);
  }, [filtered]);

  const sel = (val: string, set: (v: string) => void, opts: string[]) => (
    <div className="ap-select">
      <select value={val} onChange={(e) => set(e.target.value)}>
        {opts.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );

  const settle = async (id: string, outcome: string) => {
    try {
      await api.post(`/api/bets/${id}/settle`, {
        outcome,
        reason: "Snabbrättning i betlistan",
      });
      reload();
    } catch (error) {
      alert((error as Error).message);
    }
  };
  const del = async (b: BetListDTO) => {
    if (!confirm(`Ta bort betet "${b.event}"?`)) return;
    await api.del(`/api/bets/${b.id}`);
    reload();
  };
  // One-click VM 2026 tag toggle (stored in the league field; drives the VM 2026 page).
  const toggleVM = async (b: BetListDTO) => {
    const isVM = (b.league ?? "").trim() === VM_2026_LEAGUE;
    await api.patch(`/api/bets/${b.id}`, { league: isVM ? null : VM_2026_LEAGUE });
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
          <button className="ap-iconbtn w" title="Markera som vunnen" aria-label="Markera som vunnen" onClick={() => settle(b.id, "win")}>
            <I p={IC.check} size={14} />
          </button>
          <button className="ap-iconbtn l" title="Markera som förlorad" aria-label="Markera som förlorad" onClick={() => settle(b.id, "loss")}>
            <I p={IC.closeCircle} size={14} />
          </button>
        </>
      )}
      <button
        className="ap-iconbtn"
        title={b.outcome === "pending" ? "Fler rättningsalternativ" : "Historik, ångra eller korrigera"}
        aria-label={b.outcome === "pending" ? "Fler rättningsalternativ" : "Historik, ångra eller korrigera"}
        onClick={() => setSettling(b)}
      >
        <I p={IC.menu} size={14} />
      </button>
      <button
        className="ap-iconbtn"
        title={(b.league ?? "").trim() === VM_2026_LEAGUE ? "Ta bort VM 2026-tagg" : "Tagga som VM 2026"}
        aria-label={(b.league ?? "").trim() === VM_2026_LEAGUE ? "Ta bort VM 2026-tagg" : "Tagga som VM 2026"}
        style={{ opacity: (b.league ?? "").trim() === VM_2026_LEAGUE ? 1 : 0.38 }}
        onClick={() => toggleVM(b)}
      >
        <I p={IC.trophy} size={14} />
      </button>
      <button className="ap-iconbtn" title="Redigera" aria-label="Redigera" onClick={() => openEdit(b)}>
        <I p={IC.edit} size={14} />
      </button>
      <button className="ap-iconbtn x" title="Ta bort" aria-label="Ta bort" onClick={() => del(b)}>
        <I p={IC.trash} size={14} />
      </button>
    </>
  );

  return (
    <div className="ap-ledger">
      <div className="ap-page-kicker">
        <span>Ledger / Bet history</span>
        <em>{rangeLabel || new Date().getFullYear()}</em>
      </div>
      <Topbar
        title="Alla bets"
        sub={`${bets.length} bets loggade${rangeLabel ? ` · ${rangeLabel}` : ""}`}
        icon={<I p={IC.ticket} />}
        actions={
          <>
            <a className="ap-btn ghost" href="/api/bets/export"><I p={IC.download} size={15} /><span className="ap-hide-sm">CSV</span></a>
            <ScreenshotImportButton onParsed={(bets) => { setQueue(bets); setQueueIndex(0); }} />
          </>
        }
      />

      {/* summary strip */}
      <div className="ap-grid ap-kpi-row">
        <StatTile label="Filtrerad P/L" value={uFmt(metrics.profitUnits, true)} tone={metrics.profitUnits >= 0 ? "pos" : "neg"} />
        <StatTile label="ROI" value={pctFmt(metrics.roiPct, true)} tone={(metrics.roiPct ?? 0) >= 0 ? "pos" : "neg"} />
        <StatTile label="Win rate" value={pctFmt(metrics.winRatePct)} />
        <StatTile label="Antal bets" value={String(filtered.length)} />
      </div>

      {/* filters */}
      <div className="ap-filterbar">
        <div className="ap-search">
          <I p={IC.search} size={16} />
          <input placeholder="Sök match, liga, spel eller bookmaker…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={"ap-btn ghost ap-filter-toggle" + (advancedOpen ? " is-active" : "")} onClick={() => setAdvancedOpen((open) => !open)}>
          <I p={IC.menu} size={15} />
          Filter{advancedCount > 0 ? ` (${advancedCount})` : ""}
        </button>
        <div className="ap-select">
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as "desc" | "asc")}>
            <option value="desc">Nyast först</option>
            <option value="asc">Äldst först</option>
          </select>
        </div>
      </div>

      <div className="ap-filter-summary">
        <div className="ap-filters" style={{ marginBottom: 0 }}>
          {RES_CHIPS.map(([v, l]) => (
            <button key={v} className={"ap-chip" + (res === v ? " is-active" : "")} onClick={() => setRes(v)}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {advancedCount > 0 && <button className="ap-link" onClick={clearAdvanced}>Rensa {advancedCount} filter</button>}
          <span style={{ fontSize: 12.5, color: "var(--dim)" }}>
            <strong style={{ color: "var(--txt)" }}>{Math.min(visible.length, filtered.length)}</strong> av {filtered.length}
          </span>
        </div>
      </div>

      {advancedOpen && (
        <div className="ap-filter-panel">
          <div className="ap-filter-panel-head">
            <div>
              <div className="ap-card-title">Fler filter</div>
              <div className="ap-sub">Avgränsa sport, marknad, bookmaker eller datum.</div>
            </div>
            {advancedCount > 0 && <button className="ap-link" onClick={clearAdvanced}>Rensa alla</button>}
          </div>
          <div className="ap-filter-grid">
            {sel(sport, setSport, ["Alla sporter", ...sports])}
            <div className="ap-select">
              <select value={league} onChange={(e) => setLeague(e.target.value)}>
                <option value="">Alla ligor/turneringar</option>
                {leagues.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
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
            <div className="ap-select">
              <select value={eventKind} onChange={(e) => setEventKind(e.target.value)}>
                <option value="">Match + turneringsspel</option>
                {EVENT_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
              </select>
            </div>
            <div className="ap-select">
              <select value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">Alla turneringsfaser</option>
                {TOURNAMENT_STAGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div className="ap-select ap-date-filter">
              <input
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </div>
            {sel(year, setYear, ["Alla år", ...years])}
            <div className="ap-select">
              <select value={month} onChange={(e) => setMonth(e.target.value)} disabled={!!day}>
                <option value="Alla månader">Alla månader</option>
                {MONTHS_SV.map((label, i) => <option key={label} value={String(i + 1)}>{label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

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
              <div key={b.id} className={`ap-trow ap-bet-row ${betTone(b.outcome)}`} style={{ gridTemplateColumns: GRID }}>
                <span style={{ color: "var(--dim)" }}>{dateShort(b.eventAt ?? b.placedAt)}</span>
                <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
                <span className="ap-ell">{b.event}</span>
                <span className="ap-ell ap-hide-sm" style={{ color: "var(--dim)", display: "flex", flexDirection: "column", gap: 2, justifyContent: "center" }}>
                  <span className="ap-ell">{b.selection || "—"}</span>
                  <BetTags bet={b} compact hideSport />
                </span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)" }}>{b.bookmaker || "—"}</span>
                <span className="ap-r ap-num" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, justifyContent: "center" }}>
                  <span>{b.odds.toFixed(2)}</span>
                  {b.clvPct != null && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: b.clvPct >= 0 ? "var(--pos)" : "var(--red)" }}>
                      {b.clvPct >= 0 ? "+" : ""}{b.clvPct.toFixed(1)}%
                    </span>
                  )}
                </span>
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
          <div key={b.id} className={`ap-betcard ${betTone(b.outcome)}`}>
            <div className="ap-betcard-top">
              <span className="ap-betcard-date">
                {dateShort(b.eventAt ?? b.placedAt)} <span className="ap-tag">{sportTag(b.sport)}</span>
              </span>
              <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
            </div>
            <div className="ap-betcard-event">
              {b.event}
            </div>
            <div className="ap-betcard-sel">
              {b.selection || "—"}{b.bookmaker ? ` · ${b.bookmaker}` : ""}
            </div>
            <BetTags bet={b} compact />
            <div className="ap-betcard-stats">
              <div>
                <span>Odds</span>
                <b className="ap-num">{b.odds.toFixed(2)}</b>
                {b.clvPct != null && (
                  <span style={{ display: "block", fontSize: 11, fontWeight: 600, marginTop: 2, color: b.clvPct >= 0 ? "var(--pos)" : "var(--red)" }}>
                    CLV {b.clvPct >= 0 ? "+" : ""}{b.clvPct.toFixed(1)}%
                  </span>
                )}
              </div>
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
        open={adding || !!editing || !!prefill}
        bet={editing}
        prefill={editing ? null : prefill}
        onClose={closeModal}
        onSaved={reload}
        hasOddsApiKey={hasKey}
      />
      <SettlementDialog
        bet={settling}
        onClose={() => setSettling(null)}
        onChanged={reload}
      />
    </div>
  );
}

function betTone(outcome: string) {
  if (outcome === "win" || outcome === "half_win") return "is-win";
  if (outcome === "loss" || outcome === "half_loss") return "is-loss";
  if (outcome === "pending") return "is-open";
  return "is-neutral";
}
