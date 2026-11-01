"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { SPORT_IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import { NbaEmpty, NbaNoDb, dateLabel, pct, signed, sideLabel, type Market } from "@/components/nba/common";

interface Proj {
  market: Market;
  line: number | null;
  pModel: number;
  pMarket: number | null;
  pFinal: number;
  fair1: number;
  fair2: number;
  book: string | null;
  price1: number | null;
  price2: number | null;
  edge1: number | null;
  edge2: number | null;
  homeMean: number;
  awayMean: number;
  actual: number | null;
}

interface Game {
  id: number;
  startAt: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  home?: { abbr: string; name: string };
  away?: { abbr: string; name: string };
  projections: Proj[];
}

type GamesResp = { dbConfigured: false } | { dbConfigured: true; games: Game[]; lastRun: string | null; threshold: number; maxOdds: number };

const GRID = "92px 1.3fr 110px 130px 130px 1.4fr";
const half = (x: number) => Math.round(x * 2) / 2;

function bestEdge(g: Game) {
  let best: { label: string; edge: number; price: number; book: string | null } | null = null;
  for (const p of g.projections) {
    for (const side of [1, 2] as const) {
      const e = side === 1 ? p.edge1 : p.edge2;
      const price = side === 1 ? p.price1 : p.price2;
      if (e == null || price == null) continue;
      if (!best || e > best.edge) best = { label: sideLabel(p.market, side, p.line, g.home?.abbr ?? "Hemma", g.away?.abbr ?? "Borta"), edge: e, price, book: p.book };
    }
  }
  return best;
}

