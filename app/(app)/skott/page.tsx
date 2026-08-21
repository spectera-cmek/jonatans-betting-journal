"use client";

import { useEffect, useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty } from "@/components/ui";
import { InlineStat, MiniStat } from "@/components/stats";
import { I, IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import type { ShotScreenRow, ShotScreenMeta } from "@/lib/shotScreen";
import { DEFAULT_BLEND_W } from "@/lib/shotModel";
import { ManualShotOdds } from "@/components/ManualShotOdds";
import { useMetrics } from "@/lib/useData";

const GRID = "78px 1.6fr 1fr 66px 62px 74px 74px 92px 84px";

const METRICS = [
  { key: "shots", label: "Skott" },
  { key: "sot", label: "Skott på mål" },
  { key: "corners", label: "Hörnor" },
];

interface ScreenResponse {
  rows: ShotScreenRow[];
  meta: ShotScreenMeta & { dbConfigured: boolean };
  leagues: Array<{ key: string; label: string }>;
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`;
const pct2 = (x: number) => `${(x * 100).toFixed(2)} %`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;

function kickoffLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("sv-SE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Över/under + linje som en enda läsbar etikett. */
function pickLabel(row: ShotScreenRow): string {
  if (!row.bestSide) return `${row.line}`;
  return `${row.bestSide === "over" ? "Ö" : "U"} ${String(row.line).replace(".", ",")}`;
}

function edgeTone(edge: number): string {
  if (edge >= 0.05) return "pos";
  if (edge <= 0) return "neg";
  return "";
}

/** Detaljraden bakom en edge: modellens siffror och alla priser. */
function RowDetail({ row }: { row: ShotScreenRow }) {
  return (
    <div className="ap-shot-detail">
      <div className="ap-shot-detail-stats">
        <MiniStat label="Modellens väntevärde λ" value={row.lambda.toFixed(2)} />
        <MiniStat label="Dispersion φ" value={Number.isFinite(row.dispersion) ? row.dispersion.toFixed(1) : "∞ (Poisson)"} />
        <MiniStat label="Modell P(över)" value={pct1(row.pModel)} />
        <MiniStat
          label="Marknad P(över)"
          value={row.pMarket == null ? "—" : pct1(row.pMarket)}
          sub={row.marketBooks.length > 0 ? row.marketBooks.join(" + ") : undefined}
        />
        <MiniStat
          label="Blend P(över)"
          value={pct1(row.pFinal)}
          sub={row.pMarket == null ? "ren modell" : `${Math.round(row.blendW * 100)} % modell`}
        />
        {row.pPush > 0 && <MiniStat label="Push" value={pct1(row.pPush)} />}
      </div>

      {row.pMarket == null ? (
        <div className="ap-shot-warn">
          Ingen bookmaker prissatte den här linjen tvåvägs, så det finns inget marknadsankare —
          fair odds kommer helt ur modellen oavsett vad modellvikten står på. Behandla edgen
          därefter.
        </div>
      ) : !row.marketTwoSided ? (
        <div className="ap-shot-warn">
          Bara ett ensidigt pris fanns, så marknadsreferensen bygger på en antagen marginal i
          stället för en riktig Ö/U-avviggning. Svagare ankare än vanligt.
        </div>
      ) : null}

      <div className="ap-shot-detail-ratings">
        <InlineStat label={`${row.homeTeam} anfall`} value={row.ratings.homeAttack.toFixed(2)} />
        <InlineStat label={`${row.homeTeam} försvar`} value={row.ratings.homeDefence.toFixed(2)} />
        <InlineStat label={`${row.awayTeam} anfall`} value={row.ratings.awayAttack.toFixed(2)} />
        <InlineStat label={`${row.awayTeam} försvar`} value={row.ratings.awayDefence.toFixed(2)} />
      </div>

      <div className="ap-shot-books">
        <div className="ap-shot-books-head">
          <span>Bookmaker</span>
          <span className="ap-r">Över</span>
          <span className="ap-r">Under</span>
        </div>
        {row.books.map((b) => (
          <div key={b.bookmaker} className="ap-shot-books-row">
            <span>
              {b.bookmaker}
              {b.bookmaker === row.bestBook && <span className="ap-tag" style={{ marginLeft: 6 }}>BÄST</span>}
            </span>
            <span className="ap-r ap-num">{b.overOdds?.toFixed(2) ?? "—"}</span>
            <span className="ap-r ap-num">{b.underOdds?.toFixed(2) ?? "—"}</span>
          </div>
        ))}
      </div>

      <details className="ap-fine">
        <summary>Så räknas det</summary>
        <div className="ap-fine-details">
          Lagets anfalls- och försvarsratings vägs mot ligasnittet till ett väntevärde λ, som blir en
          negativ binomial fördelning med dispersion φ. Matchtotalen är de två lagens fördelningar
          faltade, inte en enda fördelning på summan. Modellens P(över) blandas därefter med
          marknadens avviggade pris med vikten som är satt ovan. Marknadsreferensen är i första
          hand en skarp bok, men Pinnacle och Betfair Exchange prissätter i praktiken aldrig
          skott- och hörnmarknader — därför används normalt konsensus av de mjuka böcker som
          prissatt linjen. Edge är EV per satsad enhet mot bästa pris: <em>odds × P − 1</em>.
        </div>
      </details>
    </div>
  );
}

export default function ShotsPage() {
  const [data, setData] = useState<ScreenResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const [league, setLeague] = useState("");
  const [metric, setMetric] = useState("");
  const [minEdge, setMinEdge] = useState(2);
  const [days, setDays] = useState(7);
  // Speglar DEFAULT_BLEND_W i lib/shotModel.ts — satt av backtestet, inte vald.
  const [blendW, setBlendW] = useState(Math.round(DEFAULT_BLEND_W * 100));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (league) qs.set("league", league);
    if (metric) qs.set("metric", metric);
    qs.set("minEdge", String(minEdge / 100));
    qs.set("days", String(days));
    qs.set("w", String(blendW / 100));
    api
      .get<ScreenResponse>(`/api/shots?${qs.toString()}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Kunde inte hämta modellen");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [league, metric, minEdge, days, blendW]);

  const { data: metricsData } = useMetrics();
  const bankrollUnits =
    (metricsData?.settings.startingBankrollUnits ?? 100) + (metricsData?.metrics?.profitUnits ?? 0);

  const rows = data?.rows ?? [];
  const meta = data?.meta;

  const headline = useMemo(() => {
    if (rows.length === 0) return null;
    const best = rows[0];
    const positive = rows.filter((r) => r.edge > 0).length;
    return { best, positive };
  }, [rows]);

  const trainedMatches = meta?.leagues.reduce((s, l) => s + l.matches, 0) ?? 0;
  // Tabellhuvudet utan tabell är bara brus — visa det först när det finns en
  // modell bakom. Undantaget är laddning, där skelettraden hör hemma.
  const showTable = loading || (!error && !!meta?.dbConfigured && trainedMatches > 0);

  return (
    <div>
      <Topbar
        title="Skottmodell"
        sub="Egna skott- och hörnsiffror mot bookmakerpriserna — sorterat på edge"
        icon={IC.bars}
      />

      <Card>
        <div className="ap-shot-filters">
          <div className="ap-field">
            <label htmlFor="shot-league">Liga</label>
            <div className="ap-select">
              <select id="shot-league" value={league} onChange={(e) => setLeague(e.target.value)}>
                <option value="">Alla ligor</option>
                {(data?.leagues ?? []).map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label htmlFor="shot-metric">Marknad</label>
            <div className="ap-select">
              <select id="shot-metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
                <option value="">Alla marknader</option>
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label htmlFor="shot-edge">Lägsta edge</label>
            <div className="ap-select">
              <select id="shot-edge" value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))}>
                <option value={-100}>Visa allt</option>
                <option value={0}>0 %</option>
                <option value={2}>2 %</option>
                <option value={5}>5 %</option>
                <option value={8}>8 %</option>
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label htmlFor="shot-days">Horisont</label>
            <div className="ap-select">
              <select id="shot-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={2}>2 dagar</option>
                <option value={7}>7 dagar</option>
                <option value={14}>14 dagar</option>
              </select>
            </div>
          </div>

          <div className="ap-field ap-shot-weight">
            <label htmlFor="shot-w">
              Modellvikt <span className="ap-num">{blendW} %</span>
            </label>
            <input
              id="shot-w"
              type="range"
              min={0}
              max={100}
              step={5}
              value={blendW}
              onChange={(e) => setBlendW(Number(e.target.value))}
              style={{ accentColor: "var(--acc)", width: "100%" }}
            />
            <span style={{ fontSize: 11, color: "var(--dim2)" }}>
              0 % ren marknad · 100 % ren modell
            </span>
          </div>
        </div>

        <div className="ap-shot-summary">
          <InlineStat label="Linjer med edge" value={String(rows.length)} />
          <InlineStat label="Bästa edge" value={headline ? signedPct(headline.best.edge) : "—"} tone={headline && headline.best.edge > 0 ? "pos" : undefined} />
          <InlineStat label="Kommande matcher" value={String(meta?.fixtures ?? 0)} />
          <InlineStat label="Matcher i modellen" value={String(trainedMatches)} />
        </div>
      </Card>

      <ManualShotOdds bankrollUnits={bankrollUnits} blendW={blendW / 100} />

      {error && (
        <Card>
          <Empty icon={IC.helpCircle} title="Kunde inte hämta modellen" hint={error} />
        </Card>
      )}

      {!error && !loading && meta && !meta.dbConfigured && (
        <Card>
          <Empty
            icon={IC.gear}
            title="Skottmodellens databas är inte uppsatt"
            hint="Sätt SHOTS_DATABASE_URL och SHOTS_DIRECT_URL i .env.local och kör npm run db:push:shots. Modellen har en egen databas, skild från bet-loggen."
          />
        </Card>
      )}

      {!error && !loading && meta?.dbConfigured && trainedMatches === 0 && (
        <Card>
          <Empty
            icon={IC.bars}
            title="Ingen matchdata inläst än"
            hint="Kör npm run shots:ingest -- --league allsvenskan --confirm för att fylla på historiken modellen tränar på."
          />
        </Card>
      )}

      {!error && !loading && trainedMatches > 0 && meta?.missingOdds && (
        <Card>
          <Empty
            icon={IC.percent}
            title="Inga odds lagrade för kommande matcher"
            hint="Kör npm run shots:odds -- --upcoming --confirm. Modellen kan bara visa edge på linjer som böckerna faktiskt prissatt."
          />
        </Card>
      )}

      {/* tabell (desktop / surfplatta) — bara när det finns en modell att visa */}
      <div className="ap-table-wrap" style={{ display: showTable ? undefined : "none" }}>
        <Card style={{ padding: 0 }}>
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: GRID }}>
              <span>Avspark</span>
              <span>Match</span>
              <span>Marknad</span>
              <span className="ap-r">Linje</span>
              {/* Inte "λ": .ap-thead versaliserar, och Λ läser fel. */}
              <span className="ap-r">Väntat</span>
              <span className="ap-r">Fair</span>
              <span className="ap-r">Bästa</span>
              <span className="ap-r">Edge</span>
              <span>Bok</span>
            </div>

            {loading && (
              <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--dim2)", fontSize: 14 }}>Laddar…</div>
            )}

            {!loading && rows.length === 0 && trainedMatches > 0 && !meta?.missingOdds && (
              <Empty
                icon={IC.search}
                title="Ingen linje når tröskeln"
                hint="Sänk lägsta edge eller öka horisonten. Att modellen inte hittar något är ett giltigt svar."
              />
            )}

            {!loading &&
              rows.map((r) => {
                const key = `${r.matchId}|${r.metric}|${r.side}|${r.line}`;
                const open = openRow === key;
                return (
                  <div key={key}>
                    <div
                      className="ap-trow ap-shot-row"
                      style={{ gridTemplateColumns: GRID, cursor: "pointer" }}
                      onClick={() => setOpenRow(open ? null : key)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenRow(open ? null : key);
                        }
                      }}
                    >
                      <span className="ap-num" style={{ color: "var(--dim)" }}>{kickoffLabel(r.kickoffAt)}</span>
                      <span className="ap-ell">
                        {r.homeTeam}–{r.awayTeam}
                        <span className="ap-tag" style={{ marginLeft: 6 }}>{r.leagueLabel}</span>
                      </span>
                      <span className="ap-ell" style={{ color: "var(--dim)" }}>
                        {r.metricLabel} · {r.sideLabel}
                      </span>
                      <span className="ap-r ap-num">{pickLabel(r)}</span>
                      <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{r.lambda.toFixed(1)}</span>
                      <span className="ap-r ap-num">
                        {(r.bestSide === "under" ? r.fairUnderOdds : r.fairOverOdds).toFixed(2)}
                      </span>
                      <span className="ap-r ap-num">{r.bestOdds?.toFixed(2) ?? "—"}</span>
                      <span className={`ap-r ap-num ${edgeTone(r.edge)}`}>{signedPct(r.edge)}</span>
                      <span className="ap-ell" style={{ color: "var(--dim)" }}>{r.bestBook ?? "—"}</span>
                    </div>
                    {open && <RowDetail row={r} />}
                  </div>
                );
              })}
          </div>
        </Card>
      </div>

      {/* kort (mobil) */}
      <div className="ap-betcards">
        {loading && <div className="ap-betcard-empty">Laddar…</div>}
        {!loading &&
          rows.map((r) => {
            const key = `${r.matchId}|${r.metric}|${r.side}|${r.line}`;
            const open = openRow === key;
            return (
              <div key={key} className="ap-betcard" onClick={() => setOpenRow(open ? null : key)}>
                <div className="ap-betcard-top">
                  <span className="ap-betcard-date">
                    <span className="ap-num">{kickoffLabel(r.kickoffAt)}</span>
                  </span>
                  <span className={`ap-pill ${r.edge > 0 ? "pos" : "neg"}`}>{signedPct(r.edge)}</span>
                </div>
                <div className="ap-betcard-event">{r.homeTeam}–{r.awayTeam}</div>
                <div className="ap-betcard-sel">
                  {r.metricLabel} · {r.sideLabel} · <b>{pickLabel(r)}</b>
                </div>
                <div className="ap-betcard-stats">
                  <div>
                    <span>Fair</span>
                    <b className="ap-num">{(r.bestSide === "under" ? r.fairUnderOdds : r.fairOverOdds).toFixed(2)}</b>
                  </div>
                  <div>
                    <span>Bästa</span>
                    <b className="ap-num">{r.bestOdds?.toFixed(2) ?? "—"}</b>
                  </div>
                  <div>
                    <span>Bok</span>
                    <b>{r.bestBook ?? "—"}</b>
                  </div>
                  <div>
                    <span>λ</span>
                    <b className="ap-num">{r.lambda.toFixed(1)}</b>
                  </div>
                </div>
                {open && <RowDetail row={r} />}
              </div>
            );
          })}
      </div>

      {meta && trainedMatches > 0 && (
        <Card>
          <div className="ap-card-head">
            <span className="ap-card-title">Modellens underlag</span>
          </div>
          <div className="ap-shot-models">
            {meta.leagues.map((l) => (
              <div key={l.key} className="ap-shot-model">
                <div className="ap-label">{l.label} · {l.matches} matcher</div>
                <div className="ap-shot-model-stats">
                  {l.models.map((m) => (
                    <InlineStat
                      key={m.metric}
                      label={METRICS.find((x) => x.key === m.metric)?.label ?? m.metric}
                      value={`${m.homeMean.toFixed(1)} / ${m.awayMean.toFixed(1)} · φ ${Number.isFinite(m.dispersion) ? m.dispersion.toFixed(0) : "∞"}`}
                    />
                  ))}
                  {l.models.length === 0 && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen modell — för lite data</span>}
                </div>
              </div>
            ))}
          </div>
          <details className="ap-fine">
            <summary>Vad siffrorna betyder</summary>
            <div className="ap-fine-details">
              Talparet är ligans snitt per hemmalag respektive bortalag och match — hemmafördelen
              ligger i skillnaden mellan dem. φ är dispersionen: låg siffra betyder tjockare svansar
              än Poisson, ∞ betyder att datan inte visar någon överdispersion alls. Dispersionen mäts
              på matcher som hållits utanför rating-anpassningen, så den blir inte konstlat låg.
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}
