"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
  book: string | null;
  price1: number | null;
  price2: number | null;
  edge1: number | null;
  edge2: number | null;
  homeMean: number;
  awayMean: number;
  actual: number | null;
}

interface Pick {
  market: "spread" | "total";
  book: string;
  line: number;
  modelLine: number;
  side: number;
  edgePts: number;
  price: number;
  result: "W" | "L" | "P" | null;
  clv: number | null;
}

interface Game {
  id: number;
  startAt: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  home?: { abbr: string; name: string };
  away?: { abbr: string; name: string };
  homeRecord: string;
  awayRecord: string;
  picks: Pick[];
  projections: Proj[];
}

type GamesResp = { dbConfigured: false } | { dbConfigured: true; games: Game[]; lastRun: string | null; threshold: number; maxOdds: number };

const num = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));
const BIG_EDGE = 3;

/** Modellens linjer ur projicerat resultat (samma räkning som den låsta picken). */
function modelLines(g: Game) {
  const p = g.projections[0];
  if (!p) return null;
  return {
    home: p.homeMean,
    away: p.awayMean,
    spread: Math.round((p.awayMean - p.homeMean) * 10) / 10,
    total: Math.round((p.awayMean + p.homeMean) * 10) / 10,
  };
}

/** Linjen och modellens sida för en marknad: låst pick om den finns, annars senaste linjen. */
function lineRow(g: Game, market: "spread" | "total") {
  const ml = modelLines(g);
  if (!ml) return null;
  const pick = g.picks.find((k) => k.market === market);
  const proj = g.projections.find((p) => p.market === market);
  const line = pick?.line ?? proj?.line ?? null;
  const model = market === "spread" ? ml.spread : ml.total;
  if (line == null) return { model, line: null, side: null as 1 | 2 | null, edgePts: null as number | null, pick };
  const edgePts = Math.round(Math.abs(model - line) * 10) / 10;
  const side: 1 | 2 = market === "spread" ? (model < line ? 1 : 2) : model > line ? 1 : 2;
  return { model, line, side: (pick?.side as 1 | 2) ?? side, edgePts: pick?.edgePts ?? edgePts, pick };
}

function ResultTag({ r }: { r: "W" | "L" | "P" | null | undefined }) {
  if (!r) return null;
  const cls = r === "W" ? "pos" : r === "L" ? "neg" : "";
  return <b className={cls}>{r === "W" ? "VINST" : r === "L" ? "FÖRLUST" : "PUSH"}</b>;
}

function GameCard({ g, past }: { g: Game; past: boolean }) {
  const ml = modelLines(g);
  const H = g.home?.abbr ?? "H";
  const A = g.away?.abbr ?? "B";
  const rows = (["spread", "total"] as const).map((m) => ({ m, r: lineRow(g, m) }));
  const big = rows.some((x) => (x.r?.edgePts ?? 0) >= BIG_EDGE);
  return (
    <Link href={`/nba/match/${g.id}`} className={`ap-card ap-nba-card${big && !past ? " ap-nba-flag" : ""}`}>
      <div className="ap-nba-card-time">
        {g.status === "live" ? <b style={{ color: "var(--red)" }}>LIVE</b> : dateLabel(g.startAt)}
        {past && g.homeScore != null ? <span className="ap-num"> · slut {g.awayScore}–{g.homeScore}</span> : null}
      </div>
      <div className="ap-nba-card-teams">
        {[
          { t: g.away, rec: g.awayRecord, score: ml?.away },
          { t: g.home, rec: g.homeRecord, score: ml?.home },
        ].map((x, i) => (
          <div key={i} className="ap-nba-card-team">
            <span className="ap-ell">
              <b>{x.t?.name ?? "?"}</b> <span style={{ color: "var(--dim2)" }}>{x.rec}</span>
            </span>
            <span className="ap-num">{num(x.score)}</span>
          </div>
        ))}
      </div>
      <div className="ap-nba-card-lines">
        {rows.map(({ m, r }) => (
          <div key={m} className="ap-nba-card-line">
            <span className="ap-nba-card-label">{m === "spread" ? "Spread" : "Total"}</span>
            {r ? (
              <>
                <span>
                  Marknad <b className="ap-num">{r.line == null ? "—" : m === "spread" ? `${H} ${signed(r.line)}` : num(r.line)}</b>
                </span>
                <span>
                  Modell <b className="ap-num">{m === "spread" ? `${H} ${signed(r.model)}` : num(r.model)}</b>
                </span>
                {r.line != null && r.side ? (
                  <span>
                    Pick{" "}
                    <b className="ap-num">
                      {sideLabel(m, r.side, r.line, H, A)} ({num(r.edgePts)})
                    </b>
                    {r.pick ? <span style={{ color: "var(--dim2)" }}> · låst</span> : null}
                    {past && r.pick?.result ? (
                      <>
                        {" "}
                        <ResultTag r={r.pick.result} />
                      </>
                    ) : null}
                  </span>
                ) : (
                  <span style={{ color: "var(--dim2)" }}>ingen linje än</span>
                )}
              </>
            ) : (
              <span style={{ color: "var(--dim2)" }}>ingen projektion</span>
            )}
          </div>
        ))}
      </div>
    </Link>
  );
}

