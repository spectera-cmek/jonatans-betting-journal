"use client";

/**
 * Bokens linjer för en match: mata in för hand eller läs av en eller flera
 * skärmdumpar av bokens marknader (spelarprops och lagmarknader), och se
 * modellens fair odds, edge och ½ Kelly direkt. "Logga
 * bet" öppnar bet-formuläret förifyllt med marknad, linje och odds.
 */

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/fetcher";
import { Card } from "@/components/ui";
import { I, IC } from "@/components/icons";
import { fileToJpegBase64 } from "@/components/ScreenshotImportButton";
import type { BetPrefill } from "@/components/AddBetModal";
import { revalidateAll, useMetrics, useSettings } from "@/lib/useData";
import { kellyAdvice } from "@/lib/staking";
import type { MatchupView, PricedLine } from "@/lib/cs2/matchup";
import { CS2_MARKET_LABEL, CS2_SCOPE_LABEL, PLAYER_MARKETS, TOTAL_MARKETS, type Cs2Market, type Cs2Scope } from "@/lib/cs2/types";
import { dec, pct } from "./common";

const AddBetModal = dynamic(() => import("@/components/AddBetModal").then((m) => m.AddBetModal), { ssr: false });

const MARKETS = Object.keys(CS2_MARKET_LABEL) as Cs2Market[];
const SCOPES = Object.keys(CS2_SCOPE_LABEL) as Cs2Scope[];
const TEAM_MARKETS = new Set<Cs2Market>(["map_handicap", "map_winner", "match_winner", "match_handicap", "pistol", "first_kill"]);
const HANDICAP = new Set<Cs2Market>(["map_handicap", "match_handicap"]);

const BET_CATEGORY: Record<Cs2Market, string> = {
  kills: "Kills",
  headshots: "Headshots",
  rounds: "Rundor",
  map_handicap: "Handikapp",
  map_winner: "Matchvinnare",
  match_winner: "Matchvinnare",
  match_handicap: "Kartor",
  total_maps: "Kartor",
  pistol: "Pistolrunda",
  first_kill: "Första kill",
  player_first_kill: "Första kill",
};

interface ParsedRow {
  market: string;
  scope: Cs2Scope;
  player: string | null;
  team: string | null;
  line: number | null;
  overOdds: number | null;
  underOdds: number | null;
  includesOt: boolean | null;
  playerId: number | null;
  teamId: number | null;
  /** Varför raden inte kan sparas (null = den sparas). */
  skip: string | null;
}

const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return s.trim() && Number.isFinite(n) ? n : null;
};

function sideLabel(l: PricedLine, side: "over" | "under", view: MatchupView): string {
  if (TOTAL_MARKETS.has(l.market)) return side === "over" ? "Över" : "Under";
  if (l.market === "player_first_kill") return side === "over" ? "Ja" : "Nej";
  const t1 = l.teamId === view.team2.id ? view.team2.name : view.team1.name;
  const t2 = l.teamId === view.team2.id ? view.team1.name : view.team2.name;
  return side === "over" ? t1 : t2;
}

