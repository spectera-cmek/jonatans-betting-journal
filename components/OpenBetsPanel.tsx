"use client";

// Dashboard "Öppna spel": a live-action ticker of every pending bet — soonest
// event first — where each card can be settled and given a closing price
// without leaving the dashboard. Absorbs the old "Öppen risk" card; the totals
// come from the same openRisk aggregate.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, SportMark } from "./ui";
import { I, IC } from "./icons";
import { ClvCell, type ClvSaved } from "./ClvCell";
import { SettlementDialog } from "./SettlementDialog";
import { krFmt, krShort, dateShort } from "@/lib/format";
import { dayIso, addDays } from "@/lib/time";
import type { OpenBetRow } from "@/lib/useData";
import type { OpenRisk } from "@/lib/betting";

// "idag" / "imorgon" / "om N d" for upcoming events; "spelad" when the event
// has passed but the bet still awaits settling.
function timeChip(eventAt: string | null): { text: string; hot?: boolean; done?: boolean } | null {
  if (!eventAt) return null;
  const today = dayIso(Date.now());
  const day = dayIso(eventAt);
  if (day < today) return { text: "spelad", done: true };
  if (day === today) return { text: "idag", hot: true };
  if (day === addDays(today, 1)) return { text: "imorgon", hot: true };
  const n = Math.round((Date.parse(day) - Date.parse(today)) / 864e5);
  return { text: `om ${n} d` };
}

function Chip({ chip }: { chip: { text: string; hot?: boolean; done?: boolean } | null }) {
  if (!chip) return null;
  const cls = chip.done ? " is-ready" : chip.hot ? " is-hot" : "";
  return <span className={"ap-timechip" + cls}>{chip.text}</span>;
}

export function OpenBetsPanel({
  open,
  risk,
  unit,
  onClvSaved,
  onSettled,
}: {
  open: OpenBetRow[];
  risk: OpenRisk;
  unit: number;
  onClvSaved?: (id: string, next: ClvSaved) => void;
  /** Called after a bet is settled so the dashboard can refresh its metrics. */
  onSettled?: () => void;
}) {
  const [rows, setRows] = useState(open);
  const [settling, setSettling] = useState<OpenBetRow | null>(null);
  useEffect(() => {
    setRows(open);
  }, [open]);

  const handleClv = (id: string, next: ClvSaved) => {
    setRows((list) =>
      list.map((b) => (b.id === id ? { ...b, closingOdds: next.closingOdds, clvPct: next.clvPct } : b))
    );
    onClvSaved?.(id, next);
  };

  // Bets whose event has already kicked off are the ones actually settleable.
  const today = dayIso(Date.now());
  const readyCount = rows.filter((b) => b.eventAt && dayIso(b.eventAt) <= today).length;
  const nextReady = rows.find((b) => b.eventAt && dayIso(b.eventAt) <= today) ?? null;

  return (
    <>
      <Card className="ap-livecenter" style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">
            <span className="ap-chip-icon is-sm is-sky" aria-hidden="true">
              <I p={IC.clock} size={13} />
            </span>
            Öppna spel
            <span className="ap-count-badge">{risk.bets} aktiva</span>
          </span>
          <div className="ap-livecenter-actions">
            <span className="ap-livecenter-totals">
              <b className="ap-num">{krFmt(risk.stakeUnits * unit)}</b> i spel ·{" "}
              <b className="ap-num pos">{krFmt(risk.potentialReturnUnits * unit)}</b> möjlig retur
            </span>
            {nextReady && (
              <button className="ap-btn ap-settle-next" onClick={() => setSettling(nextReady)}>
                <I p={IC.zap} size={14} />
                Rätta nästa{readyCount > 1 ? ` (${readyCount})` : ""}
              </button>
            )}
          </div>
        </div>

        {risk.bets === 0 ? (
          <Empty
            icon={IC.ticket}
            title="Inga öppna spel"
            hint="Allt är avgjort. Logga nästa spel med knappen uppe till höger."
          />
        ) : (
          <>
            {/* Horizontally scrollable ticker — settle and price each bet in place. */}
            <div className="ap-openbet-row">
              {rows.map((b) => {
                const chip = timeChip(b.eventAt);
                const ready = !!b.eventAt && dayIso(b.eventAt) <= today;
                return (
                  <article key={b.id} className={"ap-openbet" + (ready ? " is-ready" : "")}>
                    <header className="ap-openbet-head">
                      <SportMark sport={b.sport} />
                      <span className="ap-openbet-book">{b.bookmaker ?? "—"}</span>
                    </header>

                    <div className="ap-openbet-sel" title={b.selection || undefined}>
                      {b.selection || "—"}
                    </div>
                    <div className="ap-openbet-event" title={b.event}>
                      {b.event}
                    </div>

                    <div className="ap-openbet-meta">
                      <span className="ap-num">{dateShort(b.eventAt ?? b.placedAt)}</span>
                      <Chip chip={chip} />
                      {b.league && <span className="ap-ell ap-openbet-league">{b.league}</span>}
                    </div>

                    <div className="ap-openbet-stats">
                      <div>
                        <span>Insats / Odds</span>
                        <b className="ap-num">
                          {krShort(b.stakeUnits * unit)}{" "}
                          <em>{b.odds.toFixed(2)}</em>
                        </b>
                      </div>
                      <div className="ap-r">
                        <span>Möjlig retur</span>
                        <b className="ap-num pos">{krShort(b.stakeUnits * b.odds * unit)}</b>
                      </div>
                    </div>

                    <footer className="ap-openbet-foot">
                      <span className="ap-openbet-clv">
                        <span className="ap-label">CLV</span>
                        <ClvCell
                          betId={b.id}
                          odds={b.odds}
                          closingOdds={b.closingOdds}
                          clvPctValue={b.clvPct}
                          onSaved={(next) => handleClv(b.id, next)}
                        />
                      </span>
                      <button
                        className="ap-openbet-settle"
                        onClick={() => setSettling(b)}
                        title="Rätta det här spelet"
                      >
                        <I p={IC.zap} size={13} />
                        Rätta
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>

            <div className="ap-livecenter-foot">
              <span>
                {risk.bets > rows.length ? `Visar de ${rows.length} närmaste av ${risk.bets}` : "Dra i sidled för fler"}
              </span>
              <Link className="ap-link" href="/bets?res=pending">
                Visa alla öppna →
              </Link>
            </div>
          </>
        )}
      </Card>

      <SettlementDialog
        bet={settling ? { id: settling.id, event: settling.event, selection: settling.selection, outcome: "pending" } : null}
        onClose={() => setSettling(null)}
        onChanged={() => {
          // Drop the row optimistically so the ticker reflects the settle at once.
          setRows((list) => list.filter((b) => b.id !== settling?.id));
          setSettling(null);
          onSettled?.();
        }}
      />
    </>
  );
}
