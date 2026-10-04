"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import type { TeamOverview } from "@/lib/cs2/queries";
import { ROLE_LABEL, type Role } from "@/lib/cs2/roles";
import { mapLabel } from "@/lib/cs2/maps";
import { GameplanView } from "@/components/cs2/GameplanView";
import { Cs2Empty, Cs2NoDb, SampleWindowPicker, dateLabel, dayLabel, dec, pct } from "@/components/cs2/common";

type Resp = ({ dbConfigured: true } & TeamOverview) | { dbConfigured: false };

const POOL_GRID = "1.1fr 60px 70px 70px 70px 70px 70px 60px 60px 60px 80px";

export default function Cs2TeamPage({ params }: { params: { id: string } }) {
  const teamId = Number(params.id);
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Resp>(`/api/cs2/teams/${teamId}?months=${months}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Kunde inte hämta laget"));
    return () => {
      cancelled = true;
    };
  }, [teamId, months]);

  if (error) return <Cs2Empty title="Kunde inte hämta laget" hint={error} />;
  if (data && !data.dbConfigured) return <Cs2NoDb />;
  if (!data) return <Card>Laddar…</Card>;

  const d = data as TeamOverview;
  const opponents = d.upcoming.filter((m) => m.opponentId != null).map((m) => ({ id: m.opponentId!, name: m.opponent }));

  return (
    <div className="ap-cs2">
      <Topbar
        title={d.team.name}
        sub={
          <>
            {d.team.rank ? `#${d.team.rank} · ` : ""}
            {d.team.country ?? ""} · {d.team.tracked ? "bevakas" : "hämtat vid behov"} · {d.coverage.maps} kartor ({d.coverage.demoMaps} med
            demo) senaste {months} mån · <Link href="/cs2">← alla lag</Link>
          </>
        }
        icon={IC.gamepad}
        accent="purple"
        actions={<SampleWindowPicker maps={10} months={months} onChange={(w) => setMonths(w.months)} showMaps={false} />}
      />

      <div className="ap-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", marginBottom: 16 }}>
        <Card style={{ padding: 0 }}>
          <div className="ap-card-head">
            <span className="ap-card-title">Trupp</span>
          </div>
          <div className="ap-table">
            <div className="ap-thead" style={{ gridTemplateColumns: "1.3fr 1fr 50px 60px 60px 60px" }}>
              <span>Spelare</span>
              <span>Roll</span>
              <span className="ap-r">Kartor</span>
              <span className="ap-r">KPR</span>
              <span className="ap-r">HS</span>
              <span className="ap-r">Rating</span>
            </div>
            {d.roster.map((p) => (
              <Link key={p.id} href={`/cs2/spelare/${p.id}`} className="ap-trow" style={{ gridTemplateColumns: "1.3fr 1fr 50px 60px 60px 60px", color: "inherit", textDecoration: "none" }}>
                <span className="ap-ell">
                  <b>{p.nickname}</b>
                  {p.realName ? <span style={{ color: "var(--dim2)" }}> · {p.realName}</span> : null}
                </span>
                <span style={{ color: "var(--dim)" }}>
                  {p.role ? ROLE_LABEL[p.role as Role] ?? p.role : "—"}
                  {p.roleIsManual ? " ✎" : ""}
                </span>
                <span className="ap-r ap-num">{p.maps}</span>
                <span className="ap-r ap-num">{dec(p.kpr)}</span>
                <span className="ap-r ap-num">{pct(p.hsPct)}</span>
                <span className="ap-r ap-num">{dec(p.rating)}</span>
              </Link>
            ))}
            {d.roster.length === 0 && <div className="ap-trow">Truppen är inte inläst än.</div>}
          </div>
        </Card>

        <Card style={{ padding: 0 }}>
          <div className="ap-card-head">
            <span className="ap-card-title">Matcher</span>
          </div>
          <div className="ap-table">
            {[...d.upcoming, ...d.recent].slice(0, 10).map((m) => (
              <Link key={m.id} href={`/cs2/match/${m.id}`} className="ap-trow" style={{ gridTemplateColumns: "84px 1fr 70px", color: "inherit", textDecoration: "none" }}>
                <span className="ap-num" style={{ color: "var(--dim)" }}>
                  {m.status === "finished" ? dayLabel(m.startAt) : dateLabel(m.startAt)}
                </span>
                <span className="ap-ell">
                  vs <b>{m.opponent}</b>
                  {m.maps.length > 0 && (
                    <span style={{ color: "var(--dim2)" }}> · {m.maps.map((x) => `${mapLabel(x.mapName)} ${x.score}`).join(", ")}</span>
                  )}
                </span>
                <span className={`ap-r ap-num ${m.won == null ? "" : m.won ? "pos" : "neg"}`}>
                  {m.status === "finished" ? m.score : m.format.toUpperCase()}
                </span>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">Kartpool · senaste {months} mån</span>
        </div>
        <div className="ap-cs2-scroll">
          <div className="ap-table" style={{ minWidth: 860 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: POOL_GRID }}>
              <span>Karta</span>
              <span className="ap-r">Spelad</span>
              <span className="ap-r">Vinst</span>
              <span className="ap-r">CT-rundor</span>
              <span className="ap-r">T-rundor</span>
              <span className="ap-r">Pistol</span>
              <span className="ap-r">Snitt rundor</span>
              <span className="ap-r">OT</span>
              <span className="ap-r">Pick</span>
              <span className="ap-r">Ban</span>
              <span className="ap-r">1:a ban</span>
            </div>
            {d.mapPool.map((m) => (
              <div key={m.mapName} className="ap-trow" style={{ gridTemplateColumns: POOL_GRID }}>
                <b>{m.label}</b>
                <span className="ap-r ap-num">{m.played}</span>
                <span className={`ap-r ap-num ${m.winRate != null ? (m.winRate >= 0.55 ? "pos" : m.winRate <= 0.45 ? "neg" : "") : ""}`}>{pct(m.winRate)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--cs2-ct)" }}>{pct(m.ctRoundRate)}</span>
                <span className="ap-r ap-num" style={{ color: "var(--cs2-t)" }}>{pct(m.tRoundRate)}</span>
                <span className="ap-r ap-num">{pct(m.pistolWinRate)}</span>
                <span className="ap-r ap-num">{dec(m.avgRounds, 1)}</span>
                <span className="ap-r ap-num">{pct(m.otRate)}</span>
                <span className="ap-r ap-num">{m.picks}</span>
                <span className="ap-r ap-num">{m.bans}</span>
                <span className="ap-r ap-num">{pct(m.firstBanRate)}</span>
              </div>
            ))}
            {d.mapPool.length === 0 && <div className="ap-trow">Inga kartor i perioden.</div>}
          </div>
        </div>
        <details className="ap-fine" style={{ padding: "0 20px 14px" }}>
          <summary>Vad kolumnerna betyder</summary>
          <div className="ap-fine-details">
            CT-/T-rundor är andelen rundor laget vann på sidan. Pistol räknar runda 1 och 13. Pick och ban är lagets egna val i vetot;
            &quot;1:a ban&quot; är hur ofta kartan var lagets första ban — en hög siffra betyder i praktiken permaban och att kartan
            nästan aldrig spelas.
          </div>
        </details>
      </Card>

      <GameplanView teamId={teamId} initialMap={d.mapPool[0]?.mapName ?? null} opponents={opponents} initialVs={opponents[0]?.id ?? null} />
    </div>
  );
}
