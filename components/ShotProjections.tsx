"use client";

/**
 * Modellens projektioner för kommande matcher — utan att några odds behövs.
 *
 * Edge-screenen kräver lagrade bolagspriser, och sedan TheStatsAPI togs bort
 * finns ingen källa som fyller på dem. Men λ per lag och mätetal kommer ur
 * historiken ensam, så siffrorna går att visa ändå: väntat antal per lag, och
 * modellens egen linje (närmast 50/50) med fair odds åt båda håll. Ett klick
 * på en linje fyller i kalkylatorn med just den matchen och linjen.
 */

import { Fragment, useState } from "react";
import { Card, Empty } from "@/components/ui";
import { InlineStat } from "@/components/stats";
import { IC } from "@/components/icons";
import { DEFAULT_SHRINK_K, type MatchSide, type ShotMetric } from "@/lib/shotModel";
import type { FixtureProjection } from "@/lib/shotScreen";

export interface ShotOddsPreset {
  matchId: string;
  metric: ShotMetric;
  side: MatchSide;
  line: number;
  /** Ändras vid varje klick, så samma linje två gånger fyller i igen. */
  nonce: number;
}

const SIDES: MatchSide[] = ["home", "away", "match"];

const lineLabel = (line: number) => String(line).replace(".", ",");

