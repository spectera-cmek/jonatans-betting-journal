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
  kind?: "all" | "grade" | "closing" | "scores" | "link";
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
      setResult({ ok: false, message: (e as Error).message, linked: 0, graded: 0, closingUpdated: 0, details: [] });
    } finally {
      setBusy(false);
    }
  };

  if (!showResult) {
    return (
      <button className="ap-btn ghost" onClick={run} disabled={busy} title={result?.message || ""}>
        <span style={busy ? { animation: "spin 1s linear infinite", display: "inline-flex" } : { display: "inline-flex" }}>
          <I p={IC.refresh} size={15} />
        </span>
        <span className="ap-hide-sm">{busy ? "Synkar…" : label}</span>
      </button>
    );
  }

  return (
    <div>
      <button className="ap-btn ghost" onClick={run} disabled={busy}>
        <span style={busy ? { animation: "spin 1s linear infinite", display: "inline-flex" } : { display: "inline-flex" }}>
          <I p={IC.refresh} size={15} />
        </span>
        {busy ? "Rättar…" : label}
      </button>
      {result && (
        <div style={{ fontSize: 12.5, color: result.ok ? "var(--dim)" : "var(--red)", marginTop: 10 }}>{result.message}</div>
      )}
    </div>
  );
}
