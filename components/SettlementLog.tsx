"use client";

// Senast rättade — every settlement of the last days, whoever made it, so a
// wrong grade from the nightly cron or the morning agent can be spotted and
// undone. A view over /api/settlements/recent; undo is the per-bet
// DELETE /api/bets/:id/settle that already guards against stale rows.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty } from "./ui";
import { InlineStat } from "./stats";
import { OUTCOME_SV } from "./GradingQueue";
import { I, IC } from "./icons";
import { api } from "@/lib/fetcher";
import { krFmt, dateShort } from "@/lib/format";
import type { Outcome } from "@/lib/betting";
import type { RecentSettlementDTO } from "@/lib/types";

export const SOURCE_LABELS: Record<string, string> = {
  cron: "Nattjobb",
  agent: "Agent",
  espn: "ESPN",
  manual: "Manuell",
  odds_api: "Odds API",
  bet365: "Import",
  unibet: "Import",
};

const DAY_OPTIONS = [3, 7, 14, 30];

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Idag";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Igår";
  return dateShort(d);
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

export function SettlementLog({
  unit,
  refreshKey,
  onUndone,
}: {
  unit: number;
  /** Bump to refetch, e.g. after the queue above settled something. */
  refreshKey?: number;
  onUndone?: () => void;
}) {
  const [rows, setRows] = useState<RecentSettlementDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await api.get<RecentSettlementDTO[]>(`/api/settlements/recent?days=${days}`));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const sources = useMemo(
    () => Array.from(new Set(rows.map((r) => SOURCE_LABELS[r.source] ?? r.source))),
    [rows]
  );
  const visible = useMemo(
    () => rows.filter((r) => !source || (SOURCE_LABELS[r.source] ?? r.source) === source),
    [rows, source]
  );

  const live = visible.filter((r) => !r.revertedAt);
  const netU = live.reduce((sum, r) => sum + (r.toProfitUnits ?? 0) - (r.fromProfitUnits ?? 0), 0);
  const wins = live.filter((r) => r.toOutcome === "win" || r.toOutcome === "half_win").length;
  const losses = live.filter((r) => r.toOutcome === "loss" || r.toOutcome === "half_loss").length;
  const reverted = visible.length - live.length;

  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: RecentSettlementDTO[] }[] = [];
    for (const r of visible) {
      const key = dayKey(r.createdAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(r);
      else out.push({ key, label: dayLabel(r.createdAt), rows: [r] });
    }
    return out;
  }, [visible]);

  const undo = async (r: RecentSettlementDTO) => {
    const was = OUTCOME_SV[r.toOutcome as Outcome] ?? r.toOutcome;
    if (!confirm(`Ångra rättningen "${was}" på ${r.bet.selection}? Spelet blir öppet igen.`)) return;
    setBusy(r.id);
    setError(null);
    try {
      await api.del(`/api/bets/${r.bet.id}/settle`);
      await load();
      onUndone?.();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id="rattade" style={{ scrollMarginTop: 80, marginTop: 16 }}>
    <Card style={{ padding: 0 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">
          <span className="ap-chip-icon is-sm is-emerald" aria-hidden="true">
            <I p={IC.checkCircle} size={13} />
          </span>
          Senast rättade
          <span className="ap-count-badge">{visible.length}</span>
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {sources.length > 1 && (
            <div className="ap-select" style={{ minWidth: 130 }}>
              <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Källa">
                <option value="">Alla källor</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="ap-select" style={{ minWidth: 110 }}>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  Senaste {d} d
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {visible.length > 0 && (
        <div className="ap-log-stats">
          <InlineStat label="Rättade" value={String(live.length)} />
          <InlineStat label="Netto" value={krFmt(netU * unit, true)} tone={netU >= 0 ? "pos" : "neg"} />
          <InlineStat label="V · F" value={`${wins} · ${losses}`} />
          {reverted > 0 && <InlineStat label="Ångrade" value={String(reverted)} />}
        </div>
      )}

      {error && (
        <div className="ap-panel-empty">
          <span className="neg">{error}</span>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="ap-panel-empty">Hämtar rättningar…</div>
      ) : visible.length === 0 ? (
        <Empty icon={IC.checkCircle} title="Inga rättningar" hint={`Inget har rättats de senaste ${days} dagarna.`} />
      ) : (
        groups.map((g) => (
          <div key={g.key}>
            <div className="ap-log-day">{g.label}</div>
            <div className="ap-queue ap-log">
              {g.rows.map((r) => {
                const pos = r.toOutcome === "win" || r.toOutcome === "half_win";
                const neg = r.toOutcome === "loss" || r.toOutcome === "half_loss";
                const correction = r.fromOutcome !== "pending";
                return (
                  <div key={r.id} className={r.revertedAt ? "is-reverted" : undefined}>
                    <span className={`ap-queue-dot ${pos ? "is-ready" : neg ? "is-manual" : ""}`} />
                    <span>
                      <b>
                        {r.bet.selection}
                        <span className="ap-log-event"> · {r.bet.event}</span>
                      </b>
                      <small>
                        <span className="ap-num">
                          {r.bet.stakeUnits.toFixed(2)}U @ {r.bet.odds.toFixed(2)}
                        </span>
                        {" · "}
                        {SOURCE_LABELS[r.source] ?? r.source} {timeOf(r.createdAt)}
                        {correction && ` · korrigerad från ${OUTCOME_SV[r.fromOutcome] ?? r.fromOutcome}`}
                        {r.reason && <> · {r.reason}</>}
                      </small>
                    </span>
                    <span className="ap-log-right">
                      <span className={`ap-pill ${pos ? "pos" : neg ? "neg" : "flat"}`}>
                        {OUTCOME_SV[r.toOutcome] ?? r.toOutcome} {krFmt((r.toProfitUnits ?? 0) * unit, true)}
                      </span>
                      {r.revertedAt ? (
                        <span className="ap-log-note">Ångrad</span>
                      ) : r.undoable ? (
                        <button className="ap-link" disabled={busy === r.id} onClick={() => undo(r)}>
                          {busy === r.id ? "Ångrar…" : "Ångra"}
                        </button>
                      ) : (
                        <span className="ap-log-note" title="Spelet har ändrats efter den här rättningen">
                          Ersatt
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </Card>
    </div>
  );
}
