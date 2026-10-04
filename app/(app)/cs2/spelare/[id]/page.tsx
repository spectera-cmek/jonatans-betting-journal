"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import type { PlayerOverview } from "@/lib/cs2/queries";
import { ROLE_LABEL, type Role } from "@/lib/cs2/roles";
import { mapLabel } from "@/lib/cs2/maps";
import { prettyPlace } from "@/lib/cs2/demo/places";
import { topCounts } from "@/lib/cs2/profiles";
import { Cs2Empty, Cs2NoDb, SampleWindowPicker, dayLabel, dec, pct } from "@/components/cs2/common";

type Resp = ({ dbConfigured: true } & PlayerOverview) | { dbConfigured: false };

const MAP_GRID = "1fr 56px 64px 64px 64px 60px 60px 60px 1.6fr";
const rate = (n: number, d: number) => (d > 0 ? n / d : null);

export default function Cs2PlayerPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleBusy, setRoleBusy] = useState(false);

  const load = () =>
    api
      .get<Resp>(`/api/cs2/players/${id}?months=${months}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta spelaren"));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, months]);

  if (error) return <Cs2Empty title="Kunde inte hämta spelaren" hint={error} />;
  if (data && !data.dbConfigured) return <Cs2NoDb />;
  if (!data) return <Card>Laddar…</Card>;
  const d = data as PlayerOverview;

  const setRole = async (role: string) => {
    setRoleBusy(true);
    try {
      await api.patch(`/api/cs2/players/${id}`, { role: role || null });
      await load();
    } finally {
      setRoleBusy(false);
    }
  };

  const demoAll = d.demo.filter((x) => x.mapName === "all");
  const demoMaps = d.demo.filter((x) => x.mapName !== "all");

  return (
    <div className="ap-cs2">
      <Topbar
        title={d.player.nickname}
        sub={
          <>
            {d.player.realName ? `${d.player.realName} · ` : ""}
            {d.player.team ? <Link href={`/cs2/lag/${d.player.team.id}`}>{d.player.team.name}</Link> : "utan lag"}
            {d.player.country ? ` · ${d.player.country}` : ""}
          </>
        }
        icon={IC.user}
        accent="purple"
        actions={
          <>
            <div className="ap-field">
              <label htmlFor="cs2-role">Roll {d.player.roleManual ? "(rättad)" : "(härledd)"}</label>
              <div className="ap-select">
                <select id="cs2-role" disabled={roleBusy} value={d.player.roleManual ?? ""} onChange={(e) => setRole(e.target.value)}>
                  <option value="">{d.player.roleDerived ? `Härledd: ${ROLE_LABEL[d.player.roleDerived as Role] ?? d.player.roleDerived}` : "Härledd: okänd"}</option>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <SampleWindowPicker maps={10} months={months} onChange={(w) => setMonths(w.months)} showMaps={false} />
          </>
        }
      />

      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Per karta · HLTV · senaste {months} mån</span>
        </div>
        <div className="ap-cs2-scroll">
          <div className="ap-table" style={{ minWidth: 820 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: MAP_GRID }}>
              <span>Karta</span>
              <span className="ap-r">Kartor</span>
              <span className="ap-r">KPR</span>
              <span className="ap-r">CT KPR</span>
              <span className="ap-r">T KPR</span>
              <span className="ap-r">HS</span>
              <span className="ap-r">ADR</span>
              <span className="ap-r">Rating</span>
              <span>Kills per karta (nyast först)</span>
            </div>
            {d.profiles.map((p) => (
              <div key={p.mapName} className="ap-trow" style={{ gridTemplateColumns: MAP_GRID }}>
                <b>{p.mapName === "all" ? "Alla kartor" : mapLabel(p.mapName)}</b>
                <span className="ap-r ap-num">{p.maps}</span>
                <span className="ap-r ap-num">{dec(p.kpr)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--cs2-ct)" }}>{dec(p.ctKpr)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--cs2-t)" }}>{dec(p.tKpr)}</span>
                <span className="ap-r ap-num">{pct(p.hsPct)}</span>
                <span className="ap-r ap-num">{dec(p.adr, 1)}</span>
                <span className="ap-r ap-num">{dec(p.rating)}</span>
                <span className="ap-num ap-ell" style={{ color: "var(--dim)" }}>{p.killSeries.slice(0, 12).join(" ")}</span>
              </div>
            ))}
            {d.profiles.length === 0 && <div className="ap-trow">Inga kartor i perioden.</div>}
          </div>
        </div>
      </Card>

      <div className="ap-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(330px, 100%), 1fr))", marginBottom: 16 }}>
        {(["ct", "t"] as const).map((side) => {
          const s = demoAll.find((x) => x.side === side);
          const f = s?.facts;
          return (
            <section key={side} className={`ap-cs2-sec is-${side}`}>
              <h3>{side === "ct" ? "CT SIDE" : "T SIDE"} · ur demos</h3>
              <div className="ap-cs2-sec-sub">{s ? `${s.maps} kartor, ${f!.rounds} rundor` : "Inga demos tolkade för spelaren än."}</div>
              {f && (
                <ul className="ap-cs2-items">
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>KPR vunna / förlorade rundor</span>: <b>{dec(rate(f.killsWon, f.roundsWon))} / {dec(rate(f.killsLost, f.rounds - f.roundsWon))}</b>
                  </li>
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>Öppningsduell</span>: <b>{pct(rate(f.openingAttempts, f.rounds))} av rundorna, vinner {pct(rate(f.openingKills, f.openingAttempts))}</b>
                  </li>
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>Multikills (2k/3k/4k/5k)</span>: <b>{f.multi.join(" / ")}</b>
                  </li>
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>Clutch</span>: <b>{f.clutchWins}/{f.clutchAttempts}</b>
                  </li>
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>Pistolrundor</span>: <b>{dec(rate(f.pistolKills, f.pistolRounds))} kills/runda</b>
                  </li>
                  {f.awpKills > 0 && (
                    <li className="ap-cs2-item">
                      <span style={{ color: "var(--dim)" }}>AWP</span>: <b>{f.awpKills} kills, {f.awpEarlyKills} inom 12 s</b>
                    </li>
                  )}
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>Står</span>: <b>{topCounts(f.places, 3).map((t) => `${prettyPlace(t.key)} ${pct(t.share)}`).join(", ") || "—"}</b>
                  </li>
                  <li className="ap-cs2-item">
                    <span style={{ color: "var(--dim)" }}>Utility per runda</span>:{" "}
                    <b>
                      smoke {dec(rate(f.util.smoke, f.rounds), 1)} · flash {dec(rate(f.util.flash, f.rounds), 1)} · molotov{" "}
                      {dec(rate(f.util.molotov, f.rounds), 1)} · HE {dec(rate(f.util.he, f.rounds), 1)}
                    </b>
                  </li>
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {demoMaps.length > 0 && (
        <Card style={{ padding: 0, marginBottom: 16 }}>
          <div className="ap-card-head">
            <span className="ap-card-title">Per karta och sida · ur demos</span>
          </div>
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "1fr 50px 60px 70px 70px 80px 1.6fr" }}>
              <span>Karta</span>
              <span>Sida</span>
              <span className="ap-r">Rundor</span>
              <span className="ap-r">KPR</span>
              <span className="ap-r">HS</span>
              <span className="ap-r">Öppning</span>
              <span>Vanligaste position</span>
            </div>
            {demoMaps
              .sort((a, b) => a.mapName.localeCompare(b.mapName) || a.side.localeCompare(b.side))
              .map((x) => (
                <div key={`${x.mapName}-${x.side}`} className="ap-trow" style={{ gridTemplateColumns: "1fr 50px 60px 70px 70px 80px 1.6fr" }}>
                  <b>{mapLabel(x.mapName)}</b>
                  <span style={{ color: x.side === "ct" ? "var(--cs2-ct)" : "var(--cs2-t)", fontWeight: 700 }}>{x.side.toUpperCase()}</span>
                  <span className="ap-r ap-num">{x.facts.rounds}</span>
                  <span className="ap-r ap-num">{dec(rate(x.facts.kills, x.facts.rounds))}</span>
                  <span className="ap-r ap-num">{pct(rate(x.facts.headshots, x.facts.kills))}</span>
                  <span className="ap-r ap-num">{pct(rate(x.facts.openingAttempts, x.facts.rounds))}</span>
                  <span className="ap-ell" style={{ color: "var(--dim)" }}>
                    {topCounts(x.facts.places, 2).map((t) => `${prettyPlace(t.key)} ${pct(t.share)}`).join(", ") || "—"}
                  </span>
                </div>
              ))}
          </div>
        </Card>
      )}

      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Senaste kartor</span>
        </div>
        <div className="ap-table">
          <div className="ap-thead" style={{ gridTemplateColumns: "70px 1fr 1fr 60px 60px 60px 60px" }}>
            <span>Datum</span>
            <span>Karta</span>
            <span>Mot</span>
            <span className="ap-r">K–D</span>
            <span className="ap-r">HS</span>
            <span className="ap-r">ADR</span>
            <span className="ap-r">Rating</span>
          </div>
          {d.recent.map((r) => (
            <Link key={r.mapId} href={`/cs2/match/${r.matchId}`} className="ap-trow" style={{ gridTemplateColumns: "70px 1fr 1fr 60px 60px 60px 60px", color: "inherit", textDecoration: "none" }}>
              <span className="ap-num" style={{ color: "var(--dim)" }}>{dayLabel(r.playedAt)}</span>
              <span>
                {mapLabel(r.mapName)} <span style={{ color: "var(--dim2)" }}>({r.rounds} r)</span>
              </span>
              <span className="ap-ell">{r.opponent}</span>
              <span className="ap-r ap-num">
                {r.kills}–{r.deaths}
              </span>
              <span className="ap-r ap-num">{r.headshots ?? "—"}</span>
              <span className="ap-r ap-num">{dec(r.adr, 1)}</span>
              <span className="ap-r ap-num">{dec(r.rating)}</span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
