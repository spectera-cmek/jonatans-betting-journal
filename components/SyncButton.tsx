"use client";

import { useState } from "react";
import { api } from "@/lib/fetcher";
import { I, IC } from "./icons";

interface SyncResult {
  ok: boolean;
  message: string;
  linked: number;
  graded: number;
  closingUpdated: number;
  details: string[];
}

export function SyncButton({
  kind = "all",
  label = "Synka",
  onDone,
  showResult = false,
}: {
  kind?: "all" | "grade" | "closing" | "scores" | "link" | "odds-closing" | "historical-clv";
  label?: string;
  onDone?: () => void;
  showResult?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.post<SyncResult>(`/api/sync?kind=${kind}`);
      setResult(res);
      onDone?.();
    } catch (e) {
      setResult({
        ok: false,
        message: (e as Error).message,
        linked: 0,
        graded: 0,
        closingUpdated: 0,
        details: [],
      });
    } finally {
      setBusy(false);
    }
  };

  const status = result ? (
    <div style={{ fontSize: 12.5, color: result.ok ? "var(--dim)" : "var(--red)", marginTop: showResult ? 10 : 0 }}>
      <div>{result.message}</div>
      {showResult && result.details?.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--dim2)", lineHeight: 1.45 }}>
          {result.details.slice(0, 8).map((d) => (
            <li key={d}>{d}</li>
          ))}
          {result.details.length > 8 && <li>… +{result.details.length - 8} till</li>}
        </ul>
      )}
    </div>
  ) : null;

  if (!showResult) {
    return (
      <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <button
          className="ap-btn ghost"
          onClick={run}
          disabled={busy}
          title={result?.message || "Synka rättning + CLV"}
        >
          <span
            style={
              busy
                ? { animation: "spin 1s linear infinite", display: "inline-flex" }
                : { display: "inline-flex" }
            }
          >
            <I p={IC.refresh} size={15} />
          </span>
          <span className="ap-hide-sm">{busy ? "Synkar…" : label}</span>
        </button>
        {result && !busy && (
          <span style={{ fontSize: 11, color: result.ok ? "var(--dim)" : "var(--red)", maxWidth: 220 }}>
            {result.message}
          </span>
        )}
      </div>
    );
  }

  return (
    <div>
      <button className="ap-btn ghost" onClick={run} disabled={busy}>
        <span
          style={
            busy
              ? { animation: "spin 1s linear infinite", display: "inline-flex" }
              : { display: "inline-flex" }
          }
        >
          <I p={IC.refresh} size={15} />
        </span>
        {busy ? "Synkar…" : label}
      </button>
      {status}
    </div>
  );
}
