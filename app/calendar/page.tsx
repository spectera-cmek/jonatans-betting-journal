"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { ResultBadge } from "@/components/ResultBadge";
import { useTheme } from "@/components/ThemeProvider";
import { useBets } from "@/lib/useData";
import { krShort, uFmt, sportTag } from "@/lib/format";
import { I, IC } from "@/components/icons";

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
const MONTHS_SV = ["Januari", "Februari", "Mars", "April", "Maj", "Juni", "Juli", "Augusti", "September", "Oktober", "November", "December"];

interface DayAgg { profit: number; count: number; pending: number; settled: number }

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CalendarPage() {
  const { cc } = useTheme();
  const { bets, settings, loading } = useBets();
  const unit = settings?.unitValue ?? 100;

  // Aggregate P/L per ISO day.
  const byDay = useMemo(() => {
    const map = new Map<string, DayAgg>();
    for (const b of bets) {
      const iso = isoOf(new Date(b.eventAt ?? b.placedAt));
      const a = map.get(iso) ?? { profit: 0, count: 0, pending: 0, settled: 0 };
      a.count += 1;
      if (b.outcome === "pending") a.pending += 1;
      else { a.settled += 1; a.profit += b.profitUnits ?? 0; }
      map.set(iso, a);
    }
    return map;
  }, [bets]);

  // Default the view to the most recent bet month (fall back to today).
  const latest = useMemo(() => {
    let t = 0;
    for (const b of bets) t = Math.max(t, new Date(b.eventAt ?? b.placedAt).getTime());
    return t ? new Date(t) : new Date();
  }, [bets]);

  const [view, setView] = useState<{ y: number; m: number } | null>(null);
  const cur = view ?? { y: latest.getFullYear(), m: latest.getMonth() };
  const [selected, setSelected] = useState<string>("");

  const shift = (delta: number) => {
    const d = new Date(cur.y, cur.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
    setSelected("");
  };

  // Build the calendar grid (Monday-first) for the viewed month.
  const cells = useMemo(() => {
    const first = new Date(cur.y, cur.m, 1);
    const lead = (first.getDay() + 6) % 7; // Mon=0
    const days = new Date(cur.y, cur.m + 1, 0).getDate();
    const out: ({ iso: string; day: number } | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push({ iso: isoOf(new Date(cur.y, cur.m, d)), day: d });
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cur.y, cur.m]);

  // Month total.
  const monthTotal = useMemo(() => {
    let profit = 0, count = 0;
    for (const c of cells) {
      if (!c) continue;
      const a = byDay.get(c.iso);
      if (a) { profit += a.profit; count += a.count; }
    }
    return { profit, count };
  }, [cells, byDay]);

  const dayBets = useMemo(
    () => (selected ? bets.filter((b) => isoOf(new Date(b.eventAt ?? b.placedAt)) === selected) : []),
    [bets, selected]
  );

  const tint = (profit: number, settled: number) => {
    if (settled === 0) return "transparent";
    return (profit >= 0 ? cc.pos : cc.red) + "22";
  };

  return (
    <div>
      <Topbar title="Kalender" sub={`${bets.length} bets · klicka på en dag för att se spelen`} />

      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button className="ap-iconbtn" onClick={() => shift(-1)} aria-label="Föregående månad">‹</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{MONTHS_SV[cur.m]} {cur.y}</div>
            <div style={{ fontSize: 12, color: "var(--dim2)" }}>
              {monthTotal.count} bets · <em className={monthTotal.profit >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal", fontWeight: 600 }}>{krShort(monthTotal.profit * unit, true)}</em> <span style={{ color: "var(--dim2)" }}>{uFmt(monthTotal.profit, true)}</span>
            </div>
          </div>
          <button className="ap-iconbtn" onClick={() => shift(1)} aria-label="Nästa månad">›</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
          {WEEKDAYS.map((w) => (
            <div key={w} style={{ textAlign: "center", fontSize: 11, color: "var(--dim2)", fontWeight: 600, paddingBottom: 4 }}>{w}</div>
          ))}
          {cells.map((c, i) => {
            if (!c) return <div key={i} />;
            const a = byDay.get(c.iso);
            const isSel = selected === c.iso;
            return (
              <button
                key={c.iso}
                onClick={() => setSelected(isSel ? "" : c.iso)}
                style={{
                  minHeight: 64, borderRadius: 10, padding: "6px 8px", textAlign: "left", cursor: "pointer",
                  background: tint(a?.profit ?? 0, a?.settled ?? 0),
                  border: `1px solid ${isSel ? cc.acc : "var(--grid, rgba(255,255,255,.06))"}`,
                  display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 2,
                }}
              >
                <span style={{ fontSize: 12, color: "var(--dim)", fontWeight: 600 }}>{c.day}</span>
                {a ? (
                  <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                    <em className={a.settled === 0 ? "" : a.profit >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal", fontWeight: 700, fontSize: 12.5 }}>
                      {a.settled === 0 ? "—" : uFmt(a.profit, true)}
                    </em>
                    <span style={{ fontSize: 10.5, color: "var(--dim2)" }}>{a.count} {a.count === 1 ? "bet" : "bets"}{a.pending ? ` · ${a.pending} öppna` : ""}</span>
                  </span>
                ) : (
                  <span />
                )}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Selected-day bets */}
      {selected && (
        <Card style={{ padding: 0, marginTop: 12 }}>
          <div className="ap-card-head">
            <span className="ap-card-title">Spel {selected}</span>
            <span style={{ color: "var(--dim2)", fontSize: 12 }}>{dayBets.length} bets</span>
          </div>
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "46px 1.4fr 1.1fr 70px 64px 96px" }}>
              <span>Sport</span><span>Match</span><span className="ap-hide-sm">Spel</span><span className="ap-r">Odds</span><span className="ap-r">Insats</span><span className="ap-r">Resultat</span>
            </div>
            {dayBets.length === 0 && <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--dim2)" }}>Inga spel den här dagen.</div>}
            {dayBets.map((b) => (
              <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: "46px 1.4fr 1.1fr 70px 64px 96px" }}>
                <span><span className="ap-tag">{sportTag(b.sport)}</span></span>
                <span className="ap-ell">{b.event}{b.market ? <span style={{ color: "var(--dim2)" }}> · {b.market}</span> : null}</span>
                <span className="ap-ell ap-hide-sm" style={{ color: "var(--dim)" }}>{b.selection || "—"}</span>
                <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                <span className="ap-r ap-num">{b.stakeUnits.toFixed(2)}U</span>
                <span className="ap-r"><ResultBadge outcome={b.outcome} profitUnits={b.profitUnits} /></span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {loading && <div style={{ padding: "24px", textAlign: "center", color: "var(--dim2)" }}>Laddar…</div>}
      {!loading && !selected && (
        <div style={{ marginTop: 12, textAlign: "center", color: "var(--dim2)", fontSize: 13, display: "flex", gap: 6, justifyContent: "center", alignItems: "center" }}>
          <I p={IC.calendar} size={15} /> Klicka på en dag i kalendern för att se spelen.
        </div>
      )}
    </div>
  );
}
