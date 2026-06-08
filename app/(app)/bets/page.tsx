"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { ResultBadge } from "@/components/ResultBadge";
import { AddBetModal } from "@/components/AddBetModal";
import { useBets } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import { uFmt, pctFmt, krShort, sportTag, dateShort } from "@/lib/format";
import { computeMetrics, type BetLike, type Outcome } from "@/lib/betting";
import { I, IC } from "@/components/icons";
import type { BetDTO } from "@/lib/types";

const GRID = "62px 46px 1.5fr 1.1fr 92px 64px 52px 70px 80px 96px";
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
  const [q, setQ] = useState("");
  const [sport, setSport] = useState("Alla sporter");
  const [book, setBook] = useState("Alla bookmakers");
  const [res, setRes] = useState("alla");
  const [day, setDay] = useState(""); // YYYY-MM-DD, specific day
  const [year, setYear] = useState("Alla år");
  const [month, setMonth] = useState("Alla månader");

  const hasKey = settings?.hasOddsApiKey ?? false;
  const unit = settings?.unitValue ?? 100;

  const sports = useMemo(() => Array.from(new Set(bets.map((b) => b.sport).filter(Boolean))) as string[], [bets]);
  const books = useMemo(() => Array.from(new Set(bets.map((b) => b.bookmaker).filter(Boolean))) as string[], [bets]);
  const years = useMemo(
    () => Array.from(new Set(bets.map((b) => new Date(b.eventAt ?? b.placedAt).getFullYear()))).sort((a, b) => b - a).map(String),
    [bets]
  );
  const rangeLabel = years.length ? (years[0] === years[years.length - 1] ? years[0] : `${years[years.length - 1]}–${years[0]}`) : "";

  const filtered = useMemo(() => {
    return bets.filter((b) => {
      if (sport !== "Alla sporter" && b.sport !== sport) return false;
      if (book !== "Alla bookmakers" && b.bookmaker !== book) return false;
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
        const s = `${b.event} ${b.league ?? ""} ${b.selection} ${b.bookmaker ?? ""}`.toLowerCase();
        if (!s.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [bets, sport, book, res, q, day, year, month]);

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
    await api.post(`/api/bets/${id}/settle`, { outcome });
    reload();
  };
  const del = async (b: BetDTO) => {
    if (!confirm(`Ta bort betet "${b.event}"?`)) return;
    await api.del(`/api/bets/${b.id}`);
    reload();
  };

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
      <div className="ap-grid ap-kpi-row">
        <div className="ap-card"><span className="ap-label">Filtrerad P/L</span><div className="ap-num ap-kpi-val"><span className={metrics.profitUnits >= 0 ? "pos" : "neg"}>{uFmt(metrics.profitUnits, true)}</span></div></div>
        <div className="ap-card"><span className="ap-label">ROI</span><div className="ap-num ap-kpi-val"><span className={(metrics.roiPct ?? 0) >= 0 ? "pos" : "neg"}>{pctFmt(metrics.roiPct, true)}</span></div></div>
        <div className="ap-card"><span className="ap-label">Win rate</span><div className="ap-num ap-kpi-val">{pctFmt(metrics.winRatePct)}</div></div>
        <div className="ap-card"><span className="ap-label">Antal bets</span><div className="ap-num ap-kpi-val">{filtered.length}</div></div>
      </div>

      {/* filters */}
      <div className="ap-filters">
        <div className="ap-search">
          <I p={IC.search} size={16} />
          <input placeholder="Sök match, liga, spel eller bookmaker…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {sel(sport, setSport, ["Alla sporter", ...sports])}
        {sel(book, setBook, ["Alla bookmakers", ...books])}
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
        <div style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--dim)", alignSelf: "center" }}>
          Visar <strong style={{ color: "var(--txt)" }}>{filtered.length}</strong> av {bets.length} bets
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
              <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--dim2)", fontSize: 14 }}>Inga bets matchar filtren.</div>
            )}
            {filtered.map((b) => (
              <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: GRID }}>
                <span style={{ color: "var(--dim)" }}>{dateShort(b.eventAt ?? b.placedAt)}</span>
                <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
                <span className="ap-ell">{b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}</span>
                <span className="ap-ell ap-hide-sm" style={{ color: "var(--dim)" }}>{b.selection || "—"}</span>
                <span className="ap-hide-sm" style={{ color: "var(--dim)" }}>{b.bookmaker || "—"}</span>
                <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                <span className="ap-r ap-num">{b.stakeUnits.toFixed(2)}U</span>
                <span className={"ap-r ap-num " + (b.outcome === "pending" ? "" : (b.profitUnits ?? 0) >= 0 ? "pos" : "neg")}>{b.outcome === "pending" ? "—" : krShort((b.profitUnits ?? 0) * unit, true)}</span>
                <span className="ap-r"><ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} /></span>
                <span className="ap-c" style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  {b.outcome === "pending" && (
                    <>
                      <button className="ap-iconbtn w" title="Vunnen" onClick={() => settle(b.id, "win")}>W</button>
                      <button className="ap-iconbtn l" title="Förlorad" onClick={() => settle(b.id, "loss")}>L</button>
                    </>
                  )}
                  <button className="ap-iconbtn x" title="Ta bort" onClick={() => del(b)}>✕</button>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* cards (mobile) */}
      <div className="ap-betcards">
        {loading && <div className="ap-betcard-empty">Laddar…</div>}
        {!loading && filtered.length === 0 && <div className="ap-betcard-empty">Inga bets matchar filtren.</div>}
        {!loading && filtered.map((b) => (
          <div key={b.id} className="ap-betcard">
            <div className="ap-betcard-top">
              <span className="ap-betcard-date">
                {dateShort(b.eventAt ?? b.placedAt)} <span className="ap-tag">{sportTag(b.sport)}</span>
              </span>
              <ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} />
            </div>
            <div className="ap-betcard-event">
              {b.event}{b.league && <span style={{ color: "var(--dim2)" }}> · {b.league}</span>}
            </div>
            <div className="ap-betcard-sel">
              {b.selection || "—"}{b.bookmaker ? ` · ${b.bookmaker}` : ""}
            </div>
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
                {b.outcome === "pending" && (
                  <>
                    <button className="ap-iconbtn w" title="Vunnen" onClick={() => settle(b.id, "win")}>W</button>
                    <button className="ap-iconbtn l" title="Förlorad" onClick={() => settle(b.id, "loss")}>L</button>
                  </>
                )}
                <button className="ap-iconbtn x" title="Ta bort" onClick={() => del(b)}>✕</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <AddBetModal open={adding} onClose={() => setAdding(false)} onSaved={reload} hasOddsApiKey={hasKey} />
    </div>
  );
}
