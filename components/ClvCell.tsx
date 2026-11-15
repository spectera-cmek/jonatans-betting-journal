"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { clvPct } from "@/lib/betting";
import type { BetDTO } from "@/lib/types";
import { I, IC } from "@/components/icons";
import { CLV_SCRAPE_AVAILABLE } from "@/lib/scrapeEnv";

export type ClvSaved = { closingOdds: number | null; clvPct: number | null };

type Props = {
  betId: string;
  odds: number;
  closingOdds: number | null;
  clvPctValue: number | null;
  /** Odds-boost: a boosted price is not a market price, so it has no CLV. */
  boosted?: boolean | null;
  onSaved?: (next: ClvSaved) => void;
};

type ClvFetchResponse = {
  closingOdds: number | null;
  clvPct: number | null;
  detail?: string;
  provisional?: boolean;
  error?: string;
};

function computeClv(odds: number, closing: number | null): number | null {
  if (closing == null || !(closing > 1) || !(odds > 1)) return null;
  return clvPct(odds, closing);
}

export function ClvCell({ betId, odds, closingOdds, clvPctValue, boosted, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchDetail, setFetchDetail] = useState<string | null>(null);
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
    if (saving || fetching) return;
    setDraft(localClosing != null ? String(localClosing) : "");
    setEditing(true);
  };

  const cancel = () => {
    skipBlur.current = true;
    setEditing(false);
    setDraft("");
  };

  const applySaved = (saved: ClvSaved) => {
    setLocalClosing(saved.closingOdds);
    setLocalClv(saved.clvPct ?? computeClv(odds, saved.closingOdds));
    onSaved?.(saved);
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
      applySaved({
        closingOdds: updated.closingOdds,
        clvPct: updated.clvPct,
      });
      setEditing(false);
      setFetchDetail(null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const fetchClv = async () => {
    if (fetching || saving || editing) return;
    setFetching(true);
    setFetchDetail(null);
    try {
      const res = await api.post<ClvFetchResponse>(`/api/bets/${betId}/clv`);
      applySaved({
        closingOdds: res.closingOdds,
        clvPct: res.clvPct,
      });
      setFetchDetail(res.detail || (res.provisional ? "Live-odds (ej slutgiltig closing)" : "CLV hämtad"));
    } catch (e) {
      const msg = (e as Error).message || "Kunde inte hämta CLV";
      setFetchDetail(msg);
      alert(msg);
    } finally {
      setFetching(false);
    }
  };

  // Hidden wherever the scrape cannot run at all; manual entry stays available.
  const fetchBtn = !CLV_SCRAPE_AVAILABLE ? null : (
    <button
      type="button"
      className={"ap-clv-fetch" + (fetching ? " is-busy" : "")}
      title={fetchDetail || "Hämta CLV från OddsPortal"}
      aria-label="Hämta CLV från OddsPortal"
      disabled={fetching || saving || editing}
      onClick={(e) => {
        e.stopPropagation();
        void fetchClv();
      }}
    >
      <I p={IC.refresh} size={12} />
    </button>
  );

  // A boost is priced against nothing the market ever offered — comparing it to
  // the close measures the boost, not the bet. Say so instead of inviting a
  // closing price that would only pollute the CLV average.
  if (boosted) {
    return (
      <span className="ap-clv-boost" title="Boostat odds räknas aldrig som CLV.">
        boost
      </span>
    );
  }

  if (editing) {
    return (
      <div className="ap-clv">
        <input
          ref={inputRef}
          className="ap-input ap-num ap-clv-input"
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
        />
      </div>
    );
  }

  const pct = localClv ?? computeClv(odds, localClosing);

  if (pct != null) {
    return (
      <div className="ap-clv">
        <button
          type="button"
          className={"ap-clv-btn ap-num " + (pct >= 0 ? "pos" : "neg")}
          title={
            localClosing != null
              ? `Closing ${localClosing.toFixed(2)} — klicka för att ändra${fetchDetail ? ` · ${fetchDetail}` : ""}`
              : "Ändra closing-odds"
          }
          onClick={startEdit}
        >
          {pct >= 0 ? "+" : ""}
          {pct.toFixed(1)}%
        </button>
        {fetchBtn}
      </div>
    );
  }

  return (
    <div className="ap-clv">
      <button
        type="button"
        className="ap-clv-btn ap-num is-empty"
        title={fetchDetail || "Sätt closing-odds"}
        onClick={startEdit}
      >
        {fetching ? "…" : "—"}
      </button>
      {fetchBtn}
    </div>
  );
}