function GamesTab({ past }: { past: boolean }) {
  const [days, setDays] = useState(past ? 3 : 2);
  const [data, setData] = useState<GamesResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api
      .get<GamesResp>(`/api/nba/games?days=${days}${past ? "&past=1" : ""}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta matcher"));
  }, [days, past]);
  if (error) return <NbaEmpty title="Kunde inte hämta matcher" hint={error} />;
  if (data && !data.dbConfigured) return <NbaNoDb />;
  const rows = data && data.dbConfigured ? data.games : [];
  const threshold = data && data.dbConfigured ? data.threshold : 0.05;
  const maxOdds = data && data.dbConfigured ? data.maxOdds : 4;
  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="ap-seg">
          {(past ? [3, 7, 14] : [1, 2, 7]).map((d) => (
            <button key={d} className={days === d ? "is-active" : ""} onClick={() => setDays(d)}>
              {d === 1 ? "1 dag" : `${d} dagar`}
            </button>
          ))}
        </div>
        {data && data.dbConfigured && data.lastRun && (
          <span style={{ fontSize: 12, color: "var(--dim2)" }}>Senast räknad {dateLabel(data.lastRun)}</span>
        )}
      </div>
      {!data && <Card>Laddar…</Card>}
      {data && rows.length === 0 && (
        <NbaEmpty
          title={past ? "Inga spelade matcher i perioden" : "Inga kommande matcher med projektion"}
          hint={past ? undefined : "Kör npm run nba:update på datorn — den hämtar matcher, skador och odds och räknar priserna."}
        />
      )}
      {rows.length > 0 && (
        <Card style={{ padding: 0 }}>
          <div className="ap-nba-scroll">
            <div className="ap-table" style={{ minWidth: 760 }}>
              <div className="ap-thead" style={{ gridTemplateColumns: GRID }}>
                <span>Start</span>
                <span>Match</span>
                <span className="ap-r">{past ? "Resultat" : "Modell"}</span>
                <span className="ap-r">Spread modell / marknad</span>
                <span className="ap-r">Total modell / marknad</span>
                <span>{past ? "Facit" : `Bästa edge (≥ ${Math.round(threshold * 100)} % markeras)`}</span>
              </div>
              {rows.map((g) => {
                const any = g.projections[0];
                const spread = g.projections.find((p) => p.market === "spread");
                const total = g.projections.find((p) => p.market === "total");
                const be = bestEdge(g);
                const flagged = !past && be != null && be.edge >= threshold && be.price <= maxOdds;
                return (
                  <Link
                    key={g.id}
                    href={`/nba/match/${g.id}`}
                    className={`ap-trow${flagged ? " ap-nba-flag" : ""}`}
                    style={{ gridTemplateColumns: GRID, color: "inherit", textDecoration: "none" }}
                  >
                    <span className="ap-num" style={{ color: g.status === "live" ? "var(--red)" : "var(--dim)" }}>
                      {g.status === "live" ? "LIVE" : dateLabel(g.startAt)}
                    </span>
                    <span className="ap-ell">
                      {g.away?.name ?? "?"} <span style={{ color: "var(--dim2)" }}>@</span> <b>{g.home?.name ?? "?"}</b>
                    </span>
                    <span className="ap-r ap-num">
                      {past
                        ? `${g.awayScore ?? "–"}–${g.homeScore ?? "–"}`
                        : any
                          ? `${any.awayMean.toFixed(0)}–${any.homeMean.toFixed(0)}`
                          : "—"}
                    </span>
                    <span className="ap-r ap-num">
                      {any ? signed(half(any.awayMean - any.homeMean)) : "—"} / {spread ? signed(spread.line) : "—"}
                    </span>
                    <span className="ap-r ap-num">
                      {any ? half(any.awayMean + any.homeMean).toString().replace(".", ",") : "—"} / {total?.line?.toString().replace(".", ",") ?? "—"}
                    </span>
                    <span className="ap-ell">
                      {past ? (
                        // Modellens val (viktad sannolikhet över 50 %) mot utfallet.
                        g.projections
                          .filter((p) => p.actual != null)
                          .map((p) => {
                            const pick: 1 | 2 = p.pFinal >= 0.5 ? 1 : 2;
                            const res = p.actual === 0.5 ? "push" : (pick === 1) === (p.actual === 1) ? "✓" : "✗";
                            return `${sideLabel(p.market, pick, p.line, g.home?.abbr ?? "H", g.away?.abbr ?? "B")} ${res}`;
                          })
                          .join(" · ") || "—"
                      ) : be ? (
                        <>
                          <b className={be.edge >= 0 ? "pos" : "neg"}>{(be.edge * 100).toFixed(1)} %</b> {be.label} @ {be.price.toFixed(2)}
                          {be.book ? <span style={{ color: "var(--dim2)" }}> · {be.book}</span> : null}
                        </>
                      ) : (
                        <span style={{ color: "var(--dim2)" }}>inget pris än</span>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </Card>
      )}
      {!past && rows.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--dim2)", marginTop: 10 }}>
          Spread i hemmalagets perspektiv (− = hemma favorit). Edge = förväntad vinst per satsad enhet mot priset, efter att modellen
          vägts mot marknaden. Markeras bara upp till odds {String(maxOdds).replace(".", ",")} — på längre odds är modellen för osäker.
        </p>
      )}
    </>
  );
}

interface LiveRow {
  market: Market;
  n: number;
  logLossModel: number | null;
  logLossFinal: number | null;
  logLossMarket: number | null;
  nMarket: number;
  bets: number;
  roi: number | null;
}

interface RunMetrics {
  games: number;
  books: string[];
  margin: { maeModel: number; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  total: { maeModel: number; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  markets: Partial<Record<Market, { n: number; logLossModel: number; logLossMarket: number; bestW: number; bets: number; roi: number | null }>>;
}

type FacitResp =
  | { dbConfigured: false }
  | { dbConfigured: true; threshold: number; live: LiveRow[]; runs: Array<{ id: number; createdAt: string; modelVersion: string; fromDate: string; toDate: string; games: number; metrics: RunMetrics }> };

const f = (x: number | null | undefined, d = 3) => (x == null ? "—" : x.toFixed(d).replace(".", ","));

function FacitTab() {
  const [data, setData] = useState<FacitResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<FacitResp>("/api/nba/facit")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta facit"));
  }, []);
  if (error) return <NbaEmpty title="Kunde inte hämta facit" hint={error} />;
  if (!data) return <Card>Laddar…</Card>;
  if (!data.dbConfigured) return <NbaNoDb />;
  const LG = "90px 70px 1fr 1fr 1fr 90px 90px";
  return (
    <>
      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Live — modellens sparade priser</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>Lägre log loss = bättre</span>
        </div>
        <div className="ap-nba-scroll">
          <div className="ap-table" style={{ minWidth: 640 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: LG }}>
              <span>Marknad</span>
              <span className="ap-r">Avgjorda</span>
              <span className="ap-r">Log loss modell</span>
              <span className="ap-r">Viktad</span>
              <span className="ap-r">Marknad</span>
              <span className="ap-r">Spel ≥ {Math.round(data.threshold * 100)} %</span>
              <span className="ap-r">ROI</span>
            </div>
            {data.live.map((r) => (
              <div key={r.market} className="ap-trow" style={{ gridTemplateColumns: LG }}>
                <span>{r.market}</span>
                <span className="ap-r ap-num">{r.n}</span>
                <span className="ap-r ap-num">{f(r.logLossModel, 4)}</span>
                <span className="ap-r ap-num">{f(r.logLossFinal, 4)}</span>
                <span className="ap-r ap-num">{f(r.logLossMarket, 4)}</span>
                <span className="ap-r ap-num">{r.bets}</span>
                <span className={`ap-r ap-num ${r.roi == null ? "" : r.roi >= 0 ? "pos" : "neg"}`}>{r.roi == null ? "—" : pct(r.roi, 1)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
      {data.runs.length === 0 && (
        <NbaEmpty title="Ingen sparad backtest än" hint="Kör npm run nba:backtest -- --save på datorn för att se hur modellen gått mot stängningspriset." />
      )}
      {data.runs.map((r) => {
        const m = r.metrics;
        return (
          <Card key={r.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <b>
                Backtest #{r.id} · {r.modelVersion}
              </b>
              <span style={{ fontSize: 12, color: "var(--dim2)" }}>
                {r.fromDate.slice(0, 10)} → {r.toDate.slice(0, 10)} · {r.games} matcher · stängning: {m.books.join(", ") || "—"}
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              Marginal: MAE modell {f(m.margin.maeModel, 2)} / marknad {f(m.margin.maeMarket, 2)}, bias {f(m.margin.bias, 2)}, spridning verklig{" "}
              {f(m.margin.residualSd, 1)} / sim {f(m.margin.simSd, 1)}
              <br />
              Total: MAE modell {f(m.total.maeModel, 2)} / marknad {f(m.total.maeMarket, 2)}, bias {f(m.total.bias, 2)}, spridning verklig{" "}
              {f(m.total.residualSd, 1)} / sim {f(m.total.simSd, 1)}
              {Object.entries(m.markets).map(([k, x]) =>
                x ? (
                  <div key={k}>
                    <b>{k}</b>: n {x.n}, log loss modell {f(x.logLossModel, 4)} / marknad {f(x.logLossMarket, 4)}, bästa modellvikt{" "}
                    <b>{x.bestW}</b>, spel ≥ 5 %: {x.bets}
                    {x.roi != null ? `, ROI ${pct(x.roi, 1)}` : ""}
                  </div>
                ) : null
              )}
            </div>
          </Card>
        );
      })}
    </>
  );
}

type Tab = "kommande" | "spelade" | "facit";

export default function NbaPage() {
  const [tab, setTab] = useState<Tab>("kommande");
  return (
    <div className="ap-nba">
      <Topbar title="NBA" sub="Spelarbaserad simulering viktad mot marknaden — vinnare, spread och total" icon={SPORT_IC.basketball} accent="amber" />
      <div className="ap-seg ap-nba-tabs">
        <button className={tab === "kommande" ? "is-active" : ""} onClick={() => setTab("kommande")}>
          Kommande
        </button>
        <button className={tab === "spelade" ? "is-active" : ""} onClick={() => setTab("spelade")}>
          Spelade
        </button>
        <button className={tab === "facit" ? "is-active" : ""} onClick={() => setTab("facit")}>
          Facit
        </button>
      </div>
      {tab === "kommande" && <GamesTab key="k" past={false} />}
      {tab === "spelade" && <GamesTab key="s" past />}
      {tab === "facit" && <FacitTab />}
    </div>
  );
}
