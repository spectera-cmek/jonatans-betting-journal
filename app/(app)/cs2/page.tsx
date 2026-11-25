"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Freshness } from "@/components/Freshness";
import { Card } from "@/components/ui";
import { IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import type { TeamListItem, UpcomingMatch } from "@/lib/cs2/queries";
import { Cs2Empty, Cs2NoDb, dateLabel } from "@/components/cs2/common";
import { FacitPanel } from "@/components/cs2/FacitPanel";

type Tab = "matcher" | "lag" | "spelare" | "facit";

const LIST_GRID = "56px minmax(0, 1.7fr) minmax(0, 1fr) 46px 96px 72px";
/** Under så här många kartor för ett lag i perioden lutar siffrorna mest mot ligasnittet. */
const THIN_MAPS = 10;

function dayHeading(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  const date = d.toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "short" });
  return diff === 0 ? `Idag, ${date}` : diff === 1 ? `I morgon, ${date}` : date.charAt(0).toUpperCase() + date.slice(1);
}

function MatchRow({ m }: { m: UpcomingMatch }) {
  const thin = Math.min(m.coverage.team1Maps, m.coverage.team2Maps) < THIN_MAPS;
  const time = new Date(m.startAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return (
    <Link
      href={`/cs2/match/${m.id}`}
      className="ap-trow"
      style={{ gridTemplateColumns: LIST_GRID, color: "inherit", textDecoration: "none" }}
      title={`Kartor i perioden: ${m.team1.name} ${m.coverage.team1Maps} (${m.coverage.team1Demo} med demo), ${m.team2.name} ${m.coverage.team2Maps} (${m.coverage.team2Demo})`}
    >
      <span className="ap-num" style={{ color: m.status === "live" ? "var(--red)" : "var(--dim)" }}>
        {m.status === "live" ? "LIVE" : time}
      </span>
      <span className="ap-ell">
        <b>{m.team1.name}</b>
        {m.team1.rank ? <span className="ap-tag" style={{ marginLeft: 5 }}>#{m.team1.rank}</span> : null}
        <span style={{ color: "var(--dim2)", margin: "0 6px" }}>vs</span>
        <b>{m.team2.name}</b>
        {m.team2.rank ? <span className="ap-tag" style={{ marginLeft: 5 }}>#{m.team2.rank}</span> : null}
        {thin && <span className="ap-tag" style={{ marginLeft: 6 }}>lite data</span>}
      </span>
      <span className="ap-ell" style={{ color: "var(--dim)" }}>
        {m.eventName ?? "—"}
        {m.lan === true ? " (LAN)" : ""}
      </span>
      <span className="ap-num">{m.format.toUpperCase()}</span>
      <span className="ap-r ap-num" style={{ color: m.killLines > 0 ? "var(--txt)" : "var(--dim2)" }}>
        {m.killLines > 0 ? `${m.killLines} kills` : m.lines > 0 ? `${m.lines} linjer` : "—"}
      </span>
      <span className="ap-r" style={{ color: m.vetoKnown ? "var(--txt)" : "var(--dim2)", fontSize: "var(--fs-sm)" }}>
        {m.vetoKnown ? "Veto klart" : "Väntar"}
      </span>
    </Link>
  );
}

function MatchesTab() {
  const [data, setData] = useState<{ dbConfigured: boolean; matches?: UpcomingMatch[] } | null>(null);
  const [days, setDays] = useState(7);
  const [event, setEvent] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api
      .get<{ dbConfigured: boolean; matches?: UpcomingMatch[] }>(`/api/cs2/matches?days=${days}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta matcher"));
  }, [days]);
  if (error) return <Cs2Empty title="Kunde inte hämta matcher" hint={error} />;
  if (data && !data.dbConfigured) return <Cs2NoDb />;
  const all = data?.matches ?? [];
  const events = [...new Set(all.map((m) => m.eventName).filter((x): x is string => !!x))];
  const rows = event ? all.filter((m) => m.eventName === event) : all;
  const byDay = new Map<string, UpcomingMatch[]>();
  for (const m of rows) {
    const k = new Date(m.startAt).toDateString();
    byDay.set(k, [...(byDay.get(k) ?? []), m]);
  }
  return (
    <>
      <div className="ap-cs2-listtools">
        <div className="ap-seg">
          {[2, 7, 14].map((d) => (
            <button key={d} className={days === d ? "is-active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} dagar
            </button>
          ))}
        </div>
        {events.length > 1 && (
          <div className="ap-select">
            <select aria-label="Event" value={event} onChange={(e) => setEvent(e.target.value)}>
              <option value="">Alla event ({all.length})</option>
              {events.map((e) => (
                <option key={e} value={e}>
                  {e} ({all.filter((m) => m.eventName === e).length})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {!data && <Card>Laddar…</Card>}
      {data && all.length === 0 && (
        <Cs2Empty
          title="Inga kommande matcher i databasen"
          hint="Matcher läses in från lagsidorna: kör npm run cs2:ingest -- --confirm (eller cs2:update) på datorn."
        />
      )}
      {[...byDay].map(([k, ms]) => (
        <Card key={k} style={{ padding: 0, marginBottom: 12 }}>
          <div className="ap-card-head">
            <span role="heading" aria-level={2} className="ap-card-title">
              {dayHeading(ms[0].startAt)}
            </span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--dim2)" }}>
              {ms.length} {ms.length === 1 ? "match" : "matcher"}
            </span>
          </div>
          <div className="ap-cs2-scroll">
            <div className="ap-table" style={{ minWidth: 640 }}>
              <div className="ap-thead" style={{ gridTemplateColumns: LIST_GRID }}>
                <span>Start</span>
                <span>Match</span>
                <span>Event</span>
                <span>Format</span>
                <span className="ap-r">Linjer</span>
                <span className="ap-r">Veto</span>
              </div>
              {ms.map((m) => (
                <MatchRow key={m.id} m={m} />
              ))}
            </div>
          </div>
        </Card>
      ))}
    </>
  );
}

function TeamsTab() {
  const [data, setData] = useState<{ dbConfigured: boolean; teams?: TeamListItem[] } | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ dbConfigured: boolean; teams?: TeamListItem[] }>("/api/cs2/teams")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta lag"));
  }, []);
  if (error) return <Cs2Empty title="Kunde inte hämta lag" hint={error} />;
  if (data && !data.dbConfigured) return <Cs2NoDb />;
  const teams = (data?.teams ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.players.some((p) => p.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="ap-field" style={{ maxWidth: 320, marginBottom: 12 }}>
        <label htmlFor="cs2-team-q">Sök lag eller spelare</label>
        <input id="cs2-team-q" className="ap-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="t.ex. Vitality, ropz" />
      </div>
      {!data && <Card>Laddar…</Card>}
      {data && (data.teams ?? []).length === 0 && (
        <Cs2Empty title="Inga lag inlästa än" hint="Kör npm run cs2:ingest -- --confirm på datorn för att läsa in topp 50 (VRS)." />
      )}
      <div className="ap-cs2-teams">
        {teams.map((t) => (
          <Link key={t.id} href={`/cs2/lag/${t.id}`} className="ap-cs2-team">
            <b>
              {t.rank ? `#${t.rank} ` : ""}
              {t.name}
            </b>
            {!t.tracked && <span className="ap-tag" style={{ marginLeft: 6 }}>vid behov</span>}
            <small>{t.players.slice(0, 5).join(" · ") || "Trupp saknas"}</small>
            <small>
              {t.maps} kartor · {t.demoMaps} med demo
              {t.nextMatch ? ` · nästa: ${t.nextMatch.opponent} ${dateLabel(t.nextMatch.startAt)}` : ""}
            </small>
          </Link>
        ))}
      </div>
    </>
  );
}

