"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { InlineStat } from "@/components/stats";
import { SPORT_IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import type { GameDetailJson } from "@/lib/nba/api";
import { PropsPanel } from "@/components/nba/PropsPanel";
import { MARKET_LABEL, NbaEmpty, NbaNoDb, dateLabel, dec, pct, sideLabel, signed, type Market } from "@/components/nba/common";

type Resp = GameDetailJson | { dbConfigured: false };
type Lineup = GameDetailJson["home"];
type Quote = GameDetailJson["quotes"][number];

const Q_GRID = "1fr 90px 1.4fr 1fr 70px 70px 70px 1.3fr";
const M_GRID = "1.6fr 34px 52px 1.1fr 88px";

function QuoteRow({ q, home, away, onDelete }: { q: Quote; home: string; away: string; onDelete?: () => void }) {
  const best = q.bestSide === "over" ? 1 : q.bestSide === "under" ? 2 : null;
  return (
    <div className={`ap-trow${q.flagged ? " ap-nba-flag" : ""}`} style={{ gridTemplateColumns: Q_GRID }}>
      <span className="ap-ell">
        {q.book ?? "—"}
        <span style={{ color: "var(--dim2)", fontSize: 11 }}> · {q.source === "manual" ? "eget" : q.source}</span>
      </span>
      <span>{MARKET_LABEL[q.market]}</span>
      <span className="ap-ell ap-num">
        {sideLabel(q.market, 1, q.line, home, away)} {dec(q.price1)} / {dec(q.price2)}
      </span>
      <span className="ap-r ap-num">
        {pct(q.pModel, 1)} · {q.pMarket == null ? "—" : pct(q.pMarket, 1)}
      </span>
      <span className="ap-r ap-num">{pct(q.pFinal, 1)}</span>
      <span className="ap-r ap-num">{dec(q.fairOver)}</span>
      <span className="ap-r ap-num">{dec(q.fairUnder)}</span>
      <span className="ap-ell">
        {best && q.edge != null ? (
          <>
            <b className={q.edge >= 0 ? "pos" : "neg"}>{(q.edge * 100).toFixed(1)} %</b> {sideLabel(q.market, best, q.line, home, away)}
          </>
        ) : (
          "—"
        )}
        {onDelete && (
          <button className="ap-btn ghost" style={{ marginLeft: 8, padding: "2px 8px", fontSize: 11 }} onClick={onDelete}>
            Ta bort
          </button>
        )}
      </span>
    </div>
  );
}

function MinutesCard({
  title,
  lineup,
  edits,
  resets,
  setEdit,
}: {
  title: string;
  lineup: Lineup;
  edits: Record<number, string>;
  resets: Set<number>;
  setEdit: (playerId: number, v: string | null) => void;
}) {
  const total = lineup.rows.reduce((a, r) => a + r.minutes, 0);
  return (
    <Card style={{ padding: 0 }}>
      <div className="ap-card-head">
        <span role="heading" aria-level={2} className="ap-card-title">{title}</span>
        <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>{total.toFixed(0)} min</span>
      </div>
      <div className="ap-table">
        <div className="ap-thead" style={{ gridTemplateColumns: M_GRID }}>
          <span>Spelare</span>
          <span>Pos</span>
          <span className="ap-r">Snitt</span>
          <span>Status</span>
          <span className="ap-r">Minuter</span>
        </div>
        {lineup.rows.map((r) => {
          const edited = edits[r.playerId];
          const hasOverride = r.override != null && !resets.has(r.playerId);
          const value = edited ?? (hasOverride ? String(r.override) : "");
          return (
            <div key={r.playerId} className={`ap-trow${r.minutes === 0 ? " ap-nba-out" : ""}`} style={{ gridTemplateColumns: M_GRID }}>
              <span className="ap-ell">{r.name}</span>
              <span style={{ color: "var(--dim)" }}>{r.position ?? "—"}</span>
              <span className="ap-r ap-num">{r.baseline.toFixed(1)}</span>
              <span className="ap-ell" style={{ fontSize: 12, color: r.injuryStatus ? "var(--amber, #d97706)" : "var(--dim2)" }} title={r.injuryDetail ?? undefined}>
                {r.injuryStatus ?? (hasOverride ? "ändrad" : "")}
              </span>
              <span className="ap-r" style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
                <input
                  className={`ap-input ap-nba-min${hasOverride || edited != null ? " is-set" : ""}`}
                  inputMode="decimal"
                  placeholder={r.minutes.toFixed(1)}
                  value={value}
                  onChange={(e) => setEdit(r.playerId, e.target.value)}
                  aria-label={`Minuter för ${r.name}`}
                />
                <button
                  className="ap-btn ghost"
                  style={{ padding: "2px 6px", fontSize: 11 }}
                  title={hasOverride || edited != null ? "Återställ till modellens minuter" : "Spelar inte"}
                  onClick={() => setEdit(r.playerId, hasOverride || edited != null ? null : "0")}
                >
                  {hasOverride || edited != null ? "↺" : "Ut"}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ManualOdds({ gameId, home, away, onSaved }: { gameId: number; home: string; away: string; onSaved: () => void }) {
  const [book, setBook] = useState("");
  const [market, setMarket] = useState<Market>("spread");
  const [line, setLine] = useState("");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/nba/odds", { gameId, book, market, line: market === "ml" ? null : line, price1: p1, price2: p2 });
      setP1("");
      setP2("");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kunde inte spara");
    } finally {
      setBusy(false);
    }
  };
  const l1 = market === "total" ? "Över" : home;
  const l2 = market === "total" ? "Under" : away;
  return (
    <div className="ap-nba-form">
      <div className="ap-field">
        <label htmlFor="nba-book">Bolag</label>
        <input id="nba-book" className="ap-input" value={book} onChange={(e) => setBook(e.target.value)} placeholder="t.ex. Unibet" />
      </div>
      <div className="ap-field">
        <label htmlFor="nba-market">Marknad</label>
        <select id="nba-market" className="ap-input" value={market} onChange={(e) => setMarket(e.target.value as Market)}>
          <option value="ml">Vinnare</option>
          <option value="spread">Spread</option>
          <option value="total">Total</option>
        </select>
      </div>
      {market !== "ml" && (
        <div className="ap-field">
          <label htmlFor="nba-line">{market === "spread" ? `Linje ${home}` : "Linje"}</label>
          <input id="nba-line" className="ap-input" inputMode="decimal" value={line} onChange={(e) => setLine(e.target.value)} placeholder={market === "spread" ? "−5,5" : "224,5"} />
        </div>
      )}
      <div className="ap-field">
        <label htmlFor="nba-p1">{l1}</label>
        <input id="nba-p1" className="ap-input" inputMode="decimal" value={p1} onChange={(e) => setP1(e.target.value)} placeholder="1,91" />
      </div>
      <div className="ap-field">
        <label htmlFor="nba-p2">{l2}</label>
        <input id="nba-p2" className="ap-input" inputMode="decimal" value={p2} onChange={(e) => setP2(e.target.value)} placeholder="1,91" />
      </div>
      <button className="ap-btn" disabled={busy} onClick={save}>
        Lägg till
      </button>
      {err && <span style={{ color: "var(--red)", fontSize: 12 }}>{err}</span>}
    </div>
  );
}

export default function NbaMatchPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [resets, setResets] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<Resp>(`/api/nba/games/${id}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Kunde inte hämta matchen"));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const setEdit = useCallback((playerId: number, v: string | null) => {
    setEdits((e) => {
      const n = { ...e };
      if (v == null) delete n[playerId];
      else n[playerId] = v;
      return n;
    });
    setResets((s) => {
      const n = new Set(s);
      if (v == null) n.add(playerId);
      else n.delete(playerId);
      return n;
    });
  }, []);

  const dirty = Object.keys(edits).length > 0 || resets.size > 0;

  const resimulate = async () => {
    setBusy(true);
    setError(null);
    try {
      const overrides = [
        ...Object.entries(edits).map(([playerId, v]) => ({ playerId: Number(playerId), minutes: v.trim() === "" ? null : Number(v.replace(",", ".")) })),
        ...[...resets].filter((p) => !(p in edits)).map((playerId) => ({ playerId, minutes: null })),
      ];
      const r = await api.put<Resp>(`/api/nba/games/${id}`, { overrides });
      setData(r);
      setEdits({});
      setResets(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte räkna om");
    } finally {
      setBusy(false);
    }
  };

  const delQuote = async (qid: number) => {
    await api.del(`/api/nba/odds?id=${qid}`).catch(() => null);
    load();
  };

  const d = data && data.dbConfigured ? data : null;
  const quotes = useMemo(() => (d ? [...d.quotes].sort((a, b) => a.market.localeCompare(b.market) || (b.edge ?? -1) - (a.edge ?? -1)) : []), [d]);

  if (error && !d) return <NbaEmpty title="Kunde inte hämta matchen" hint={error} />;
  if (data && !data.dbConfigured) return <NbaNoDb />;
  if (!d) return <Card>Simulerar…</Card>;
  const s = d.summary;
  const H = d.game.home.abbr;
  const A = d.game.away.abbr;
  const final = d.game.status === "final";

  return (
    <div className="ap-nba">
      <Topbar
        title={`${d.game.away.name} @ ${d.game.home.name}`}
        sub={
          <>
            {dateLabel(d.game.startAt)}
            {final ? ` · slut ${d.game.awayScore}–${d.game.homeScore}` : ""} · <Link href="/nba">← alla matcher</Link>
          </>
        }
        icon={SPORT_IC.basketball}
        accent="amber"
      />

      {(d.homeB2B || d.awayB2B) && (
        <div className="ap-cs2-warn" style={{ marginBottom: 16 }}>
          {[d.awayB2B ? d.game.away.name : null, d.homeB2B ? d.game.home.name : null].filter(Boolean).join(" och ")} spelar andra dagen i rad —
          modellen drar av lite på träffprocenten.
        </div>
      )}

      <Card style={{ marginBottom: 16 }}>
        <div className="ap-shot-summary" style={{ flexWrap: "wrap", gap: 22 }}>
          <InlineStat label="Modellens resultat" value={`${A} ${s.awayMean.toFixed(1)} – ${s.homeMean.toFixed(1)} ${H}`} />
          <InlineStat label={`${H} vinner`} value={`${pct(s.pHomeWin, 1)} · ${dec(1 / s.pHomeWin)}`} />
          <InlineStat label={`${A} vinner`} value={`${pct(1 - s.pHomeWin, 1)} · ${dec(1 / (1 - s.pHomeWin))}`} />
          <InlineStat label={`Spread ${H}`} value={signed(d.modelSpread)} />
          <InlineStat label="Total" value={String(d.modelTotal).replace(".", ",")} />
          <InlineStat label="Spridning marginal / total" value={`${s.marginSd.toFixed(1)} / ${s.totalSd.toFixed(1)}`} />
        </div>
        <details className="ap-fine">
          <summary>Så räknas det</summary>
          <div className="ap-fine-details">
            Varje spelares takter per minut (2PA, 3PA, straffar, turnovers, offensiva returer) och träffprocent räknas ur hans senaste matcher,
            krympta mot positionens snitt. Takterna viktas med minuterna nedan till lagets anfall, som justeras mot motståndarens försvar och
            hemmaplan. Matchen spelas sedan {"10 000"} gånger possession för possession, med förlängning vid lika. Modellens sannolikhet vägs till
            sist mot bolagets pris (efter att marginalen räknats bort) — se <code>npm run nba:backtest</code> för hur mycket modellen ska lita på
            sig själv.
          </div>
        </details>
      </Card>

      <Card style={{ padding: 0, marginBottom: 16 }}>
        <div className="ap-card-head">
          <span role="heading" aria-level={2} className="ap-card-title">Priser</span>
          <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>Modell · marknad → viktad. Edge ≥ 5 % markeras.</span>
        </div>
        <div className="ap-nba-scroll">
          <div className="ap-table" style={{ minWidth: 820 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: Q_GRID }}>
              <span>Bolag</span>
              <span>Marknad</span>
              <span>Linje · sida 1 / sida 2</span>
              <span className="ap-r">Modell · marknad</span>
              <span className="ap-r">Viktad</span>
              <span className="ap-r">Fair 1</span>
              <span className="ap-r">Fair 2</span>
              <span>Edge</span>
            </div>
            {quotes.length === 0 && (
              <div className="ap-trow" style={{ gridTemplateColumns: "1fr", color: "var(--dim2)" }}>
                Inga priser än — kör npm run nba:update (OddsPapi/ESPN) eller lägg till ditt eget nedan.
              </div>
            )}
            {quotes.map((q) => (
              <QuoteRow key={q.id} q={q} home={H} away={A} onDelete={q.source === "manual" ? () => delQuote(q.id) : undefined} />
            ))}
          </div>
        </div>
        {!final && <ManualOdds gameId={d.game.id} home={H} away={A} onSaved={load} />}
      </Card>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <button className="ap-btn" disabled={!dirty || busy} onClick={resimulate}>
          {busy ? "Simulerar…" : "Simulera om"}
        </button>
        <span style={{ fontSize: 12, color: "var(--dim2)" }}>
          Ändra minuter (0 = spelar inte) eller tryck Ut. Övriga spelare fördelas om så att laget får 240 minuter.
        </span>
        {error && <span style={{ color: "var(--red)", fontSize: 12 }}>{error}</span>}
      </div>
      <div className="ap-nba-teams">
        <MinutesCard title={`${d.game.away.name} (borta)`} lineup={d.away} edits={edits} resets={resets} setEdit={setEdit} />
        <MinutesCard title={`${d.game.home.name} (hemma)`} lineup={d.home} edits={edits} resets={resets} setEdit={setEdit} />
      </div>
      <PropsPanel
        gameId={d.game.id}
        props={d.props}
        teamAbbr={new Map([
          [d.game.home.id, H],
          [d.game.away.id, A],
        ])}
        editable={!final}
        onChanged={load}
      />
    </div>
  );
}
