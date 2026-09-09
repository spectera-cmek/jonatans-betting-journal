"use client";

// Rättningskö — shared presentation for the settlement suggestions produced by
// lib/gradingQueue. Two consumers: the compact card on the VM 2026 page (which
// only ever sees that league's bets) and the full /rattning page, which adds
// checkboxes and grouping around the same rows.

import { Card } from "./ui";
import type { GradingReadiness, GradingSuggestion } from "@/lib/gradingQueue";
import type { Outcome } from "@/lib/betting";

/** Swedish outcome names — OUTCOME_LABELS in lib/betting is English. */
export const OUTCOME_SV: Record<Outcome, string> = {
  pending: "Öppen",
  win: "Vinst",
  loss: "Förlust",
  push: "Push",
  half_win: "Halv vinst",
  half_loss: "Halv förlust",
  void: "Void",
};

export const READINESS_LABELS: Record<GradingReadiness, string> = {
  ready: "Klara",
  waiting: "Väntar",
  manual: "Manuella",
  unmatched: "Omatchade",
};

export const READINESS_HINTS: Record<GradingReadiness, string> = {
  ready: "Resultatet är hämtat och marknaden går att räkna — kan rättas direkt.",
  waiting: "Inget färdigspelat resultat hittat ännu.",
  manual: "Kräver din bedömning: kombi, spelarprop, förlängning eller okänd marknad.",
  unmatched: "Går inte att koppla till en match — saknar tid, lag eller resultatkälla.",
};

export const READINESS_ORDER: GradingReadiness[] = ["ready", "manual", "unmatched", "waiting"];

export function countByReadiness(suggestions: GradingSuggestion[]): Record<GradingReadiness, number> {
  const out: Record<GradingReadiness, number> = { ready: 0, waiting: 0, manual: 0, unmatched: 0 };
  for (const s of suggestions) out[s.readiness] += 1;
  return out;
}

/**
 * One queue row. `onToggle` turns on the checkbox — only offered for `ready`
 * rows, since the bulk endpoint refuses anything else anyway.
 */
export function GradingRow({
  item,
  selected,
  onToggle,
  onApply,
  onManual,
  showStake = false,
}: {
  item: GradingSuggestion;
  selected?: boolean;
  onToggle?: (id: string) => void;
  onApply: (ids: string[]) => void;
  onManual: (id: string) => void;
  /** Prefix the reason line with odds + stake, so a bulk rätta can be eyeballed. */
  showStake?: boolean;
}) {
  const selectable = !!onToggle && item.readiness === "ready";
  return (
    <div>
      <span className="ap-queue-mark">
        {selectable && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggle!(item.betId)}
            aria-label={`Välj ${item.event}`}
          />
        )}
        <span className={`ap-queue-dot is-${item.readiness}`} />
      </span>
      <span>
        <b>{item.event}</b>
        <small>
          {item.selection}
          {showStake && (
            <>
              {" · "}
              <span className="ap-num">
                {item.stakeUnits.toFixed(2)}U @ {item.odds.toFixed(2)}
              </span>
            </>
          )}
          {" · "}
          {item.reason}
        </small>
      </span>
      {item.readiness === "ready" && item.suggestedOutcome ? (
        <button className="ap-link" onClick={() => onApply([item.betId])}>
          {OUTCOME_SV[item.suggestedOutcome]}
        </button>
      ) : item.readiness === "manual" || item.readiness === "unmatched" ? (
        <button className="ap-link" onClick={() => onManual(item.betId)}>
          Granska
        </button>
      ) : (
        <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Väntar</span>
      )}
    </div>
  );
}

/** Compact card: the first `max` rows plus a "rätta alla säkra" action. */
export function GradingQueueCard({
  suggestions,
  loading,
  onApply,
  onManual,
  title = "Rättningskö",
  emptyText = "Inga öppna spel.",
  max = 8,
}: {
  suggestions: GradingSuggestion[];
  loading: boolean;
  onApply: (ids: string[]) => void;
  onManual: (id: string) => void;
  title?: string;
  emptyText?: string;
  max?: number;
}) {
  const ready = suggestions.filter((item) => item.readiness === "ready");
  return (
    <Card style={{ padding: 0 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">{title}</span>
        {ready.length > 0 && (
          <button className="ap-btn" onClick={() => onApply(ready.map((item) => item.betId))}>
            Rätta {ready.length} säkra
          </button>
        )}
      </div>
      {loading ? (
        <div className="ap-panel-empty">Kontrollerar resultat…</div>
      ) : suggestions.length === 0 ? (
        <div className="ap-panel-empty">{emptyText}</div>
      ) : (
        <div className="ap-queue">
          {suggestions.slice(0, max).map((item) => (
            <GradingRow key={item.betId} item={item} onApply={onApply} onManual={onManual} />
          ))}
        </div>
      )}
    </Card>
  );
}
