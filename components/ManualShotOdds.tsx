"use client";

/**
 * Prissätter skott- och hörnlinjer mot odds du matar in själv.
 *
 * TheStatsAPI täcker bara bet365 UK, BetMGM UK, Paddy Power, Pinnacle och
 * Betfair. Betsson, Bethard och NordicBet — som har skottlinjer på Allsvenskan
 * — finns inte där. Modellen har siffrorna ändå, så det som saknas är bara
 * priset: skriv in det och få fair odds, edge och insats.
 *
 * Räknar lokalt ur λ och dispersion (lib/shotModel är rent räknande), så
 * siffrorna uppdateras medan du skriver utan ett anrop per tangenttryck.
 */

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui";
import { InlineStat, MiniStat } from "@/components/stats";
import { api } from "@/lib/fetcher";
import { kellyAdvice } from "@/lib/staking";
import {
  correlatedTotalPmf,
  lineProbs,
  negBinPmfVector,
  marketProbOver,
  applyCalibration,
  blendProb,
  priceEdge,
  fairOdds,
  DEFAULT_BLEND_W,
  type MatchSide,
} from "@/lib/shotModel";
import type { FixtureProjection } from "@/lib/shotScreen";

interface FixturesResponse {
  fixtures: FixtureProjection[];
  leagues: Array<{ key: string; label: string }>;
  dbConfigured: boolean;
}

const num = (v: string) => parseFloat(v.replace(",", "."));
const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;

