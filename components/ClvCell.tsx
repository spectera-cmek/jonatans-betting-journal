"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { clvPct } from "@/lib/betting";
import type { BetDTO } from "@/lib/types";
import { I, IC } from "@/components/icons";

export type ClvSaved = { closingOdds: number | null; clvPct: number | null };

type Props = {
  betId: string;
  odds: number;
  closingOdds: number | null;
  clvPctValue: number | null;
  /** De-vigged closing price, when a sharp reference was available. */
  closingFairOdds?: number | null;
  closingSource?: string | null;
  closingBookmaker?: string | null;
  onSaved?: (next: ClvSaved) => void;
};

/** Human labels for where a closing price came from. */
const SOURCE_LABEL: Record<string, string> = {
  odds_api_historical: "Odds API, stängningssnapshot",
  odds_api_live: "Odds API, pris före avspark (preliminärt)",
  thestatsapi: "TheStatsAPI",
  oddsportal: "OddsPortal-scrape",
  manual: "Manuellt inlagt",
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

export function ClvCell({
  betId,
  odds,
  closingOdds,
  clvPctValue,
  closingFairOdds,
  closingSource,
  closingBookmaker,
  onSaved,
}: Props) {
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

  const fetchBtn = (
    <button
      type="button"
      className="ap-iconbtn"
      title={fetchDetail || "Hämta CLV från OddsPortal"}
      aria-label="Hämta CLV från OddsPortal"
      disabled={fetching || saving || editing}
      onClick={(e) => {
        e.stopPropagation();
        void fetchClv();
      }}
      style={{
        width: 26,
        height: 26,
        flexShrink: 0,
        opacity: fetching ? 0.55 : 1,
      }}
    >
      <I p={IC.refresh} size={12} />
    </button>
  );

  if (editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}>
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
      </div>
    );
  }

  const pct = localClv ?? computeClv(odds, localClosing);

  if (pct != null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="ap-clv-btn"
          title={
            localClosing != null
              ? [
                  `Stängning ${localClosing.toFixed(2)}${closingBookmaker ? ` (${closingBookmaker})` : ""}`,
                  closingFairOdds && closingFairOdds > 1
                    ? `Fair ${closingFairOdds.toFixed(2)} — CLV ${
                        odds / closingFairOdds - 1 >= 0 ? "+" : ""
                      }${((odds / closingFairOdds - 1) * 100).toFixed(1)}% mot fair line`
                    : "Fair line saknas — siffran är mot rått pris och smickrar därför",
                  closingSource ? SOURCE_LABEL[closingSource] ?? closingSource : null,
                  fetchDetail,
                  "Klicka för att ändra",
                ]
                  .filter(Boolean)
                  .join("\n")
              : "Ändra closing-odds"
          }
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
            minWidth: 0,
          }}
        >
          {pct >= 0 ? "+" : ""}
          {pct.toFixed(1)}%
        </button>
        {fetchBtn}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", justifyContent: "flex-end" }}>
      <button
        type="button"
        className="ap-clv-btn"
        title={fetchDetail || "Sätt closing-odds"}
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
          minWidth: 0,
        }}
      >
        {fetching ? "…" : "—"}
      </button>
      {fetchBtn}
    </div>
  );
}