export function LinesPanel({ view, onChanged }: { view: MatchupView; onChanged: () => void }) {
  const players = view.players;
  const [market, setMarket] = useState<Cs2Market>("kills");
  const [scope, setScope] = useState<Cs2Scope>(view.match.format === "bo1" ? "map1" : "maps12");
  const [playerId, setPlayerId] = useState<number | null>(players[0]?.playerId ?? null);
  const [teamId, setTeamId] = useState<number>(view.team1.id);
  const [line, setLine] = useState("");
  const [over, setOver] = useState("");
  const [under, setUnder] = useState("");
  const [book, setBook] = useState("Bet365");
  const [includesOt, setIncludesOt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ bookmaker: string | null; rows: ParsedRow[] } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<BetPrefill | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: metrics } = useMetrics();
  const { data: settings } = useSettings();
  const bankroll = (metrics?.settings.startingBankrollUnits ?? 100) + (metrics?.metrics?.profitUnits ?? 0);

  const needsPlayer = PLAYER_MARKETS.has(market);
  const needsTeam = TEAM_MARKETS.has(market);
  const needsLine = TOTAL_MARKETS.has(market) || HANDICAP.has(market);

  const save = async (lines: Array<Record<string, unknown>>) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/cs2/lines", { lines });
      onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kunde inte spara linjen");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const ok = await save([
      {
        matchId: view.match.id,
        market,
        scope,
        playerId: needsPlayer ? playerId : null,
        teamId: needsTeam ? teamId : null,
        line: needsLine ? num(line) : null,
        overOdds: num(over),
        underOdds: num(under),
        bookmaker: book || null,
        includesOt,
      },
    ]);
    if (ok) {
      setOver("");
      setUnder("");
    }
  };

  // En eller flera skärmdumpar läses i tur och ordning och samlas i en förhandsvisning.
  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setBusy(true);
    setErr(null);
    const rows: ParsedRow[] = [];
    let bookmaker: string | null = null;
    const failed: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        setProgress(files.length > 1 ? `Läser bild ${i + 1} av ${files.length} …` : "Läser bilden …");
        try {
          const imageBase64 = await fileToJpegBase64(files[i]);
          const r = await api.post<{ bookmaker: string | null; rows: ParsedRow[] }>("/api/cs2/lines/parse-screenshot", {
            matchId: view.match.id,
            imageBase64,
            mediaType: "image/jpeg",
          });
          rows.push(...r.rows);
          bookmaker ??= r.bookmaker;
        } catch (e) {
          failed.push(`bild ${i + 1}: ${e instanceof Error ? e.message : "kunde inte tolkas"}`);
        }
      }
      if (rows.length > 0) setParsed({ bookmaker, rows });
      if (bookmaker) setBook(bookmaker);
      if (failed.length) setErr(failed.join(" · "));
      else if (rows.length === 0) setErr("Inga CS2-marknader hittades på bilden.");
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const saveParsed = async () => {
    if (!parsed) return;
    const rows = parsed.rows.filter((r) => !r.skip);
    const ok = await save(
      rows.map((r) => ({
        matchId: view.match.id,
        market: r.market,
        scope: r.scope,
        playerId: PLAYER_MARKETS.has(r.market as Cs2Market) ? r.playerId : null,
        teamId: TEAM_MARKETS.has(r.market as Cs2Market) ? r.teamId : null,
        line: r.line,
        overOdds: r.overOdds,
        underOdds: r.underOdds,
        includesOt: r.includesOt ?? includesOt,
        bookmaker: parsed.bookmaker ?? book,
        source: "screenshot",
      }))
    );
    if (ok) setParsed(null);
  };

  const parsedWho = (r: ParsedRow) => {
    if (PLAYER_MARKETS.has(r.market as Cs2Market)) return r.player ?? "?";
    if (TEAM_MARKETS.has(r.market as Cs2Market)) {
      const t = r.teamId === view.team1.id ? view.team1.name : r.teamId === view.team2.id ? view.team2.name : r.team;
      return t ?? "?";
    }
    return "";
  };

  const remove = async (id: number | undefined) => {
    if (!id) return;
    await api.del(`/api/cs2/lines?id=${id}`);
    onChanged();
  };

  const logBet = (l: PricedLine) => {
    if (!l.price?.bestSide || !l.price.bestOdds) return;
    const side = l.price.bestSide;
    const p = side === "over" ? l.price.pFinal * (1 - l.price.pPush) : (1 - l.price.pFinal) * (1 - l.price.pPush);
    const k = kellyAdvice(l.price.bestOdds, p, bankroll);
    const isPlayer = l.playerId != null;
    const pick = sideLabel(l, side, view);
    const lineTxt = l.line != null ? ` ${String(l.line).replace(".", ",")}` : "";
    setPrefill({
      form: {
        eventAt: view.match.startAt.slice(0, 10),
        sport: "Esports",
        league: view.match.eventName ?? "",
        event: `${view.team1.name} vs ${view.team2.name}`,
        homeTeam: view.team1.name,
        awayTeam: view.team2.name,
        market: l.market === "match_winner" ? "h2h" : "other",
        marketCategory: BET_CATEGORY[l.market],
        marketScope: isPlayer ? "player" : l.teamId != null ? "team" : "match",
        selection: `${l.label.split(" · ")[0]} ${pick}${lineTxt} (${CS2_SCOPE_LABEL[l.scope]})`.replace(/\s+/g, " "),
        selectionSide: TOTAL_MARKETS.has(l.market) ? side : l.market === "match_winner" ? (l.teamId === view.team2.id) === (side === "over") ? "away" : "home" : "home",
        line: l.line != null ? String(l.line) : "",
        odds: String(l.price.bestOdds),
        stakeUnits: k.halfUnits > 0 ? String(Math.max(0.25, Math.round(k.halfUnits * 4) / 4)) : "1",
        bookmaker: l.bookmaker ?? book,
        notes: `CS2-modell ${view.model.version}: fair ${dec(side === "over" ? l.price.fairOver : l.price.fairUnder)}, edge ${pct(l.price.edge, 1)}`,
      },
    });
    setModalOpen(true);
  };

  const sorted = useMemo(() => [...view.lines].sort((a, b) => (b.price?.edge ?? -1) - (a.price?.edge ?? -1)), [view.lines]);
  const GRID = "1.7fr 64px 96px 56px 60px 130px 70px 140px";

  return (
    <Card style={{ padding: 0, marginBottom: 16 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">Bokens linjer</span>
        <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>Modellvikt {Math.round(view.model.blendW * 100)} % mot bokens avviggade pris</span>
      </div>
      <div style={{ padding: "14px 20px" }}>
        <div className="ap-cs2-controls">
          <div className="ap-field">
            <label htmlFor="ln-market">Marknad</label>
            <div className="ap-select">
              <select id="ln-market" value={market} onChange={(e) => setMarket(e.target.value as Cs2Market)}>
                {MARKETS.map((m) => (
                  <option key={m} value={m}>
                    {CS2_MARKET_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="ap-field">
            <label htmlFor="ln-scope">Avser</label>
            <div className="ap-select">
              <select id="ln-scope" value={scope} onChange={(e) => setScope(e.target.value as Cs2Scope)}>
                {SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {CS2_SCOPE_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {needsPlayer && (
            <div className="ap-field">
              <label htmlFor="ln-player">Spelare</label>
              <div className="ap-select">
                <select id="ln-player" value={playerId ?? ""} onChange={(e) => setPlayerId(Number(e.target.value))}>
                  {players.map((p) => (
                    <option key={p.playerId} value={p.playerId}>
                      {p.nickname} ({p.side === 1 ? view.team1.name : view.team2.name})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {needsTeam && (
            <div className="ap-field">
              <label htmlFor="ln-team">Lag (sida 1)</label>
              <div className="ap-select">
                <select id="ln-team" value={teamId} onChange={(e) => setTeamId(Number(e.target.value))}>
                  <option value={view.team1.id}>{view.team1.name}</option>
                  <option value={view.team2.id}>{view.team2.name}</option>
                </select>
              </div>
            </div>
          )}
          {needsLine && (
            <div className="ap-field" style={{ width: 90 }}>
              <label htmlFor="ln-line">{HANDICAP.has(market) ? "Handikapp" : "Linje"}</label>
              <input id="ln-line" className="ap-input ap-num" inputMode="decimal" value={line} onChange={(e) => setLine(e.target.value)} placeholder={HANDICAP.has(market) ? "-1.5" : "38.5"} />
            </div>
          )}
          <div className="ap-field" style={{ width: 90 }}>
            <label htmlFor="ln-over">{TOTAL_MARKETS.has(market) ? "Över" : market === "player_first_kill" ? "Ja" : "Sida 1"}</label>
            <input id="ln-over" className="ap-input ap-num" inputMode="decimal" value={over} onChange={(e) => setOver(e.target.value)} placeholder="1.85" />
          </div>
          <div className="ap-field" style={{ width: 90 }}>
            <label htmlFor="ln-under">{TOTAL_MARKETS.has(market) ? "Under" : market === "player_first_kill" ? "Nej" : "Sida 2"}</label>
            <input id="ln-under" className="ap-input ap-num" inputMode="decimal" value={under} onChange={(e) => setUnder(e.target.value)} placeholder="1.85" />
          </div>
          <div className="ap-field" style={{ width: 120 }}>
            <label htmlFor="ln-book">Bok</label>
            <input id="ln-book" className="ap-input" value={book} onChange={(e) => setBook(e.target.value)} />
          </div>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--dim)" }}>
            <input type="checkbox" checked={includesOt} onChange={(e) => setIncludesOt(e.target.checked)} /> Övertid räknas
          </label>
          <button className="ap-btn" disabled={busy} onClick={submit}>
            <I p={IC.plus} size={14} /> Lägg till
          </button>
          <button className="ap-btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
            <I p={IC.upload} size={14} /> Skärmdumpar av marknader
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        </div>
        {err && <div className="neg" style={{ fontSize: 12.5, marginTop: 8 }}>{err}</div>}
        {busy && <div style={{ fontSize: 12.5, marginTop: 8, color: "var(--dim)" }}>{progress ?? "Arbetar…"}</div>}

        {parsed && (
          <div className="ap-cs2-warn" style={{ marginTop: 12 }}>
            <b>
              {parsed.rows.length} linjer lästa{parsed.bookmaker ? ` från ${parsed.bookmaker}` : ""}
              {parsed.rows.some((r) => r.skip) ? `, ${parsed.rows.filter((r) => !r.skip).length} kan sparas` : ""} — kontrollera innan du sparar
            </b>
            <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
              {parsed.rows.map((r, i) => (
                <li key={i} style={r.skip ? { color: "var(--dim2)" } : undefined}>
                  {CS2_MARKET_LABEL[r.market as Cs2Market] ?? "Annan marknad"} · {CS2_SCOPE_LABEL[r.scope]}
                  {parsedWho(r) ? ` · ${parsedWho(r)}` : ""}
                  {r.line != null ? ` · ${String(r.line).replace(".", ",")}` : ""} · {r.overOdds ?? "—"} / {r.underOdds ?? "—"}
                  {r.skip ? ` (hoppas över: ${r.skip})` : ""}
                </li>
              ))}
            </ul>
            <button className="ap-btn" disabled={busy || parsed.rows.every((r) => r.skip)} onClick={saveParsed}>
              Spara {parsed.rows.filter((r) => !r.skip).length} linjer
            </button>{" "}
            <button className="ap-btn ghost" onClick={() => setParsed(null)}>
              Avbryt
            </button>
          </div>
        )}
      </div>

      {sorted.length > 0 && (
        <div className="ap-cs2-scroll">
          <div className="ap-table" style={{ minWidth: 900 }}>
            <div className="ap-thead" style={{ gridTemplateColumns: GRID }}>
              <span>Linje</span>
              <span className="ap-r">Modell</span>
              <span className="ap-r">Odds Ö/U</span>
              <span className="ap-r">P</span>
              <span className="ap-r">Fair</span>
              <span className="ap-r">Edge</span>
              <span className="ap-r">½ Kelly</span>
              <span />
            </div>
            {sorted.map((l) => {
              const pr = l.price;
              const side = pr?.bestSide ?? null;
              const p = pr && side ? (side === "over" ? pr.pFinal : 1 - pr.pFinal) : null;
              const fair = pr && side ? (side === "over" ? pr.fairOver : pr.fairUnder) : null;
              const k = pr?.bestOdds && p != null ? kellyAdvice(pr.bestOdds, p * (1 - pr.pPush), bankroll) : null;
              return (
                <div key={l.id} className="ap-trow" style={{ gridTemplateColumns: GRID }}>
                  <span className="ap-ell" title={l.label}>
                    {l.label}
                    {l.bookmaker && <span className="ap-tag" style={{ marginLeft: 6 }}>{l.bookmaker}</span>}
                    {!l.includesOt && <span className="ap-tag" style={{ marginLeft: 4 }}>ej OT</span>}
                    {l.pPlayed < 0.999 && <span className="ap-tag" style={{ marginLeft: 4 }}>spelas {pct(l.pPlayed)}</span>}
                  </span>
                  <span className="ap-r ap-num" style={{ color: "var(--dim)" }}>{l.mean != null ? dec(l.mean, 1) : "—"}</span>
                  <span className="ap-r ap-num">
                    {l.overOdds?.toFixed(2) ?? "—"} / {l.underOdds?.toFixed(2) ?? "—"}
                  </span>
                  <span className="ap-r ap-num">{p != null ? pct(p) : "—"}</span>
                  <span className="ap-r ap-num">{fair != null ? fair.toFixed(2) : "—"}</span>
                  <span className={`ap-r ap-num ${pr?.edge != null ? (pr.edge > 0 ? "pos" : "neg") : ""}`}>
                    {pr?.edge != null ? `${side ? sideLabel(l, side, view) : ""} ${pr.edge >= 0 ? "+" : ""}${(pr.edge * 100).toFixed(1)} %` : "—"}
                  </span>
                  <span className="ap-r ap-num">{k && k.hasEdge ? `${k.halfUnits.toFixed(2)} u` : "—"}</span>
                  <span className="ap-r" style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {pr?.edge != null && pr.edge > 0 && (
                      <button className="ap-btn" style={{ padding: "4px 9px", fontSize: 11 }} onClick={() => logBet(l)}>
                        Logga bet
                      </button>
                    )}
                    <button className="ap-btn ghost" style={{ padding: "4px 7px" }} aria-label="Ta bort linjen" onClick={() => remove(l.id)}>
                      <I p={IC.trash} size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {sorted.length === 0 && (
        <div style={{ padding: "0 20px 16px", fontSize: 12.5, color: "var(--dim2)" }}>
          Inga linjer än. Skriv in bokens linje och odds, eller ladda upp en skärmdump av props-listan — modellens fair odds och edge räknas direkt.
        </div>
      )}

      <AddBetModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          revalidateAll();
        }}
        hasOddsApiKey={settings?.hasOddsApiKey ?? false}
        prefill={prefill}
        unit={settings?.unitValue || 100}
      />
    </Card>
  );
}
