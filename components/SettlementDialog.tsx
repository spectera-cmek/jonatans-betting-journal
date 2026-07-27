"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import type { BetListDTO, BetSettlementDTO } from "@/lib/types";
import type { Outcome } from "@/lib/betting";
import { ResultBadge } from "./ResultBadge";

const OUTCOMES: { value: Exclude<Outcome, "pending">; label: string }[] = [
  { value: "win", label: "Vunnen" },
  { value: "loss", label: "Förlorad" },
  { value: "push", label: "Push" },
  { value: "void", label: "Void" },
  { value: "half_win", label: "½ vunnen" },
  { value: "half_loss", label: "½ förlorad" },
];

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manuell",
  agent: "Agent",
  espn: "ESPN",
  odds_api: "Odds API",
  bet365: "Bet365",
  unibet: "Unibet",
};

/** The dialog only reads these four fields, so anything bet-shaped can be
 *  settled — including the lighter OpenBetRow used by the dashboard ticker. */
export type SettleTarget = Pick<BetListDTO, "id" | "event" | "selection" | "outcome">;

export function SettlementDialog({
  bet,
  onClose,
  onChanged,
}: {
  bet: SettleTarget | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [outcome, setOutcome] = useState<Exclude<Outcome, "pending">>("win");
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<BetSettlementDTO[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bet) return;
    const current = OUTCOMES.find((item) => item.value === bet.outcome)?.value;
    setOutcome(current ?? "win");
    setReason("");
    setError(null);
    setLoadingHistory(true);
    api
      .get<BetSettlementDTO[]>(`/api/bets/${bet.id}/settle`)
      .then(setHistory)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingHistory(false));
  }, [bet]);

  if (!bet) return null;
  const correcting = bet.outcome !== "pending";
  const canUndo = history.some((item) => !item.revertedAt);

  const submit = async () => {
    if (correcting && !reason.trim()) {
      setError("Ange varför den tidigare rättningen ska korrigeras.");
      return;
    }
    if (
      correcting &&
      !confirm(`Korrigera ${bet.event} från ${bet.outcome} till ${outcome}?`)
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/bets/${bet.id}/settle`, {
        outcome,
        reason: reason.trim() || "Manuell rättning",
        correct: correcting,
      });
      onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    if (!confirm(`Ångra den senaste rättningen av ${bet.event}?`)) return;
    setSaving(true);
    setError(null);
    try {
      await api.del(`/api/bets/${bet.id}/settle`);
      onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ap-overlay" onClick={onClose}>
      <div className="ap-modal" onClick={(event) => event.stopPropagation()}>
        <div className="ap-modal-head">
          <div>
            <div className="ap-card-title" style={{ fontSize: 17 }}>
              {correcting ? "Korrigera rättning" : "Rätta bet"}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3 }}>
              {bet.event} — {bet.selection}
            </div>
          </div>
          <button className="ap-close" onClick={onClose} aria-label="Stäng">×</button>
        </div>

        <div className="ap-modal-body">
          <div className="ap-field">
            <label>Utfall</label>
            <div className="ap-settlement-options">
              {OUTCOMES.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className={outcome === item.value ? "is-active" : ""}
                  onClick={() => setOutcome(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ap-field">
            <label>
              Anledning {correcting ? "(krävs vid korrigering)" : "(valfritt)"}
            </label>
            <input
              className="ap-input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="t.ex. 2–1 efter fulltid, ESPN"
            />
          </div>

          <div className="ap-field">
            <label>Rättningshistorik</label>
            {loadingHistory ? (
              <div style={{ color: "var(--dim2)", fontSize: 12.5 }}>Laddar…</div>
            ) : history.length === 0 ? (
              <div style={{ color: "var(--dim2)", fontSize: 12.5 }}>
                Ingen tidigare auditerad rättning.
              </div>
            ) : (
              <div className="ap-settlement-history">
                {history.map((item) => (
                  <div key={item.id} className={item.revertedAt ? "is-reverted" : ""}>
                    <span>
                      <ResultBadge outcome={item.toOutcome} profitUnits={item.toProfitUnits} />
                    </span>
                    <span>
                      <b>{SOURCE_LABELS[item.source] ?? item.source}</b>
                      <small>
                        {new Date(item.createdAt).toLocaleString("sv-SE")}
                        {item.revertedAt ? " · ångrad" : ""}
                      </small>
                      {item.reason && <small>{item.reason}</small>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <div style={{ color: "var(--red)", fontSize: 13 }}>{error}</div>}

          <div style={{ display: "flex", gap: 10 }}>
            {correcting && canUndo && (
              <button className="ap-btn ghost" onClick={undo} disabled={saving}>
                Ångra senaste
              </button>
            )}
            <button className="ap-btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>
              Avbryt
            </button>
            <button className="ap-btn" onClick={submit} disabled={saving}>
              {saving ? "Sparar…" : correcting ? "Spara korrigering" : "Rätta bet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
