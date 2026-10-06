"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { InlineStat } from "@/components/stats";
import { IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import type { MatchupView } from "@/lib/cs2/matchup";
import { ROLE_LABEL, type Role } from "@/lib/cs2/roles";
import { GameplanView } from "@/components/cs2/GameplanView";
import { LinesPanel } from "@/components/cs2/LinesPanel";
import { ManualVeto } from "@/components/cs2/ManualVeto";
import { QuickProps } from "@/components/cs2/QuickProps";
import { Cs2Empty, Cs2NoDb, TeamLink, dateLabel, dec, pct } from "@/components/cs2/common";

type Resp =
  | ({ dbConfigured: true; pending?: undefined } & MatchupView)
  | { dbConfigured: true; pending: true; team1Name: string; team2Name: string }
  | { dbConfigured: false };

const fair = (p: number) => (p > 0 ? (1 / p).toFixed(2) : "—");
const MAP_GRID = "1fr 64px 64px 64px 80px 80px 70px 64px 64px";
const PL_GRID = "1.2fr 80px 56px 120px 120px 110px 70px";

export default function Cs2MatchPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const [w, setW] = useState(50);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpTeam, setGpTeam] = useState<1 | 2>(1);

  const load = useCallback(() => {
    api
      .get<Resp>(`/api/cs2/matches/${id}?w=${w / 100}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta matchen"));
  }, [id, w]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Cs2Empty title="Kunde inte hämta matchen" hint={error} />;
  if (data && !data.dbConfigured) return <Cs2NoDb />;
  if (!data) return <Card>Räknar…</Card>;
  if (data.pending)
    return (
      <Cs2Empty
        title={`${data.team1Name} vs ${data.team2Name}`}
        hint="Lagen är inte klara på HLTV än (TBD). Modellen räknar när båda lagen är kända och inlästa."
      />
    );
  const v = data as MatchupView;
  const s = v.series;
  const scores = Object.entries(s.scores).sort((a, b) => b[1] - a[1]);

  return (
    <div className="ap-cs2">
      <Topbar
        title={`${v.team1.name} vs ${v.team2.name}`}
        sub={
          <>
            {dateLabel(v.match.startAt)} · {v.match.format.toUpperCase()}
            {v.match.eventName ? ` · ${v.match.eventName}` : ""}
            {v.match.lan ? " · LAN" : ""} · <Link href="/cs2">← alla matcher</Link>
          </>
        }
        icon={IC.gamepad}
        accent="purple"
        actions={
          <div className="ap-field" style={{ minWidth: 200 }}>
            <label htmlFor="cs2-w">
              Modellvikt <span className="ap-num">{w} %</span>
            </label>
            <input id="cs2-w" type="range" min={0} max={100} step={5} value={w} onChange={(e) => setW(Number(e.target.value))} style={{ accentColor: "var(--acc)" }} />
          </div>
        }
      />

      {v.warnings.length > 0 && (
        <div className="ap-cs2-warn" style={{ marginBottom: 16 }}>
          {v.warnings.map((x, i) => (
            <div key={i}>• {x}</div>
          ))}
        </div>
      )}

      <Card style={{ marginBottom: 16 }}>
        <div className="ap-shot-summary" style={{ flexWrap: "wrap", gap: 22 }}>
          <InlineStat label={`${v.team1.name} vinner`} value={`${pct(s.pTeam1)} · ${fair(s.pTeam1)}`} />
          <InlineStat label={`${v.team2.name} vinner`} value={`${pct(1 - s.pTeam1)} · ${fair(1 - s.pTeam1)}`} />
          {v.match.format !== "bo1" && <InlineStat label="Karta 3 spelas (Ö 2,5)" value={`${pct(s.pMap3)} · ${fair(s.pMap3)}`} />}
          <InlineStat label={`Pistol karta 1: ${v.team1.name}`} value={pct(s.pistolTeam1)} />
          <InlineStat label={`Första kill: ${v.team1.name}`} value={pct(s.firstKillTeam1)} />
          <InlineStat label="Resultat" value={scores.slice(0, 4).map(([k, p]) => `${k.replace(",", "–")} ${pct(p)}`).join(" · ")} />
        </div>
        <details className="ap-fine">
          <summary>Så räknas det</summary>
          <div className="ap-fine-details">
            Rundvinst per lag, karta och sida ur HLTV-historiken (logit med krympning mot lagets allmänna nivå), en exakt modell av
            MR12 med pistol- och ekonomirundor och övertid, och ett veto ur lagens pick/ban-historik — {v.vetoKnown ? "här är vetot redan klart" : "båda lagen kan börja vetot"}. Kills
            per spelare är betingade på rundor vunna/förlorade på varje karta. Modellen bygger på {v.model.trainedMaps} kartor och är{" "}
            <b>inte backtestad</b> förrän <code>npm run cs2:backtest</code> körts — se den som utgångspunkt, inte facit.
          </div>
        </details>
      </Card>

      <ManualVeto key={`${v.vetoManual}-${v.vetoMaps.join(",")}`} v={v} onSaved={load} />

      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Kartor</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>{v.vetoManual ? "Kartorna inmatade för hand" : v.vetoKnown ? "Vetot klart" : "Sannolikhet per position ur vetot"}</span>
        </div>
        <div className="ap-cs2-scroll">
          <div className="ap-table" style={{ minWidth: 760 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: MAP_GRID }}>
              <span>Karta</span>
              <span className="ap-r">Karta 1</span>
              <span className="ap-r">Karta 2</span>
              <span className="ap-r">Decider</span>
              <span className="ap-r">{v.team1.name.slice(0, 10)}</span>
              <span className="ap-r">Rundor (linje)</span>
              <span className="ap-r">Övertid</span>
              <span className="ap-r">CT {v.team1.name.slice(0, 4)}</span>
              <span className="ap-r">CT {v.team2.name.slice(0, 4)}</span>
            </div>
            {v.maps.map((m) => (
              <div key={m.mapName} className="ap-trow" style={{ gridTemplateColumns: MAP_GRID, opacity: m.p1 + m.p2 + m.p3 < 0.05 ? 0.5 : 1 }}>
                <b>{m.label}</b>
                <span className="ap-r ap-num">{pct(m.p1)}</span>
                <span className="ap-r ap-num">{pct(m.p2)}</span>
                <span className="ap-r ap-num">{pct(m.p3)}</span>
                <span className="ap-r ap-num">
                  {pct(m.pTeam1Win)} <span style={{ color: "var(--dim2)" }}>{fair(m.pTeam1Win)}</span>
                </span>
                <span className="ap-r ap-num">
                  {dec(m.expRounds, 1)} <span style={{ color: "var(--dim2)" }}>({dec(m.roundsLine, 1)})</span>
                </span>
                <span className="ap-r ap-num">{pct(m.pOt)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--cs2-ct)" }}>{pct(m.team1Ct)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--cs2-ct)" }}>{pct(m.team2Ct)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Spelare · modellens linjer</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>Fair line = linjen där modellen ger ~50 %, inkl. övertid</span>
        </div>
        <div className="ap-cs2-scroll">
          <div className="ap-table" style={{ minWidth: 760 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: PL_GRID }}>
              <span>Spelare</span>
              <span>Roll</span>
              <span className="ap-r">KPR</span>
              <span className="ap-r">{v.match.format === "bo1" ? "Kills" : "Kills karta 1–2"}</span>
              <span className="ap-r">{v.match.format === "bo1" ? "—" : "HS karta 1–2"}</span>
              <span className="ap-r">Kills karta 1</span>
              <span className="ap-r">1:a kill</span>
            </div>
            {v.players.map((p) => (
              <Link key={p.playerId} href={`/cs2/spelare/${p.playerId}`} className="ap-trow" style={{ gridTemplateColumns: PL_GRID, color: "inherit", textDecoration: "none" }}>
                <span className="ap-ell">
                  <b>{p.nickname}</b> <span style={{ color: "var(--dim2)" }}>{p.side === 1 ? v.team1.name : v.team2.name}</span>
                  {p.demoMaps === 0 && <span className="ap-tag" style={{ marginLeft: 6 }}>inga demos</span>}
                </span>
                <span style={{ color: "var(--dim)" }}>{p.role ? ROLE_LABEL[p.role as Role] ?? p.role : "—"}</span>
                <span className="ap-r ap-num">{dec(p.kprAll)}</span>
                <span className="ap-r ap-num">
                  {p.kills12 ? (
                    <>
                      {dec(p.kills12.mean, 1)} <span style={{ color: "var(--dim2)" }}>({dec(p.kills12.line, 1)})</span>
                    </>
                  ) : p.killsMap1 ? (
                    dec(p.killsMap1.mean, 1)
                  ) : (
                    "—"
                  )}
                </span>
                <span className="ap-r ap-num">
                  {p.hs12 ? (
                    <>
                      {dec(p.hs12.mean, 1)} <span style={{ color: "var(--dim2)" }}>({dec(p.hs12.line, 1)})</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                <span className="ap-r ap-num">
                  {p.killsMap1 ? (
                    <>
                      {dec(p.killsMap1.mean, 1)} <span style={{ color: "var(--dim2)" }}>({dec(p.killsMap1.line, 1)})</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                <span className="ap-r ap-num">{p.firstKill != null ? pct(p.firstKill) : "—"}</span>
              </Link>
            ))}
          </div>
        </div>
      </Card>

      <QuickProps view={v} onChanged={load} />
      <LinesPanel view={v} onChanged={load} />

      <Card style={{ marginBottom: 16 }}>
        <div className="ap-card-head" style={{ margin: "-20px -20px 14px" }}>
          <span className="ap-card-title">Angles</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>Datadrivna skäl att avvika från linjen — med urvalet bakom</span>
        </div>
        {v.angles.length === 0 && <div style={{ color: "var(--dim2)", fontSize: 13 }}>Inga angles över trösklarna för den här matchen.</div>}
        <ul className="ap-cs2-items">
          {v.angles.map((a, i) => (
            <li key={i} className={`ap-cs2-item ${a.strength === 0 ? "warn" : a.kind === "edge" ? "pos" : ""}`}>
              <b>
                {a.strength > 0 ? "●".repeat(a.strength) + " " : "⚠ "}
                {a.title}
              </b>
              <div style={{ color: "var(--dim)", fontSize: 12.5 }}>{a.detail}</div>
            </li>
          ))}
        </ul>
      </Card>

      <div className="ap-seg" style={{ marginBottom: 12 }}>
        <button className={gpTeam === 1 ? "is-active" : ""} onClick={() => setGpTeam(1)}>
          Gameplan: {v.team1.name}
        </button>
        <button className={gpTeam === 2 ? "is-active" : ""} onClick={() => setGpTeam(2)}>
          Gameplan: {v.team2.name}
        </button>
      </div>
      <div style={{ marginBottom: 8, fontSize: 12.5, color: "var(--dim)" }}>
        Docen för <TeamLink id={gpTeam === 1 ? v.team1.id : v.team2.id} name={gpTeam === 1 ? v.team1.name : v.team2.name} /> mot{" "}
        {gpTeam === 1 ? v.team2.name : v.team1.name}, på kartan som troligast spelas.
      </div>
      <GameplanView
        key={gpTeam}
        teamId={gpTeam === 1 ? v.team1.id : v.team2.id}
        initialMap={v.maps[0]?.mapName ?? null}
        opponents={[gpTeam === 1 ? { id: v.team2.id, name: v.team2.name } : { id: v.team1.id, name: v.team1.name }]}
        initialVs={gpTeam === 1 ? v.team2.id : v.team1.id}
      />
    </div>
  );
}
