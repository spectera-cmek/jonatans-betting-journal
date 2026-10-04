"use client";

/**
 * Modellens facit: senaste backtestet (walk-forward på historiken) och
 * utfallet för linjer som prissatts här. Den viktiga raden är modellen mot
 * boken på samma linjer — bara om modellens log-loss är lägre finns en edge.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { Card } from "@/components/ui";
import { InlineStat } from "@/components/stats";
import type { BacktestSummary, CalibrationBucket } from "@/lib/cs2/backtest";
import type { FacitSummary } from "@/lib/cs2/settle";
import { CS2_MARKET_LABEL, type Cs2Market } from "@/lib/cs2/types";
import { Cs2NoDb, dec, pct } from "./common";

interface Resp {
  dbConfigured: boolean;
  backtest?: { createdAt: string; modelVersion: string; summary: BacktestSummary } | null;
  lines?: FacitSummary & { open: number };
}

function Calibration({ title, rows }: { title: string; rows: CalibrationBucket[] }) {
  return (
    <div style={{ minWidth: 220 }}>
      <div className="ap-label" style={{ marginBottom: 6 }}>{title}</div>
      {rows.map((b) => (
        <div key={b.from} className="ap-num" style={{ fontSize: 12.5, display: "flex", gap: 10 }}>
          <span style={{ width: 52, textAlign: "right" }}>{pct(b.predicted)}</span>
          <span style={{ color: "var(--dim2)" }}>→</span>
          <span style={{ width: 52, textAlign: "right", color: Math.abs(b.observed - b.predicted) > 0.1 && b.n >= 20 ? "var(--red)" : undefined }}>{pct(b.observed)}</span>
          <span style={{ color: "var(--dim2)" }}>n={b.n}</span>
        </div>
      ))}
    </div>
  );
}

export function FacitPanel() {
  const [data, setData] = useState<Resp | null>(null);
  useEffect(() => {
    api.get<Resp>("/api/cs2/facit").then(setData).catch(() => setData({ dbConfigured: true }));
  }, []);
  if (!data) return <Card>Laddar…</Card>;
  if (!data.dbConfigured) return <Cs2NoDb />;
  const bt = data.backtest?.summary;
  const l = data.lines;
  const beats = l?.vsMarket ? l.vsMarket.model < l.vsMarket.market : null;
  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <div className="ap-card-head" style={{ margin: "-20px -20px 14px" }}>
          <span className="ap-card-title">Backtest</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>
            {data.backtest ? `${new Date(data.backtest.createdAt).toLocaleDateString("sv-SE")} · ${data.backtest.modelVersion}` : "inte kört"}
          </span>
        </div>
        {!bt && (
          <div className="ap-cs2-warn">
            Modellen är <b>inte backtestad</b>. Kör <code>npm run cs2:backtest -- --save</code> på datorn när historiken är inläst — tills dess
            är alla siffror en utgångspunkt, inte facit.
          </div>
        )}
        {bt && (
          <>
            <div className="ap-shot-summary" style={{ flexWrap: "wrap", gap: 22 }}>
              <InlineStat label={`Kartvinnare log-loss (n=${bt.mapWinner.n})`} value={`${dec(bt.mapWinner.logLoss, 3)} mot ${dec(bt.mapWinner.baselineLogLoss, 3)}`} tone={bt.mapWinner.logLoss < bt.mapWinner.baselineLogLoss ? "pos" : "neg"} />
              <InlineStat label="Kartvinnare träff" value={pct(bt.mapWinner.accuracy)} />
              <InlineStat label={`Rundor medelfel (n=${bt.rounds.n})`} value={dec(bt.rounds.meanError, 2)} />
              <InlineStat label={`Kills över fair line (n=${bt.kills.n})`} value={pct(bt.kills.overRate)} tone={Math.abs(bt.kills.overRate - 0.5) > 0.04 ? "neg" : "pos"} />
              <InlineStat label="Kills medelfel" value={dec(bt.kills.meanError, 2)} />
              <InlineStat label="Skattat φ" value={bt.kills.phi != null ? dec(bt.kills.phi, 0) : "∞"} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 32, marginTop: 16 }}>
              <Calibration title="Kartvinnare: predikterat → utfall" rows={bt.mapWinner.calibration} />
              <Calibration title={`Rundor över ${bt.rounds.overLine}`} rows={bt.rounds.calibration} />
              <Calibration title="Kills över fair line" rows={bt.kills.calibration} />
            </div>
            {bt.notes.map((n, i) => (
              <div key={i} className="ap-cs2-warn" style={{ marginTop: 10 }}>
                {n}
              </div>
            ))}
          </>
        )}
      </Card>

      <Card>
        <div className="ap-card-head" style={{ margin: "-20px -20px 14px" }}>
          <span className="ap-card-title">Prissatta linjer · utfall</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>{l ? `${l.settled} avgjorda · ${l.open} öppna` : ""}</span>
        </div>
        {(!l || l.settled === 0) && (
          <div style={{ color: "var(--dim2)", fontSize: 13 }}>
            Inga avgjorda linjer än. Varje linje du lägger in på en matchsida sparas med modellens pris och avgörs av{" "}
            <code>npm run cs2:update</code> när matchen är spelad.
          </div>
        )}
        {l && l.settled > 0 && (
          <>
            <div className="ap-shot-summary" style={{ flexWrap: "wrap", gap: 22 }}>
              {l.vsMarket && (
                <InlineStat
                  label={`Log-loss modell / bok (n=${l.vsMarket.n})`}
                  value={`${dec(l.vsMarket.model, 3)} / ${dec(l.vsMarket.market, 3)}`}
                  tone={beats ? "pos" : "neg"}
                />
              )}
              <InlineStat label="Plattspel på +edge" value={`${l.flat.bets} spel · ${l.flat.units >= 0 ? "+" : ""}${dec(l.flat.units, 2)} u`} tone={l.flat.units >= 0 ? "pos" : "neg"} />
              <InlineStat label="ROI" value={l.flat.roi != null ? pct(l.flat.roi, 1) : "—"} />
              <InlineStat label="Träff" value={l.flat.hitRate != null ? pct(l.flat.hitRate) : "—"} />
            </div>
            <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--dim)" }}>
              {l.byMarket.map((m) => `${CS2_MARKET_LABEL[m.market as Cs2Market] ?? m.market}: ${m.n} linjer, ${m.flatBets} spel, ${m.units >= 0 ? "+" : ""}${dec(m.units, 2)} u`).join(" · ")}
            </div>
            {beats === false && (
              <div className="ap-cs2-warn" style={{ marginTop: 10 }}>
                Boken prissätter bättre än modellen på de här linjerna. Edge som modellen visar är då sannolikt brus — sänk modellvikten.
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