function PlayersTab() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Array<{ id: number; nickname: string; role: string | null; team: { id: number; name: string } | null }>>([]);
  const [noDb, setNoDb] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) {
      setRows([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ dbConfigured: boolean; players?: typeof rows }>(`/api/cs2/players?q=${encodeURIComponent(q.trim())}`)
        .then((r) => {
          setNoDb(!r.dbConfigured);
          setRows(r.players ?? []);
        })
        .catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  if (noDb) return <Cs2NoDb />;
  return (
    <>
      <div className="ap-field" style={{ maxWidth: 320, marginBottom: 12 }}>
        <label htmlFor="cs2-player-q">Sök spelare</label>
        <input id="cs2-player-q" className="ap-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="minst två tecken" />
      </div>
      <div className="ap-cs2-teams">
        {rows.map((p) => (
          <Link key={p.id} href={`/cs2/spelare/${p.id}`} className="ap-cs2-team">
            <b>{p.nickname}</b>
            <small>
              {p.team?.name ?? "Utan lag"}
              {p.role ? ` · ${p.role}` : ""}
            </small>
          </Link>
        ))}
      </div>
    </>
  );
}

export default function Cs2Page() {
  const [tab, setTab] = useState<Tab>("matcher");
  return (
    <div className="ap-cs2">
      <Topbar
        title="CS2"
        sub="Lag, spelare och gameplan-docen per karta — underlaget för props och angles"
        actions={<Freshness job="cs2:update" />}
      />
      <div className="ap-seg ap-cs2-tabs">
        <button className={tab === "matcher" ? "is-active" : ""} aria-pressed={tab === "matcher"} onClick={() => setTab("matcher")}>
          Matcher
        </button>
        <button className={tab === "lag" ? "is-active" : ""} aria-pressed={tab === "lag"} onClick={() => setTab("lag")}>
          Lag
        </button>
        <button className={tab === "spelare" ? "is-active" : ""} aria-pressed={tab === "spelare"} onClick={() => setTab("spelare")}>
          Spelare
        </button>
        <button className={tab === "facit" ? "is-active" : ""} aria-pressed={tab === "facit"} onClick={() => setTab("facit")}>
          Facit
        </button>
      </div>
      {tab === "matcher" && <MatchesTab />}
      {tab === "lag" && <TeamsTab />}
      {tab === "spelare" && <PlayersTab />}
      {tab === "facit" && <FacitPanel />}
    </div>
  );
}
