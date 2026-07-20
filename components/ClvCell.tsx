"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { clvPct } from "@/lib/betting";
import type { BetDTO } from "@/lib/types";

export type ClvSaved = { closingOdds: number | null; clvPct: number | null };

type Props = {
  betId: string;
  odds: number;
  closingOdds: number | null;
  clvPctValue: number | null;
  onSaved?: (next: ClvSaved) => void;
};

function computeClv(odds: number, closing: number | null): number | null {
  if (closing == null || !(closing > 1) || !(odds > 1)) return null;
  return clvPct(odds, closing);
}

export function ClvCell({ betId, odds, closingOdds, clvPctValue, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [localClosing, setLocalClosing] = useState(closingOdds);
  const [localClv, setLocalClv] = useState(clvPctValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlur = useRef(false);

  useEffect(() => {
    setLocalClosing(closingOdds);
    setLocalClv(clvPctValue);
  }, [closingOdds, clvPctValue]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (saving) return;
    setDraft(localClosing != null ? String(localClosing) : "");
    setEditing(true);
  };

  const cancel = () => {
    skipBlur.current = true;
    setEditing(false);
    setDraft("");
  };

  const save = async () => {
    if (saving) return;
    const trimmed = draft.trim().replace(",", ".");
    let nextClosing: number | null;
    if (trimmed === "") {
      nextClosing = null;
    } else {
      const n = parseFloat(trimmed);
      if (!Number.isFinite(n) || n <= 1) {
        cancel();
        return;
      }
      nextClosing = n;
    }

    const unchanged =
      (nextClosing == null && localClosing == null) ||
      (nextClosing != null && localClosing != null && Math.abs(nextClosing - localClosing) < 1e-9);
    if (unchanged) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      const updated = await api.patch<BetDTO>(`/api/bets/${betId}`, {
        closingOdds: nextClosing,
      });
      const saved: ClvSaved = {
        closingOdds: updated.closingOdds,
        clvPct: updated.clvPct,
      };
      setLocalClosing(saved.closingOdds);
      setLocalClv(saved.clvPct ?? computeClv(odds, saved.closingOdds));
      setEditing(false);
      onSaved?.(saved);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="ap-input ap-num"
        type="number"
        step="0.01"
        min="1.01"
        inputMode="decimal"
        placeholder="Close"
        value={draft}
        disabled={saving}
        aria-label="Closing odds"
        title="Closing odds"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          if (skipBlur.current) {
            skipBlur.current = false;
            return;
          }
          void save();
        }}
        style={{
          padding: "4px 6px",
          fontSize: 12.5,
          borderRadius: 8,
          width: "100%",
          minWidth: 52,
          textAlign: "right",
        }}
      />
    );
  }

  const pct = localClv ?? computeClv(odds, localClosing);

  if (pct != null) {
    return (
      <button
        type="button"
        className="ap-clv-btn"
        title={localClosing != null ? `Closing ${localClosing.toFixed(2)} — klicka för att ändra` : "Ändra closing-odds"}
        onClick={startEdit}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          font: "inherit",
          fontSize: 12.5,
          fontWeight: 600,
          color: pct >= 0 ? "var(--pos)" : "var(--red)",
          textAlign: "inherit",
          width: "100%",
        }}
      >
        {pct >= 0 ? "+" : ""}
        {pct.toFixed(1)}%
      </button>
    );
  }

  return (
    <button
      type="button"
      className="ap-clv-btn"
      title="Sätt closing-odds"
      onClick={startEdit}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        font: "inherit",
        fontSize: 12.5,
        fontWeight: 500,
        color: "var(--dim2)",
        textAlign: "inherit",
        width: "100%",
      }}
    >
      —
    </button>
  );
}