function GamesTab({ past }: { past: boolean }) {
  const [days, setDays] = useState(past ? 3 : 2);
  const [only3, setOnly3] = useState(false);
  const [data, setData] = useState<GamesResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api
      .get<GamesResp>(`/api/nba/games?days=${days}${past ? "&past=1" : ""}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta matcher"));
  }, [days, past]);
  const games = useMemo(() => (data && data.dbConfigured ? data.games : []), [data]);
  const stats = useMemo(() => {
    let disagree = 0;
    let biggest: { g: Game; m: string; e: number } | null = null;
    for (const g of games) {
      let any = false;
      for (const m of ["spread", "total"] as const) {
        const e = lineRow(g, m)?.edgePts;
        if (e == null) continue;
        if (e >= BIG_EDGE) any = true;
        if (!biggest || e > biggest.e) biggest = { g, m, e };
      }
      if (any) disagree++;
    }
    return { disagree, biggest };
  }, [games]);
  if (error) return <NbaEmpty title="Kunde inte hämta matcher" hint={error} />;
  if (data && !data.dbConfigured) return <NbaNoDb />;
  const shown = only3 ? games.filter((g) => (["spread", "total"] as const).some((m) => (lineRow(g, m)?.edgePts ?? 0) >= BIG_EDGE)) : games;
  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="ap-seg">
          {(past ? [3, 7, 14] : [1, 2, 7]).map((d) => (
            <button key={d} className={days === d ? "is-active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d === 1 ? "1 dag" : `${d} dagar`}
            </button>
          ))}
        </div>
        <div className="ap-seg">
          <button className={!only3 ? "is-active" : ""} aria-pressed={!only3} onClick={() => setOnly3(false)}>
            Alla
          </button>
          <button className={only3 ? "is-active" : ""} aria-pressed={only3} onClick={() => setOnly3(true)}>
            Edge {BIG_EDGE}+
          </button>
        </div>
        {data && data.dbConfigured && data.lastRun && (
          <span style={{ fontSize: 12, color: "var(--dim2)" }}>Senast räknad {dateLabel(data.lastRun)}</span>
        )}
      </div>
      {data && games.length > 0 && (
        <div className="ap-nba-tiles">
          <div className="ap-card">
            <small>Matcher</small>
            <b className="ap-num">{games.length}</b>
          </div>
          <div className="ap-card">
            <small>Modellen avviker {BIG_EDGE}+</small>
            <b className="ap-num">{stats.disagree}</b>
          </div>
          <div className="ap-card">
            <small>Största avvikelse</small>
            <b className="ap-num">{stats.biggest ? num(stats.biggest.e) : "—"}</b>
            {stats.biggest ? (
              <span style={{ fontSize: 12, color: "var(--dim2)" }}>
                {stats.biggest.g.away?.abbr} @ {stats.biggest.g.home?.abbr} · {stats.biggest.m === "spread" ? "spread" : "total"}
              </span>
            ) : null}
          </div>
        </div>
      )}
      {!data && <Card>Laddar…</Card>}
      {data && shown.length === 0 && (
        <NbaEmpty
          title={only3 ? `Ingen match där modellen avviker ${BIG_EDGE}+ poäng` : past ? "Inga spelade matcher i perioden" : "Inga kommande matcher med projektion"}
          hint={past || only3 ? undefined : "Kör npm run nba:update på datorn — den hämtar matcher, skador och odds och räknar priserna."}
        />
      )}
      <div className="ap-nba-cards">
        {shown.map((g) => (
          <GameCard key={g.id} g={g} past={past} />
        ))}
      </div>
      {shown.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--dim2)", marginTop: 10 }}>
          Spread i hemmalagets perspektiv (− = hemma favorit). Talet i parentes är edgen i poäng: modellens linje mot marknadens. Picken låses mot
          första linjen modellen ser och prissätts aldrig om. Matcher där modellen avviker {BIG_EDGE}+ poäng markeras.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Facit
// ---------------------------------------------------------------------------

interface BucketRecord {
  minEdge: number;
  w: number;
  l: number;
  p: number;
  hit: number | null;
  roi: number | null;
  clv: number | null;
}

interface PickRow {
  id: number;
  startAt: string;
  market: "spread" | "total";
  home: string;
  away: string;
  line: number;
  modelLine: number;
  side: number;
  edgePts: number;
  book: string;
  result: "W" | "L" | "P";
  clv: number | null;
  homeScore: number | null;
  awayScore: number | null;
}

interface LiveRow {
  market: Market;
  n: number;
  logLossModel: number | null;
  logLossFinal: number | null;
  logLossMarket: number | null;
  bets: number;
  roi: number | null;
}

interface RunMetrics {
  games: number;
  books: string[];
  margin: { maeModel: number; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  total: { maeModel: number; maeMarket: number | null; bias: number; residualSd: number; simSd: number };
  markets: Partial<Record<Market, { n: number; logLossModel: number; logLossMarket: number; bestW: number; bets: number; roi: number | null }>>;
  ats?: Partial<Record<"spread" | "total", BucketRecord[]>>;
}

type FacitResp =
  | { dbConfigured: false }
  | {
      dbConfigured: true;
      threshold: number;
      breakEven: number;
      live: LiveRow[];
      picks: { records: Record<"spread" | "total", BucketRecord[]>; list: PickRow[] };
      runs: Array<{ id: number; createdAt: string; modelVersion: string; fromDate: string; toDate: string; games: number; metrics: RunMetrics }>;
    };

const f = (x: number | null | undefined, d = 3) => (x == null ? "—" : x.toFixed(d).replace(".", ","));

function BucketTiles({ records, selected, onSelect }: { records: BucketRecord[]; selected?: number; onSelect?: (m: number) => void }) {
  return (
    <div className="ap-nba-tiles">
      {records.map((b) => (
        <button
          key={b.minEdge}
          type="button"
          className={`ap-card${selected === b.minEdge ? " ap-nba-flag" : ""}`}
          onClick={() => onSelect?.(b.minEdge)}
          style={{ textAlign: "left", cursor: onSelect ? "pointer" : "default" }}
        >
          <small>{b.minEdge === 0 ? "Alla picks" : `Edge ${b.minEdge}+`}</small>
          <b className="ap-num">
            {b.w}-{b.l}-{b.p}
          </b>
          <span style={{ fontSize: 12, color: "var(--dim2)" }}>
            {b.hit == null ? "—" : pct(b.hit, 1)}
            {b.roi != null ? ` · ROI ${pct(b.roi, 1)}` : ""}
            {b.clv != null ? ` · CLV ${signed(Math.round(b.clv * 10) / 10)}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

function FacitTab() {
  const [data, setData] = useState<FacitResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<"spread" | "total">("spread");
  const [minEdge, setMinEdge] = useState(0);
  useEffect(() => {
    api
      .get<FacitResp>("/api/nba/facit")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta facit"));
  }, []);
  if (error) return <NbaEmpty title="Kunde inte hämta facit" hint={error} />;
  if (!data) return <Card>Laddar…</Card>;
  if (!data.dbConfigured) return <NbaNoDb />;
  const list = data.picks.list.filter((k) => k.market === market && k.edgePts >= minEdge);
  const PG = "92px 1fr 1.3fr 70px 70px 80px";
  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="ap-seg">
          <button className={market === "spread" ? "is-active" : ""} aria-pressed={market === "spread"} onClick={() => setMarket("spread")}>
            Spread
          </button>
          <button className={market === "total" ? "is-active" : ""} aria-pressed={market === "total"} onClick={() => setMarket("total")}>
            Total
          </button>
        </div>
        <span style={{ fontSize: 12, color: "var(--dim2)" }}>
          Låsta picks mot första linjen. Break-even vid 1,91 (−110): {pct(data.breakEven, 1)}. Få spel = mest brus.
        </span>
      </div>
      <BucketTiles records={data.picks.records[market]} selected={minEdge} onSelect={setMinEdge} />
      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-nba-scroll">
          <div className="ap-table" style={{ minWidth: 640 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: PG }}>
              <span>Datum</span>
              <span>Match</span>
              <span>Pick (edge)</span>
              <span className="ap-r">Resultat</span>
              <span className="ap-r">CLV</span>
              <span className="ap-r">Facit</span>
            </div>
            {list.length === 0 && (
              <div className="ap-trow" style={{ gridTemplateColumns: "1fr", color: "var(--dim2)" }}>
                Inga rättade picks än — de låses av npm run nba:update och rättas dagen efter.
              </div>
            )}
            {list.map((k) => (
              <div key={k.id} className="ap-trow" style={{ gridTemplateColumns: PG }}>
                <span className="ap-num" style={{ color: "var(--dim)" }}>
                  {k.startAt.slice(0, 10)}
                </span>
                <span className="ap-ell">
                  {k.away} @ {k.home}
                </span>
                <span className="ap-ell ap-num">
                  {sideLabel(k.market, k.side === 1 ? 1 : 2, k.line, k.home, k.away)} ({num(k.edgePts)})
                </span>
                <span className="ap-r ap-num">
                  {k.awayScore}–{k.homeScore}
                </span>
                <span className={`ap-r ap-num ${k.clv == null ? "" : k.clv >= 0 ? "pos" : "neg"}`}>{k.clv == null ? "—" : signed(k.clv)}</span>
                <span className="ap-r">
                  <ResultTag r={k.result} />
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {data.runs.length === 0 && (
        <NbaEmpty title="Ingen sparad backtest än" hint="Kör npm run nba:backtest -- --save på datorn för att se hur modellen gått mot stängningslinjen." />
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
                {r.fromDate.slice(0, 10)} → {r.toDate.slice(0, 10)} · {r.games} matcher · mot stängning: {m.books.join(", ") || "—"}
              </span>
            </div>
            {m.ats?.[market] && (
              <>
                <div style={{ fontSize: 12, color: "var(--dim2)", marginBottom: 6 }}>Picks mot stängningslinjen ({market === "spread" ? "spread" : "total"})</div>
                <BucketTiles records={m.ats[market]!} />
              </>
            )}
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              Marginal: MAE modell {f(m.margin.maeModel, 2)} / marknad {f(m.margin.maeMarket, 2)}, bias {f(m.margin.bias, 2)}
              <br />
              Total: MAE modell {f(m.total.maeModel, 2)} / marknad {f(m.total.maeMarket, 2)}, bias {f(m.total.bias, 2)}
              {Object.entries(m.markets).map(([k, x]) =>
                x ? (
                  <div key={k}>
                    <b>{k}</b>: log loss modell {f(x.logLossModel, 4)} / marknad {f(x.logLossMarket, 4)}, bästa modellvikt <b>{x.bestW}</b>
                  </div>
                ) : null
              )}
            </div>
          </Card>
        );
      })}

      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <span role="heading" aria-level={2} className="ap-card-title">Priser i procent — modellens sparade sannolikheter</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>Lägre log loss = bättre</span>
        </div>
        <div className="ap-nba-scroll">
          <div className="ap-table" style={{ minWidth: 560 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: "90px 70px 1fr 1fr 1fr 80px" }}>
              <span>Marknad</span>
              <span className="ap-r">Avgjorda</span>
              <span className="ap-r">Modell</span>
              <span className="ap-r">Viktad</span>
              <span className="ap-r">Marknad</span>
              <span className="ap-r">ROI ≥ {Math.round(data.threshold * 100)} %</span>
            </div>
            {data.live.map((r) => (
              <div key={r.market} className="ap-trow" style={{ gridTemplateColumns: "90px 70px 1fr 1fr 1fr 80px" }}>
                <span>{r.market}</span>
                <span className="ap-r ap-num">{r.n}</span>
                <span className="ap-r ap-num">{f(r.logLossModel, 4)}</span>
                <span className="ap-r ap-num">{f(r.logLossFinal, 4)}</span>
                <span className="ap-r ap-num">{f(r.logLossMarket, 4)}</span>
                <span className={`ap-r ap-num ${r.roi == null ? "" : r.roi >= 0 ? "pos" : "neg"}`}>{r.roi == null ? "—" : pct(r.roi, 1)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type PropStatKey = "pts" | "reb" | "ast" | "fg3" | "pra";
const PROP_TABS: Array<[PropStatKey, string]> = [
  ["pts", "Poäng"],
  ["reb", "Returer"],
  ["ast", "Assist"],
  ["fg3", "Trepoängare"],
  ["pra", "PRA"],
];

interface PropRow {
  gameId: number;
  startAt: string;
  matchup: string;
  team: string;
  playerId: number;
  name: string;
  stat: PropStatKey;
  minutes: number;
  mean: number;
  q10: number;
  q90: number;
  line: number | null;
  book: string | null;
  over: number | null;
  under: number | null;
  pModel: number | null;
  pMarket: number | null;
  edgeOver: number | null;
  edgeUnder: number | null;
}

interface PropFacit {
  stat: PropStatKey;
  n: number;
  mae: number | null;
  coverage: number | null;
  bets: number;
  w: number;
  l: number;
  roi: number | null;
}

type PropsResp = { dbConfigured: false } | { dbConfigured: true; threshold: number; maxOdds: number; props: PropRow[]; facit: PropFacit[] };

function PropsTab() {
  const [data, setData] = useState<PropsResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stat, setStat] = useState<PropStatKey>("pts");
  const [onlyLines, setOnlyLines] = useState(true);
  useEffect(() => {
    api
      .get<PropsResp>("/api/nba/props?days=2")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta props"));
  }, []);
  if (error) return <NbaEmpty title="Kunde inte hämta props" hint={error} />;
  if (!data) return <Card>Laddar…</Card>;
  if (!data.dbConfigured) return <NbaNoDb />;
  const best = (r: PropRow) => {
    const eo = r.edgeOver ?? -9;
    const eu = r.edgeUnder ?? -9;
    return eo >= eu ? { side: "Över", edge: r.edgeOver, price: r.over } : { side: "Under", edge: r.edgeUnder, price: r.under };
  };
  const rows = data.props
    .filter((r) => r.stat === stat && (!onlyLines || r.line != null))
    .sort((a, b) => (best(b).edge ?? -9) - (best(a).edge ?? -9) || b.mean - a.mean);
  const f = data.facit.find((x) => x.stat === stat);
  const PG = "1.1fr 1.4fr 56px 70px 90px 1.3fr 80px";
  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="ap-seg">
          {PROP_TABS.map(([k, l]) => (
            <button key={k} className={stat === k ? "is-active" : ""} aria-pressed={stat === k} onClick={() => setStat(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="ap-seg">
          <button className={onlyLines ? "is-active" : ""} aria-pressed={onlyLines} onClick={() => setOnlyLines(true)}>
            Med linje
          </button>
          <button className={!onlyLines ? "is-active" : ""} aria-pressed={!onlyLines} onClick={() => setOnlyLines(false)}>
            Alla spelare
          </button>
        </div>
      </div>
      {f && f.n > 0 && (
        <div className="ap-nba-tiles">
          <div className="ap-card">
            <small>Rättade projektioner</small>
            <b className="ap-num">{f.n}</b>
            <span style={{ fontSize: 12, color: "var(--dim2)" }}>medelfel {num(f.mae)}</span>
          </div>
          <div className="ap-card">
            <small>Inom 10–90 % (mål 80 %)</small>
            <b className="ap-num">{f.coverage == null ? "—" : pct(f.coverage, 0)}</b>
          </div>
          <div className="ap-card">
            <small>Markerade spel</small>
            <b className="ap-num">
              {f.w}-{f.l}
            </b>
            <span style={{ fontSize: 12, color: "var(--dim2)" }}>{f.roi == null ? "—" : `ROI ${pct(f.roi, 1)}`}</span>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <NbaEmpty
          title={onlyLines ? "Inga prop-linjer än" : "Inga projektioner än"}
          hint={
            onlyLines
              ? "Linjer kommer från OddsPapi om din plan har props, annars lägger du in dem på matchsidan. Byt till Alla spelare för att se modellens projektioner."
              : "Kör npm run nba:update på datorn."
          }
        />
      ) : (
        <Card style={{ padding: 0 }}>
          <div className="ap-nba-scroll">
            <div className="ap-table" style={{ minWidth: 720 }}>
              <div className="ap-thead" style={{ gridTemplateColumns: PG }}>
                <span>Match</span>
                <span>Spelare</span>
                <span className="ap-r">Min</span>
                <span className="ap-r">Modell</span>
                <span className="ap-r">10–90 %</span>
                <span>Linje · bästa sida</span>
                <span className="ap-r">Edge</span>
              </div>
              {rows.map((r) => {
                const b = best(r);
                const flagged = b.edge != null && b.price != null && b.edge >= data.threshold && b.price <= data.maxOdds;
                return (
                  <Link
                    key={`${r.gameId}-${r.playerId}`}
                    href={`/nba/match/${r.gameId}`}
                    className={`ap-trow${flagged ? " ap-nba-flag" : ""}`}
                    style={{ gridTemplateColumns: PG, color: "inherit", textDecoration: "none" }}
                  >
                    <span className="ap-ell" style={{ color: "var(--dim)" }}>
                      {r.matchup}
                    </span>
                    <span className="ap-ell">
                      <b>{r.name}</b> <span style={{ color: "var(--dim2)", fontSize: 11 }}>{r.team}</span>
                    </span>
                    <span className="ap-r ap-num">{num(r.minutes, 0)}</span>
                    <span className="ap-r ap-num">
                      <b>{num(r.mean)}</b>
                    </span>
                    <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>
                      {num(r.q10, 0)}–{num(r.q90, 0)}
                    </span>
                    <span className="ap-ell ap-num">
                      {r.line == null ? (
                        <span style={{ color: "var(--dim2)" }}>ingen linje</span>
                      ) : (
                        <>
                          {b.side} {String(r.line).replace(".", ",")} @ {num(b.price, 2)} <span style={{ color: "var(--dim2)" }}>{r.book}</span>
                        </>
                      )}
                    </span>
                    <span className={`ap-r ap-num ${b.edge == null ? "" : b.edge >= 0 ? "pos" : "neg"}`}>{b.edge == null ? "—" : `${(b.edge * 100).toFixed(1)} %`}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </Card>
      )}
      <p style={{ fontSize: 12, color: "var(--dim2)", marginTop: 10 }}>
        Modellen simulerar 5 000 kvällar per spelare (minuter, skott, träff, returer, assist) och väger 15 % mot linjen efter att marginalen räknats
        bort. Markeras vid edge ≥ {Math.round(data.threshold * 100)} % och odds ≤ {String(data.maxOdds).replace(".", ",")}. Klicka för fördelningen.
      </p>
    </>
  );
}

type Tab = "kommande" | "spelade" | "props" | "facit";

export default function NbaPage() {
  const [tab, setTab] = useState<Tab>("kommande");
  return (
    <div className="ap-nba">
      <Topbar title="NBA" sub="Lagrating + spelarjustering, simulerad och jämförd mot marknaden" icon={SPORT_IC.basketball} accent="amber" />
      <div className="ap-seg ap-nba-tabs">
        <button className={tab === "kommande" ? "is-active" : ""} aria-pressed={tab === "kommande"} onClick={() => setTab("kommande")}>
          Kommande
        </button>
        <button className={tab === "spelade" ? "is-active" : ""} aria-pressed={tab === "spelade"} onClick={() => setTab("spelade")}>
          Spelade
        </button>
        <button className={tab === "props" ? "is-active" : ""} aria-pressed={tab === "props"} onClick={() => setTab("props")}>
          Props
        </button>
        <button className={tab === "facit" ? "is-active" : ""} aria-pressed={tab === "facit"} onClick={() => setTab("facit")}>
          Facit
        </button>
      </div>
      {tab === "kommande" && <GamesTab key="k" past={false} />}
      {tab === "spelade" && <GamesTab key="s" past />}
      {tab === "props" && <PropsTab />}
      {tab === "facit" && <FacitTab />}
    </div>
  );
}
