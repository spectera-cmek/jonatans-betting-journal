"use client";

// Dashboard "Öppna spel": every pending bet with stake at risk and potential
// return, soonest event first. Absorbs the old "Öppen risk" card — the totals
// come from the same openRisk aggregate.

import Link from "next/link";
import { Card, Empty } from "./ui";
import { MiniStat } from "./stats";
import { I, IC } from "./icons";
import { krFmt, krShort, uFmt, dateShort, sportTag } from "@/lib/format";
import { dayIso, addDays } from "@/lib/time";
import type { OpenBetRow } from "@/lib/useData";
import type { OpenRisk } from "@/lib/betting";

// "idag" / "imorgon" / "om N d" for upcoming events; "spelad" when the event
// has passed but the bet still awaits settling.
function timeChip(eventAt: string | null): { text: string; hot?: boolean } | null {
  if (!eventAt) return null;
  const today = dayIso(Date.now());
  const day = dayIso(eventAt);
  if (day < today) return { text: "spelad" };
  if (day === today) return { text: "idag", hot: true };
  if (day === addDays(today, 1)) return { text: "imorgon", hot: true };
  const n = Math.round((Date.parse(day) - Date.parse(today)) / 864e5);
  return { text: `om ${n} d` };
}

function Chip({ chip }: { chip: { text: string; hot?: boolean } | null }) {
  if (!chip) return null;
  return (
    <span className="ap-tag" style={chip.hot ? { color: "var(--acc)", background: "var(--acc-soft)" } : undefined}>
      {chip.text}
    </span>
  );
}

export function OpenBetsPanel({ open, risk, unit }: { open: OpenBetRow[]; risk: OpenRisk; unit: number }) {
  const cols = "96px minmax(170px, 1.3fr) minmax(150px, 1fr) 100px 60px 84px 100px";
  return (
    <Card style={{ padding: 0, marginBottom: 12 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">Öppna spel</span>
        <span style={{ color: "var(--dim2)", fontSize: 12 }}>
          {risk.bets} öppna · {krFmt(risk.stakeUnits * unit)} i spel
        </span>
      </div>

      {risk.bets === 0 ? (
        <Empty
          icon={<I p={IC.ticket} />}
          title="Inga öppna spel"
          hint="Allt är avgjort. Logga nästa spel med knappen uppe till höger."
        />
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10,
              padding: "14px 20px 2px",
            }}
          >
            <MiniStat label="I spel" value={krFmt(risk.stakeUnits * unit)} />
            <MiniStat label="Möjlig retur" value={krFmt(risk.potentialReturnUnits * unit)} tone="pos" />
            <MiniStat label="Antal" value={String(risk.bets)} />
          </div>

          <div className="ap-table-wrap">
            <div className="ap-table" style={{ marginTop: 6 }}>
              <div className="ap-thead" style={{ gridTemplateColumns: cols }}>
                <span>Datum</span>
                <span>Match</span>
                <span>Spel</span>
                <span>Bookmaker</span>
                <span className="ap-r">Odds</span>
                <span className="ap-r">Insats</span>
                <span className="ap-r">Möjlig retur</span>
              </div>
              {open.map((b) => {
                const chip = timeChip(b.eventAt);
                return (
                  <div key={b.id} className="ap-trow" style={{ gridTemplateColumns: cols }}>
                    <span style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                      <span className="ap-num" style={{ color: "var(--dim)", fontSize: 12.5 }}>
                        {dateShort(b.eventAt ?? b.placedAt)}
                      </span>
                      <Chip chip={chip} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="ap-ell" style={{ display: "block" }}>{b.event}</span>
                      <span className="ap-ell" style={{ display: "block", fontSize: 11.5, color: "var(--dim2)", marginTop: 2 }}>
                        {sportTag(b.sport)}
                        {b.league ? ` · ${b.league}` : ""}
                      </span>
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="ap-ell" style={{ display: "block" }}>{b.selection || "—"}</span>
                      {b.betType === "accumulator" && (
                        <span className="ap-tag" style={{ marginTop: 3, display: "inline-block" }}>ack</span>
                      )}
                    </span>
                    <span className="ap-ell" style={{ color: "var(--dim)" }}>{b.bookmaker ?? "—"}</span>
                    <span className="ap-r ap-num">{b.odds.toFixed(2)}</span>
                    <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{krShort(b.stakeUnits * unit)}</span>
                    <span className="ap-r ap-num pos" style={{ fontWeight: 600 }}>
                      {krShort(b.stakeUnits * b.odds * unit)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile: stacked cards instead of the wide grid table. */}
          <div className="ap-betcards" style={{ padding: "12px 14px 4px" }}>
            {open.map((b) => {
              const chip = timeChip(b.eventAt);
              return (
                <div key={b.id} className="ap-betcard">
                  <div className="ap-betcard-top">
                    <span className="ap-betcard-date">
                      {dateShort(b.eventAt ?? b.placedAt)} <Chip chip={chip} />
                    </span>
                    <span className="ap-tag">{b.bookmaker ?? sportTag(b.sport)}</span>
                  </div>
                  <div className="ap-betcard-event">{b.event}</div>
                  <div className="ap-betcard-sel">
                    {b.selection || "—"}
                    {b.betType === "accumulator" ? " · ack" : ""}
                  </div>
                  <div className="ap-betcard-stats">
                    <div>
                      <span>Odds</span>
                      <b className="ap-num">{b.odds.toFixed(2)}</b>
                    </div>
                    <div>
                      <span>Insats</span>
                      <b className="ap-num">{uFmt(b.stakeUnits)}</b>
                    </div>
                    <div>
                      <span>Möjlig retur</span>
                      <b className="ap-num pos">{krShort(b.stakeUnits * b.odds * unit)}</b>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: "10px 20px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>
              {risk.bets > open.length ? `Visar de ${open.length} närmaste av ${risk.bets}` : ""}
            </span>
            <Link className="ap-link" href="/bets?res=pending">
              Visa alla öppna →
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}
