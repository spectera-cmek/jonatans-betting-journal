"use client";

/**
 * Snabbläge för spelarprops i kartpausen. Två sätt, samma karta och marknad:
 *  - Stege: modellens fair odds Över/Under för varje spelare på flera linjer.
 *    Jämför direkt med boken; tryck på en linje för att skriva bokens odds
 *    och få edge + "Logga bet".
 *  - Snabbformulär: alla spelare på en skärm, linjen förifylld med modellens,
 *    bara odds att skriva — "Spara alla" i ett anrop.
 *  - Duell: killduellerna på kartan, paren förvalda roll mot roll, med
 *    modellens fair odds för båda — bara bokens odds att skriva.
 */

import { useMemo, useState } from "react";
import { api } from "@/lib/fetcher";
import { Card } from "@/components/ui";
import type { DuelScope, LadderScope, MatchupView, PricedLine } from "@/lib/cs2/matchup";
import { CS2_SCOPE_LABEL } from "@/lib/cs2/types";
import { rolePairs } from "@/lib/cs2/duelPairs";
import { ROLE_LABEL, type Role } from "@/lib/cs2/roles";
import { useLogBet } from "./LinesPanel";

type Market = "kills" | "headshots" | "duel";
const MARKET_LABEL: Record<Market, string> = { kills: "Kills", headshots: "HS", duel: "Duell" };

const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return s.trim() && Number.isFinite(n) ? n : null;
};
const fair = (p: number) => (p > 0.001 ? (1 / p).toFixed(2) : "—");
const lineTxt = (x: number) => String(x).replace(".", ",");

// Spelare, linje, över, under — badge och "Logga bet" på egen rad under.
const FORM_COLS = "minmax(0,1fr) minmax(0,64px) minmax(0,64px) minmax(0,64px)";
const CELL = { padding: "8px 6px", minWidth: 0, width: "100%" } as const;
// Spelare lag 1, spelare lag 2, odds 1, odds 2.
const DUEL_COLS = "minmax(0,1fr) minmax(0,1fr) minmax(0,64px) minmax(0,64px)";

