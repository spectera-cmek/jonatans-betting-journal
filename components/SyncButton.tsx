"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { I, IC } from "./icons";
import { CMD, useCommand } from "@/lib/commands";

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
    <div role="status" style={{ fontSize: "var(--fs-md)", color: result.ok ? "var(--dim)" : "var(--red)", marginTop: showResult ? 10 : 0 }}>
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
    return <CompactSync busy={busy} label={label} result={result} run={run} />;
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

/**
 * The status-bar variant: icon button with the outcome dropping down under the
 * bar for a few seconds, rather than a line of text that would stretch it. This
 * is also the instance the quick search's "Synka" runs.
 */
function CompactSync({
  busy,
  label,
  result,
  run,
}: {
  busy: boolean;
  label: string;
  result: SyncResult | null;
  run: () => void;
}) {
  useCommand(CMD.sync, () => {
    if (!busy) run();
  });

  // The message clears itself; the title on the button keeps the last outcome.
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!result) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 6000);
    return () => clearTimeout(t);
  }, [result]);

  return (
    <div className="ap-sync">
      <button
        className="ap-btn ghost"
        onClick={run}
        disabled={busy}
        aria-label={busy ? "Synkar…" : label}
        aria-busy={busy}
        title={result?.message || "Synka rättning + CLV"}
      >
        <span style={busy ? { animation: "spin 1s linear infinite", display: "inline-flex" } : { display: "inline-flex" }}>
          <I p={IC.refresh} size={15} />
        </span>
        <span className="ap-hide-sm">{busy ? "Synkar…" : label}</span>
      </button>
      {/* Always mounted so a screen reader announces the result when it arrives. */}
      <span role="status" className={"ap-sync-msg" + (result && !result.ok ? " is-err" : "")}>
        {result && !busy && show ? result.message : ""}
      </span>
    </div>
  );
}