function kickoffLabel(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ManualShotOdds({
  bankrollUnits,
  blendW = DEFAULT_BLEND_W,
}: {
  bankrollUnits: number;
  /** Samma vikt som screenens reglage — annars visar sidan två olika tal. */
  blendW?: number;
}) {
  const [data, setData] = useState<FixturesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [matchId, setMatchId] = useState("");
  const [metric, setMetric] = useState("corners");
  const [side, setSide] = useState<MatchSide>("match");
  const [line, setLine] = useState("9.5");
  const [overOdds, setOverOdds] = useState("");
  const [underOdds, setUnderOdds] = useState("");
  const [book, setBook] = useState("Betsson");

  useEffect(() => {
    let cancelled = false;
    api
      .get<FixturesResponse>("/api/shots/fixtures?days=14")
      .then((r) => {
        if (cancelled) return;
        setData(r);
        if (r.fixtures.length > 0) setMatchId((cur) => cur || r.fixtures[0].matchId);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const fixture = data?.fixtures.find((f) => f.matchId === matchId) ?? null;
  const projection = fixture?.metrics.find((m) => m.metric === metric) ?? null;

  const result = useMemo(() => {
    if (!projection) return null;
    const l = num(line);
    if (!Number.isFinite(l) || l < 0) return null;

    const phi = projection.dispersion;
    const pmf =
      side === "home"
        ? negBinPmfVector(projection.home, phi)
        : side === "away"
          ? negBinPmfVector(projection.away, phi)
          : correlatedTotalPmf(projection.home, projection.away, phi, projection.rho);

    const lp = lineProbs(pmf, l);
    // Samma omkalibrering som backtestet mäter modellen med.
    const pModel = applyCalibration(lp.pOverNoPush, {
      a: projection.calA,
      b: projection.calB,
      n: projection.calN,
    });
    const lambda = side === "home" ? projection.home : side === "away" ? projection.away : projection.total;

    const over = num(overOdds);
    const under = num(underOdds);
    const hasOver = Number.isFinite(over) && over > 1;
    const hasUnder = Number.isFinite(under) && under > 1;
    if (!hasOver && !hasUnder) return { pModel, lambda, pPush: lp.pPush, phi, priced: null };

    // Dina egna odds är den enda marknadsinformationen som finns här. Är båda
    // sidor angivna går de att avvigga till en riktig referens; annars är
    // fair odds ren modell.
    const pMarket = hasOver && hasUnder ? marketProbOver(over, under) : null;
    const pFinal = blendProb(pModel, pMarket, blendW);

    const edgeOver = hasOver ? priceEdge(over, pFinal) : -Infinity;
    const edgeUnder = hasUnder ? priceEdge(under, 1 - pFinal) : -Infinity;
    const takeOver = edgeOver >= edgeUnder;
    const edge = Math.max(edgeOver, edgeUnder);
    const takenOdds = takeOver ? over : under;
    const takenProb = takeOver ? pFinal : 1 - pFinal;
    const kelly = kellyAdvice(takenOdds, takenProb, bankrollUnits);

    return {
      pModel,
      lambda,
      pPush: lp.pPush,
      phi,
      priced: {
        pMarket,
        pFinal,
        side: takeOver ? ("over" as const) : ("under" as const),
        odds: takenOdds,
        fair: fairOdds(takenProb),
        edge,
        kelly,
      },
    };
  }, [projection, side, line, overOdds, underOdds, bankrollUnits, blendW]);

  if (loading) {
    return (
      <Card>
        <div className="ap-card-head">
          <span className="ap-card-title">Räkna på egna odds</span>
        </div>
        <div style={{ color: "var(--dim2)", fontSize: 13 }}>Laddar matcher…</div>
      </Card>
    );
  }

  if (!data?.dbConfigured || data.fixtures.length === 0) {
    return (
      <Card>
        <div className="ap-card-head">
          <span className="ap-card-title">Räkna på egna odds</span>
        </div>
        <div style={{ color: "var(--dim2)", fontSize: 13 }}>
          Inga kommande matcher med modell. Kör <code>npm run shots:ingest</code> först.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="ap-card-head">
        <span className="ap-card-title">Räkna på egna odds</span>
        <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>
          För böcker API:et inte täcker — Betsson, Bethard, NordicBet
        </span>
      </div>

      <div className="ap-shot-manual">
        <div className="ap-field" style={{ minWidth: 260, flex: "2 1 260px" }}>
          <label htmlFor="mo-match">Match</label>
          <div className="ap-select">
            <select id="mo-match" value={matchId} onChange={(e) => setMatchId(e.target.value)}>
              {data.fixtures.map((f) => (
                <option key={f.matchId} value={f.matchId}>
                  {kickoffLabel(f.kickoffAt)} · {f.homeTeam}–{f.awayTeam} ({f.leagueLabel})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="ap-field" style={{ minWidth: 130 }}>
          <label htmlFor="mo-metric">Marknad</label>
          <div className="ap-select">
            <select id="mo-metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
              {(fixture?.metrics ?? []).map((m) => (
                <option key={m.metric} value={m.metric}>
                  {m.metricLabel}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="ap-field" style={{ minWidth: 150 }}>
          <label htmlFor="mo-side">Avser</label>
          <div className="ap-select">
            <select id="mo-side" value={side} onChange={(e) => setSide(e.target.value as MatchSide)}>
              <option value="match">Matchen</option>
              <option value="home">{fixture?.homeTeam ?? "Hemmalag"}</option>
              <option value="away">{fixture?.awayTeam ?? "Bortalag"}</option>
            </select>
          </div>
        </div>

        <div className="ap-field" style={{ width: 92 }}>
          <label htmlFor="mo-line">Linje</label>
          <input
            id="mo-line"
            className="ap-input ap-num"
            inputMode="decimal"
            value={line}
            onChange={(e) => setLine(e.target.value)}
          />
        </div>

        <div className="ap-field" style={{ width: 100 }}>
          <label htmlFor="mo-over">Över</label>
          <input
            id="mo-over"
            className="ap-input ap-num"
            inputMode="decimal"
            placeholder="1.90"
            value={overOdds}
            onChange={(e) => setOverOdds(e.target.value)}
          />
        </div>

        <div className="ap-field" style={{ width: 100 }}>
          <label htmlFor="mo-under">Under</label>
          <input
            id="mo-under"
            className="ap-input ap-num"
            inputMode="decimal"
            placeholder="1.90"
            value={underOdds}
            onChange={(e) => setUnderOdds(e.target.value)}
          />
        </div>

        <div className="ap-field" style={{ width: 130 }}>
          <label htmlFor="mo-book">Bokmakare</label>
          <input id="mo-book" className="ap-input" value={book} onChange={(e) => setBook(e.target.value)} />
        </div>
      </div>

      {result && (
        <>
          <div className="ap-shot-summary">
            <InlineStat label="Modellens väntevärde" value={result.lambda.toFixed(2)} />
            <InlineStat label="Modell P(över)" value={pct1(result.pModel)} />
            {result.pPush > 0 && <InlineStat label="Push" value={pct1(result.pPush)} />}
            {result.priced && (
              <>
                <InlineStat
                  label="Fair odds"
                  value={result.priced.fair.toFixed(2)}
                />
                <InlineStat
                  label={`Edge mot ${book || "boken"}`}
                  value={signedPct(result.priced.edge)}
                  tone={result.priced.edge > 0 ? "pos" : "neg"}
                />
              </>
            )}
          </div>

          {result.priced && (
            <div style={{ marginTop: 12, fontWeight: 700, fontSize: 14 }}>
              {result.priced.edge > 0 ? (
                <>
                  Spela <strong>{result.priced.side === "over" ? "över" : "under"} {line.replace(".", ",")}</strong> till{" "}
                  <span className="ap-num">{result.priced.odds.toFixed(2)}</span> — fair är{" "}
                  <span className="ap-num">{result.priced.fair.toFixed(2)}</span>, ½ Kelly{" "}
                  <span className="ap-num">{result.priced.kelly.halfUnits.toFixed(2)}</span> u
                </>
              ) : (
                <>Ingen edge — {book || "boken"} ligger under fair odds på båda sidor.</>
              )}
            </div>
          )}

          {result.priced && result.priced.pMarket == null && (
            <div className="ap-shot-warn" style={{ marginTop: 10 }}>
              Bara en sida angiven, så det finns ingen marknadsreferens — fair odds kommer helt ur
              modellen. Fyll i båda sidor för att avvigga bokens egen linje och få ett stabilare tal.
            </div>
          )}

          <div className="ap-shot-warn" style={{ marginTop: 10 }}>
            Skottmodellen är <strong>inte backtestad</strong> — historiken saknar skottlinjer, så
            ingen vet ännu om den slår marknaden. På hörnor är den bevisligen sämre än bet365. Använd
            siffran som utgångspunkt, inte som facit.
          </div>
        </>
      )}

      <details className="ap-fine">
        <summary>Så räknas det</summary>
        <div className="ap-fine-details">
          λ kommer ur lagens anfalls- och försvarsratings mot ligasnittet, byggda på {" "}
          {data.fixtures.length > 0 ? "hela den inlästa historiken" : "historiken"}. Fördelningen är
          negativ binomial med dispersion φ = {result?.phi && Number.isFinite(result.phi) ? result.phi.toFixed(0) : "∞"};
          matchtotalen tar hänsyn till att lagen är negativt korrelerade (ρ = {projection ? projection.rho.toFixed(2) : "—"}) — de delar på bollen. Anger du båda sidor avviggas de
          proportionellt till en marknadsreferens som vägs in med {Math.round(blendW * 100)} %
          modellvikt (reglaget ovan). Edge är EV per satsad enhet: <em>odds × P − 1</em>.
        </div>
      </details>
    </Card>
  );
}
