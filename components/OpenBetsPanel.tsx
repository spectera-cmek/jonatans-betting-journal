"use client";

// Dashboard "Öppna spel": every pending bet as a vertical action list — soonest
// event first — where each row can be settled and given a closing price without
// leaving the dashboard. Rows whose event has been played carry the amber rule:
// they are the ones waiting on you. The totals come from the openRisk aggregate.

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
      <Card className="ap-openbets">
        <div className="ap-card-head">
          <span role="heading" aria-level={2} className="ap-card-title">
            Öppna spel
            <span className="ap-count-badge">{risk.bets}</span>
          </span>
          {nextReady && (
            <button className="ap-openbet-settle" onClick={() => setSettling(nextReady)}>
              <I p={IC.zap} size={12} />
              Rätta nästa{readyCount > 1 ? ` (${readyCount})` : ""}
            </button>
          )}
        </div>

        {risk.bets === 0 ? (
          <Empty
            icon={IC.ticket}
            title="Inga öppna spel"
            hint="Allt är avgjort. Logga nästa spel med knappen uppe till höger."
          />
        ) : (
          <>
            <div className="ap-openbets-totals">
              <span>
                I spel <b className="ap-num">{krFmt(risk.stakeUnits * unit)}</b>
              </span>
              <span>
                Möjlig retur <b className="ap-num pos">{krFmt(risk.potentialReturnUnits * unit)}</b>
              </span>
            </div>

            <div className="ap-openbet-scroll">
            <ul className="ap-openbet-list">
              {rows.map((b) => {
                const chip = timeChip(b.eventAt);
                const ready = !!b.eventAt && dayIso(b.eventAt) <= today;
                return (
                  <li key={b.id} className={"ap-openbet" + (ready ? " is-ready" : "")}>
                    <div className="ap-openbet-main">
                      <div className="ap-openbet-sel" title={b.selection || undefined}>
                        {b.selection || "—"}
                      </div>
                      <div className="ap-openbet-event" title={b.event}>
                        {b.event}
                        {b.league ? ` · ${b.league}` : ""}
                      </div>
                      <div className="ap-openbet-meta">
                        <SportMark sport={b.sport} />
                        <span className="ap-num">{dateShort(b.eventAt ?? b.placedAt)}</span>
                        <Chip chip={chip} />
                        <span>{b.bookmaker ?? "—"}</span>
                      </div>
                    </div>

                    <div className="ap-openbet-side">
                      <span className="ap-num ap-openbet-nums" title="Insats @ odds → möjlig retur">
                        {krShort(b.stakeUnits * unit)} <em>@</em> {b.odds.toFixed(2)} <em>→</em>{" "}
                        <span className="pos">{krShort(b.stakeUnits * b.odds * unit)}</span>
                      </span>
                      <div className="ap-openbet-acts">
                        <ClvCell
                          betId={b.id}
                          odds={b.odds}
                          closingOdds={b.closingOdds}
                          clvPctValue={b.clvPct}
                          boosted={b.boosted}
                          onSaved={(next) => handleClv(b.id, next)}
                        />
                        <button className="ap-openbet-settle" onClick={() => setSettling(b)} title="Rätta det här spelet">
                          Rätta
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            </div>

            <div className="ap-openbets-foot">
              <span>{risk.bets > rows.length ? `De ${rows.length} närmaste av ${risk.bets}` : `${risk.bets} öppna`}</span>
              <span style={{ display: "inline-flex", gap: 14 }}>
                {readyCount > 1 && (
                  <Link className="ap-link" href="/rattning">
                    Hela kön →
                  </Link>
                )}
                <Link className="ap-link" href="/bets?res=pending">
                  Visa alla →
                </Link>
              </span>
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