function kickoffLabel(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function sideName(f: FixtureProjection, side: MatchSide): string {
  return side === "home" ? f.homeTeam : side === "away" ? f.awayTeam : "Matchen";
}

/**
 * Under shrinkage-konstanten väger ligasnittet tyngre än lagets egna matcher —
 * ratingen säger då mer om ligan än om laget.
 */
function isThin(f: FixtureProjection): boolean {
  return Math.min(f.homeMatches, f.awayMatches) < DEFAULT_SHRINK_K;
}

/** Väntat totalt överst, fördelningen hemma–borta under. */
function MetricCell({ m }: { m: FixtureProjection["metrics"][number] }) {
  return (
    <span className="ap-shot-proj-cell">
      <b className="ap-num">{m.total.toFixed(1)}</b>
      <span className="ap-num">
        {m.home.toFixed(1)} – {m.away.toFixed(1)}
      </span>
    </span>
  );
}

function ProjectionDetail({
  f,
  metrics,
  onPick,
}: {
  f: FixtureProjection;
  metrics: FixtureProjection["metrics"];
  onPick: (p: Omit<ShotOddsPreset, "nonce">) => void;
}) {
  return (
    // Knapparna ligger i ett klickbart kort på mobil — låt inte klick och
    // Enter bubbla upp och fälla ihop kortet.
    <div className="ap-shot-detail" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="ap-shot-detail-ratings">
        <InlineStat label="Matcher i underlaget, hemma / borta" value={`${f.homeMatches} / ${f.awayMatches}`} />
      </div>

      <div className="ap-shot-lines">
        <div className="ap-shot-lines-head">
          <span>Modellens linje</span>
          {SIDES.map((s) => (
            <span key={s} className="ap-ell">{sideName(f, s)}</span>
          ))}
        </div>
        {metrics.map((m) => (
          <div key={m.metric} className="ap-shot-lines-row">
            <span className="ap-shot-lines-metric">{m.metricLabel}</span>
            {SIDES.map((s) => {
              const fl = m.fairLines[s];
              const lambda = s === "home" ? m.home : s === "away" ? m.away : m.total;
              return (
                <button
                  key={s}
                  type="button"
                  className="ap-shot-line"
                  aria-label={`${m.metricLabel}, ${sideName(f, s)}: över/under ${lineLabel(fl.line)}, fair ${fl.fairOver.toFixed(2)} / ${fl.fairUnder.toFixed(2)}. Räkna på egna odds.`}
                  onClick={() => onPick({ matchId: f.matchId, metric: m.metric, side: s, line: fl.line })}
                >
                  <span className="ap-shot-line-top">
                    <span>Ö/U</span> <b className="ap-num">{lineLabel(fl.line)}</b>
                    <span className="ap-shot-line-lambda ap-num">λ {lambda.toFixed(1)}</span>
                  </span>
                  <span className="ap-shot-line-odds ap-num">
                    {fl.fairOver.toFixed(2)} / {fl.fairUnder.toFixed(2)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {isThin(f) && (
        <div className="ap-shot-warn">
          {f.homeMatches === 0 || f.awayMatches === 0
            ? "Ett av lagen saknas helt i historiken och räknas som ett snittlag i ligan."
            : `Färre än ${DEFAULT_SHRINK_K} matcher bakom minst ett av lagen — ratingen dras mot ligasnittet.`}{" "}
          Siffrorna säger mer om ligan än om matchen.
        </div>
      )}
    </div>
  );
}

export function ShotProjections({
  fixtures,
  loading,
  metricFilter,
  onPick,
}: {
  fixtures: FixtureProjection[];
  loading: boolean;
  /** Tom sträng = alla mätetal. */
  metricFilter: string;
  onPick: (p: Omit<ShotOddsPreset, "nonce">) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  // Kolumnerna följer den första matchen — alla matcher i en liga har samma
  // modeller, och en liga utan modell kommer aldrig hit.
  const shown = (f: FixtureProjection) => f.metrics.filter((m) => !metricFilter || m.metric === metricFilter);
  const columns = fixtures.length > 0 ? shown(fixtures[0]) : [];
  // Siffrorna är korta — fast bredd så att matchnamn och taggar får platsen.
  const grid = `78px minmax(0, 1fr) repeat(${Math.max(1, columns.length)}, 112px)`;

  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  return (
    <Card style={{ padding: 0 }}>
      <div className="ap-card-head ap-shot-proj-head">
        <span role="heading" aria-level={2} className="ap-card-title">Matchprojektioner</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)" }}>
          Väntat per match och lag · ren modell, inga odds behövs · klicka en match för linjer
        </span>
      </div>

      {loading && <div className="ap-panel-empty">Laddar matcher…</div>}

      {!loading && fixtures.length === 0 && (
        <Empty
          icon={IC.search}
          title="Inga kommande matcher inom horisonten"
          hint="Öka horisonten eller byt liga. Uppehåll i ligan ger också en tom lista."
        />
      )}

      {!loading && fixtures.length > 0 && (
        <>
          {/* tabell (desktop / surfplatta) */}
          <div className="ap-table-wrap">
            <div className="ap-table">
              <div className="ap-thead" style={{ gridTemplateColumns: grid }}>
                <span>Avspark</span>
                <span>Match</span>
                {columns.map((m) => (
                  <span key={m.metric} className="ap-r">{m.metricLabel}</span>
                ))}
              </div>
              {fixtures.map((f) => {
                const open = openId === f.matchId;
                const metrics = shown(f);
                return (
                  <Fragment key={f.matchId}>
                    <div
                      className="ap-trow ap-shot-row"
                      style={{ gridTemplateColumns: grid, cursor: "pointer" }}
                      onClick={() => toggle(f.matchId)}
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(f.matchId);
                        }
                      }}
                    >
                      <span className="ap-num" style={{ color: "var(--dim)" }}>{kickoffLabel(f.kickoffAt)}</span>
                      <span className="ap-ell">
                        {f.homeTeam}–{f.awayTeam}
                        <span className="ap-tag" style={{ marginLeft: 6 }}>{f.leagueLabel}</span>
                        {isThin(f) && <span className="ap-tag" style={{ marginLeft: 4 }}>tunt underlag</span>}
                      </span>
                      {metrics.map((m) => (
                        <span key={m.metric} className="ap-r">
                          <MetricCell m={m} />
                        </span>
                      ))}
                    </div>
                    {open && <ProjectionDetail f={f} metrics={metrics} onPick={onPick} />}
                  </Fragment>
                );
              })}
            </div>
          </div>

          {/* kort (mobil) */}
          <div className="ap-betcards is-flush">
            {fixtures.map((f) => {
              const open = openId === f.matchId;
              const metrics = shown(f);
              return (
                <div
                  key={f.matchId}
                  className="ap-betcard"
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggle(f.matchId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(f.matchId);
                    }
                  }}
                >
                  <div className="ap-betcard-top">
                    <span className="ap-betcard-date">
                      <span className="ap-num">{kickoffLabel(f.kickoffAt)}</span>
                    </span>
                    <span>
                      {isThin(f) && <span className="ap-tag" style={{ marginRight: 4 }}>tunt underlag</span>}
                      <span className="ap-tag">{f.leagueLabel}</span>
                    </span>
                  </div>
                  <div className="ap-betcard-event">{f.homeTeam}–{f.awayTeam}</div>
                  <div className="ap-betcard-stats">
                    {metrics.map((m) => (
                      <div key={m.metric}>
                        <span>{m.metricLabel}</span>
                        <b className="ap-num">{m.total.toFixed(1)}</b>
                        <em className="ap-shot-proj-split ap-num">
                          {m.home.toFixed(1)} – {m.away.toFixed(1)}
                        </em>
                      </div>
                    ))}
                  </div>
                  {open && <ProjectionDetail f={f} metrics={metrics} onPick={onPick} />}
                </div>
              );
            })}
          </div>
        </>
      )}

      <details className="ap-fine ap-shot-proj-fine">
        <summary>Vad siffrorna betyder</summary>
        <div className="ap-fine-details">
          Stora talet är väntat antal i matchen, paret under är hemmalag – bortalag. Modellens linje
          är halvlinjen där över ligger närmast 50 %, och oddsen är fair över / fair under utan
          marginal — ligger bokens linje en hel enhet ifrån är det värt en titt, men edgen kräver
          bokens pris. Projektionerna är ren modell: utan bolagspriser finns ingen marknad att blanda
          med, och på hörnor är modellen bevisligen sämre än bet365.
        </div>
      </details>
    </Card>
  );
}
