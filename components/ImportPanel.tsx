"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { fmtDateTime } from "@/lib/format";
import { I, IC } from "./icons";

interface PdfInfo {
  path: string;
  exists: boolean;
  modified?: string;
  sizeKb?: number;
}

interface ImportSummary {
  ok: boolean;
  parsedSlips: number;
  added: number;
  settled: number;
  updated: number;
  refBackfilled: number;
  unchanged: number;
  netUnits: number;
  wiped: boolean;
}

export function ImportPanel({ onDone }: { onDone?: () => void }) {
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadInfo = () => api.get<PdfInfo>("/api/import/bet365").then(setInfo).catch(() => {});
  useEffect(() => {
    loadInfo();
  }, []);

  const run = async (wipe: boolean) => {
    if (wipe && !confirm("Detta RADERAR alla bets och importerar om från PDF:en. Fortsätt?")) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api.post<ImportSummary>(`/api/import/bet365${wipe ? "?wipe=1" : ""}`);
      setResult(res);
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      loadInfo();
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: info?.exists ? "var(--pos)" : "var(--red)" }} />
        <span>Kontoutdrag: {info?.exists ? <span className="pos">hittat</span> : <span className="neg">saknas</span>}</span>
      </div>

      <p style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 12, lineHeight: 1.55 }}>
        Ladda ner ditt kontoutdrag (PDF) från Bet365 och spara det som filen nedan.
        Klicka sedan <strong style={{ color: "var(--txt)" }}>Importera &amp; rätta</strong> — pending bets
        rättas från de <strong style={{ color: "var(--txt)" }}>riktiga utbetalningarna</strong> och nya spel
        läggs till. Inget raderas, och dina manuellt tillagda bets rörs inte.
      </p>

      <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: "var(--card2)", fontSize: 12 }}>
        <div style={{ color: "var(--dim2)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Sökväg</div>
        <code style={{ color: "var(--txt)", wordBreak: "break-all" }}>{info?.path ?? "…"}</code>
        {info?.exists && (
          <div style={{ color: "var(--dim)", marginTop: 4 }}>
            Senast ändrad {fmtDateTime(info.modified)} · {info.sizeKb} kB
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <button className="ap-btn" onClick={() => run(false)} disabled={busy || !info?.exists}>
          <span style={busy ? { animation: "spin 1s linear infinite", display: "inline-flex" } : { display: "inline-flex" }}>
            <I p={IC.upload} size={15} />
          </span>
          {busy ? "Importerar…" : "Importera & rätta"}
        </button>
        <button className="ap-link" style={{ fontSize: 12.5 }} onClick={() => run(true)} disabled={busy || !info?.exists}>
          Full återställning
        </button>
      </div>

      {err && <div style={{ fontSize: 13, color: "var(--red)", marginTop: 12 }}>{err}</div>}

      {result && (
        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 10, background: "var(--card2)" }}>
          <div className="pos" style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>✓ Klart — {result.parsedSlips} spel lästa</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12.5, color: "var(--dim)" }}>
            {result.wiped ? (
              <span>Importerade <strong style={{ color: "var(--txt)" }}>{result.added}</strong> bets (full återställning).</span>
            ) : (
              <>
                <span>Nya spel: <strong style={{ color: "var(--txt)" }}>{result.added}</strong></span>
                <span>Nyligen rättade: <strong className="pos">{result.settled}</strong></span>
                <span>Uppdaterade: <strong style={{ color: "var(--txt)" }}>{result.updated}</strong></span>
                <span>Oförändrade: <strong style={{ color: "var(--txt)" }}>{result.unchanged}</strong></span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