export function QuickProps({ view, onChanged }: { view: MatchupView; onChanged: () => void }) {
  const scopes = Object.keys(view.ladder) as LadderScope[];
  const [scope, setScope] = useState<LadderScope>(scopes.includes(view.suggestedScope) ? view.suggestedScope : scopes[0]);
  const [market, setMarket] = useState<Market>("kills");
  const [tab, setTab] = useState<"ladder" | "form">("ladder");
  const [book, setBook] = useState("Bet365");
  const [includesOt, setIncludesOt] = useState(true);
  const [active, setActive] = useState<{ playerId: number; line: number } | null>(null);
  const [over, setOver] = useState("");
  const [under, setUnder] = useState("");
  const [form, setForm] = useState<Record<number, { line: string; over: string; under: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { logBet, betModal } = useLogBet(view, book);

  const isDuel = market === "duel";
  const rows = isDuel ? [] : view.ladder[scope]?.[market] ?? [];
  const byPlayer = useMemo(() => new Map(rows.map((r) => [r.playerId, r])), [rows]);
  const players = view.players.filter((p) => byPlayer.has(p.playerId));

  // Sparade linjer för samma spelare, karta, marknad och linje — nyaste först.
  const saved = (playerId: number, line: number): PricedLine | null =>
    view.lines.find((l) => l.playerId === playerId && l.market === market && l.scope === scope && l.line === line) ?? null;

  const post = async (lines: Array<Record<string, unknown>>) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/cs2/lines", { lines });
      onChanged();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kunde inte spara");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const lineBody = (playerId: number, line: number, o: number | null, u: number | null) => ({
    matchId: view.match.id,
    market,
    scope,
    playerId,
    line,
    overOdds: o,
    underOdds: u,
    bookmaker: book || null,
    includesOt,
  });

  const openChip = (playerId: number, line: number) => {
    const s = saved(playerId, line);
    setActive({ playerId, line });
    setOver(s?.overOdds != null ? String(s.overOdds) : "");
    setUnder(s?.underOdds != null ? String(s.underOdds) : "");
    setErr(null);
  };
  const saveChip = async () => {
    if (!active) return;
    const o = num(over);
    const u = num(under);
    if (o == null && u == null) return setErr("Skriv minst ett odds");
    if (await post([lineBody(active.playerId, active.line, o, u)])) setActive(null);
  };

  const formRow = (playerId: number) => {
    const r = byPlayer.get(playerId)!;
    return form[playerId] ?? { line: lineTxt(r.median), over: "", under: "" };
  };
  const setFormField = (playerId: number, key: "line" | "over" | "under", v: string) =>
    setForm((f) => ({ ...f, [playerId]: { ...formRow(playerId), [key]: v } }));
  const formReady = players
    .map((p) => ({ p, r: formRow(p.playerId) }))
    .filter(({ r }) => num(r.line) != null && (num(r.over) != null || num(r.under) != null));
  const saveForm = async () => {
    if (formReady.length === 0) return setErr("Fyll i odds för minst en spelare");
    const ok = await post(formReady.map(({ p, r }) => lineBody(p.playerId, num(r.line)!, num(r.over), num(r.under))));
    if (ok) setForm({});
  };

  const switchTo = (s: LadderScope, m: Market) => {
    // Duellen gäller en karta.
    setScope(m === "duel" && s === "maps12" ? scopes.find((x) => x !== "maps12") ?? s : s);
    setMarket(m);
    setActive(null);
    setForm({});
    setDuelOdds({});
  };

  // --- Duell ---------------------------------------------------------------
  const [duelPairs, setDuelPairs] = useState<Partial<Record<LadderScope, Array<{ a: number; b: number }>>>>({});
  const [duelOdds, setDuelOdds] = useState<Record<number, { a: string; b: string }>>({});
  const nick = (id: number) => view.players.find((p) => p.playerId === id)?.nickname ?? "?";
  const t1 = view.players.filter((p) => p.side === 1);
  const t2 = view.players.filter((p) => p.side === 2);
  const defaultPairs = useMemo(() => {
    const kills = new Map((view.ladder[scope]?.kills ?? []).map((r) => [r.playerId, r.median]));
    return rolePairs(view.players.map((p) => ({ playerId: p.playerId, side: p.side, role: p.role, kills: kills.get(p.playerId) ?? p.kprAll ?? 0 })));
  }, [view.players, view.ladder, scope]);
  const pairs = duelPairs[scope] ?? defaultPairs;
  const setPair = (i: number, key: "a" | "b", id: number) => {
    setDuelPairs((d) => ({ ...d, [scope]: pairs.map((p, j) => (j === i ? { ...p, [key]: id } : p)) }));
    setDuelOdds((o) => ({ ...o, [i]: { a: "", b: "" } }));
  };
  const duelModel = (a: number, b: number) => view.duels[scope as DuelScope]?.find((r) => r.a === a && r.b === b) ?? null;
  const duelSaved = (a: number, b: number): PricedLine | null =>
    view.lines.find((l) => l.market === "kill_duel" && l.scope === scope && l.playerId === a && l.player2Id === b) ?? null;
  const duelReady = pairs
    .map((p, i) => ({ p, o: duelOdds[i] ?? { a: "", b: "" } }))
    .filter(({ p, o }) => p.a !== p.b && (num(o.a) != null || num(o.b) != null));
  const saveDuels = async () => {
    if (duelReady.length === 0) return setErr("Fyll i odds för minst ett par");
    const ok = await post(
      duelReady.map(({ p, o }) => ({
        matchId: view.match.id,
        market: "kill_duel",
        scope,
        playerId: p.a,
        player2Id: p.b,
        line: null,
        overOdds: num(o.a),
        underOdds: num(o.b),
        bookmaker: book || null,
        includesOt,
      }))
    );
    if (ok) setDuelOdds({});
  };

  const edgeBadge = (l: PricedLine | null) => {
    const pr = l?.price;
    if (!l || !pr || pr.edge == null || !pr.bestSide) return null;
    const side = l.market === "kill_duel" ? nick((pr.bestSide === "over" ? l.playerId : l.player2Id) ?? -1) : pr.bestSide === "over" ? "Ö" : "U";
    return (
      <span className={pr.edge > 0 ? "pos" : "neg"} style={{ fontWeight: 700 }}>
        {side} {pr.edge >= 0 ? "+" : ""}
        {(pr.edge * 100).toFixed(1)} %
      </span>
    );
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <b>Snabbläge · spelarprops</b>
        <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>fair odds = modellen utan bokens pris · övertid räknas</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
        <div className="ap-seg">
          {scopes.filter((s) => !isDuel || s !== "maps12").map((s) => (
            <button key={s} className={s === scope ? "is-active" : ""} onClick={() => switchTo(s, market)}>
              {CS2_SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="ap-seg">
          {(["kills", "headshots", "duel"] as const).map((m) => (
            <button key={m} className={m === market ? "is-active" : ""} onClick={() => switchTo(scope, m)}>
              {MARKET_LABEL[m]}
            </button>
          ))}
        </div>
        {!isDuel && (
          <div className="ap-seg">
            <button className={tab === "ladder" ? "is-active" : ""} onClick={() => setTab("ladder")}>
              Stege
            </button>
            <button className={tab === "form" ? "is-active" : ""} onClick={() => setTab("form")}>
              Snabbformulär
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10, fontSize: 12.5 }}>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          Bok
          <input className="ap-input" style={{ width: 110 }} value={book} onChange={(e) => setBook(e.target.value)} aria-label="Bok" />
        </label>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "var(--dim)" }}>
          <input type="checkbox" checked={includesOt} onChange={(e) => setIncludesOt(e.target.checked)} /> Övertid räknas
        </label>
      </div>

      {err && <div className="neg" style={{ fontSize: 12.5, marginBottom: 8 }}>{err}</div>}

      {!isDuel && tab === "ladder" && (
        <div style={{ display: "grid", gap: 10 }}>
          {players.map((p) => {
            const r = byPlayer.get(p.playerId)!;
            const isActive = active?.playerId === p.playerId;
            const activeSaved = isActive ? saved(p.playerId, active!.line) : null;
            return (
              <div key={p.playerId}>
                <div style={{ fontSize: 13, marginBottom: 4 }}>
                  <b>{p.nickname}</b>{" "}
                  <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>
                    {p.side === 1 ? view.team1.name : view.team2.name} · linje {lineTxt(r.median)}
                  </span>
                </div>
                <div className="ap-cs2-scroll" style={{ display: "flex", gap: 6, paddingBottom: 2 }}>
                  {r.lines.map((x) => {
                    const s = saved(p.playerId, x.line);
                    const sel = isActive && active!.line === x.line;
                    const edge = s?.price?.edge;
                    return (
                      <button
                        key={x.line}
                        onClick={() => openChip(p.playerId, x.line)}
                        aria-label={`${p.nickname} ${lineTxt(x.line)}`}
                        style={{
                          flex: "0 0 auto",
                          minWidth: 78,
                          textAlign: "left",
                          padding: "6px 8px",
                          borderRadius: 8,
                          cursor: "pointer",
                          background: sel ? "var(--surface-2, rgba(255,255,255,0.06))" : "transparent",
                          color: "inherit",
                          border: `1px solid ${edge != null ? (edge > 0 ? "var(--pos, #10b981)" : "var(--line)") : x.line === r.median ? "var(--dim)" : "var(--line)"}`,
                          fontSize: 11.5,
                          lineHeight: 1.35,
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 12.5 }}>{lineTxt(x.line)}</div>
                        <div className="ap-num">Ö {fair(x.pOver)}</div>
                        <div className="ap-num">U {fair(1 - x.pOver)}</div>
                        {s && <div style={{ fontSize: 11 }}>{edgeBadge(s)}</div>}
                      </button>
                    );
                  })}
                </div>
                {isActive && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6, fontSize: 12.5 }}>
                    <span>
                      Bokens odds {lineTxt(active!.line)}:
                    </span>
                    <input
                      className="ap-input ap-num"
                      style={{ width: 70 }}
                      inputMode="decimal"
                      placeholder="Över"
                      aria-label="Över-odds"
                      value={over}
                      onChange={(e) => setOver(e.target.value)}
                      autoFocus
                    />
                    <input
                      className="ap-input ap-num"
                      style={{ width: 70 }}
                      inputMode="decimal"
                      placeholder="Under"
                      aria-label="Under-odds"
                      value={under}
                      onChange={(e) => setUnder(e.target.value)}
                    />
                    <button className="ap-btn" disabled={busy} onClick={saveChip}>
                      {busy ? "…" : "Spara"}
                    </button>
                    {activeSaved?.price?.edge != null && activeSaved.price.edge > 0 && (
                      <button className="ap-btn" onClick={() => logBet(activeSaved)}>
                        Logga bet
                      </button>
                    )}
                    <button className="ap-btn ghost" onClick={() => setActive(null)} aria-label="Stäng">
                      ×
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {players.length === 0 && <div style={{ fontSize: 12.5, color: "var(--dim2)" }}>Inga spelare med modell för den här kartan.</div>}
        </div>
      )}

      {!isDuel && tab === "form" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: FORM_COLS, gap: 6, fontSize: 11.5, color: "var(--dim2)", marginBottom: 4 }}>
            <span>Spelare</span>
            <span>Linje</span>
            <span>Över</span>
            <span>Under</span>
          </div>
          {players.map((p) => {
            const r = formRow(p.playerId);
            const s = num(r.line) != null ? saved(p.playerId, num(r.line)!) : null;
            return (
              <div key={p.playerId} style={{ display: "grid", gridTemplateColumns: FORM_COLS, gap: 6, alignItems: "center", marginBottom: 6 }}>
                <span className="ap-ell" style={{ fontSize: 13 }}>
                  <b>{p.nickname}</b>
                </span>
                <input className="ap-input ap-num" style={CELL} inputMode="decimal" aria-label={`${p.nickname} linje`} value={r.line} onChange={(e) => setFormField(p.playerId, "line", e.target.value)} />
                <input className="ap-input ap-num" style={CELL} inputMode="decimal" aria-label={`${p.nickname} över`} value={r.over} onChange={(e) => setFormField(p.playerId, "over", e.target.value)} />
                <input className="ap-input ap-num" style={CELL} inputMode="decimal" aria-label={`${p.nickname} under`} value={r.under} onChange={(e) => setFormField(p.playerId, "under", e.target.value)} />
                {s?.price && (
                  <span style={{ gridColumn: "1 / -1", fontSize: 11.5, display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", minWidth: 0 }}>
                    {edgeBadge(s)}
                    {s.price.edge != null && s.price.edge > 0 && (
                      <button className="ap-btn" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => logBet(s)}>
                        Logga bet
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          <button className="ap-btn" disabled={busy || formReady.length === 0} onClick={saveForm} style={{ marginTop: 6 }}>
            {busy ? "Sparar…" : `Spara alla (${formReady.length})`}
          </button>
        </div>
      )}
      {isDuel && (
        <div>
          <div style={{ fontSize: 11.5, color: "var(--dim2)", marginBottom: 6 }}>
            Flest kills på kartan, lika = void. Paren är förvalda roll mot roll — byt spelare om boken parar annorlunda.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: DUEL_COLS, gap: 6, fontSize: 11.5, color: "var(--dim2)", marginBottom: 4 }}>
            <span>{view.team1.name}</span>
            <span>{view.team2.name}</span>
            <span>Odds 1</span>
            <span>Odds 2</span>
          </div>
          {pairs.map((p, i) => {
            const m = duelModel(p.a, p.b);
            const o = duelOdds[i] ?? { a: "", b: "" };
            const s = duelSaved(p.a, p.b);
            const setOdds = (key: "a" | "b", v: string) => setDuelOdds((d) => ({ ...d, [i]: { ...o, [key]: v } }));
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: DUEL_COLS, gap: 6, alignItems: "center" }}>
                  <div className="ap-select">
                    <select aria-label={`Par ${i + 1} spelare 1`} value={p.a} onChange={(e) => setPair(i, "a", Number(e.target.value))} style={CELL}>
                      {t1.map((x) => (
                        <option key={x.playerId} value={x.playerId}>
                          {x.nickname}
                          {x.role ? ` · ${ROLE_LABEL[x.role as Role] ?? x.role}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ap-select">
                    <select aria-label={`Par ${i + 1} spelare 2`} value={p.b} onChange={(e) => setPair(i, "b", Number(e.target.value))} style={CELL}>
                      {t2.map((x) => (
                        <option key={x.playerId} value={x.playerId}>
                          {x.nickname}
                          {x.role ? ` · ${ROLE_LABEL[x.role as Role] ?? x.role}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input className="ap-input ap-num" style={CELL} inputMode="decimal" aria-label={`${nick(p.a)} odds`} placeholder={m ? fair(m.pA) : ""} value={o.a} onChange={(e) => setOdds("a", e.target.value)} />
                  <input className="ap-input ap-num" style={CELL} inputMode="decimal" aria-label={`${nick(p.b)} odds`} placeholder={m ? fair(1 - m.pA) : ""} value={o.b} onChange={(e) => setOdds("b", e.target.value)} />
                </div>
                <div style={{ fontSize: 11.5, display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 2, minWidth: 0 }}>
                  {m ? (
                    <span className="ap-num" style={{ color: "var(--dim)" }}>
                      fair {nick(p.a)} {fair(m.pA)} · {nick(p.b)} {fair(1 - m.pA)}
                    </span>
                  ) : (
                    <span style={{ color: "var(--dim2)" }}>ingen modell för paret</span>
                  )}
                  {edgeBadge(s)}
                  {s?.price?.edge != null && s.price.edge > 0 && (
                    <button className="ap-btn" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => logBet(s)}>
                      Logga bet
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {pairs.length === 0 && <div style={{ fontSize: 12.5, color: "var(--dim2)" }}>Inga spelare med modell för den här kartan.</div>}
          <button className="ap-btn" disabled={busy || duelReady.length === 0} onClick={saveDuels} style={{ marginTop: 6 }}>
            {busy ? "Sparar…" : `Spara alla (${duelReady.length})`}
          </button>
        </div>
      )}
      {betModal}
    </Card>
  );
}
