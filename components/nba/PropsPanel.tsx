"use client";

// Spelarprops på matchsidan: en rad per spelare och statistik med modellens
// projektion och bästa linjen, och vid klick fördelningen över simulerade
// kvällar, alla böckers priser och ett fält för ditt eget bolags linje.

import { useMemo, useState } from "react";
import { Card } from "@/components/ui";
import { api } from "@/lib/fetcher";
import type { PlayerPropView, PropQuote } from "@/lib/nba/propsPipeline";
import { PROP_LABEL, type PropStat } from "@/lib/nba/props";
import { dec, pct } from "./common";

const STATS: PropStat[] = ["pts", "reb", "ast", "fg3", "pra"];
const num = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));

/** Utjämnad fördelning (Gauss-kärna) så att kurvan blir läsbar även för små tal. */
function smooth(hist: number[], bw: number): number[] {
  const out = new Array<number>(hist.length).fill(0);
  for (let i = 0; i < hist.length; i++) {
    let s = 0;
    let w = 0;
    for (let j = Math.max(0, i - 4 * Math.ceil(bw)); j <= Math.min(hist.length - 1, i + 4 * Math.ceil(bw)); j++) {
      const k = Math.exp(-((i - j) ** 2) / (2 * bw * bw));
      s += k * hist[j];
      w += k;
    }
    out[i] = s / w;
  }
  return out;
}

function Distribution({ hist, mean, line }: { hist: number[]; mean: number; line: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const W = 600;
  const H = 150;
  const padB = 22;
  const lo = 0;
  // Axeln slutar där 99,5 % av kvällarna ryms — enstaka extremkvällar trycker annars ihop kurvan.
  let cum = 0;
  let q995 = hist.length - 1;
  for (let i = 0; i < hist.length; i++) {
    cum += hist[i];
    if (cum >= 0.995 * total) {
      q995 = i;
      break;
    }
  }
  const hi = Math.max(q995 + 1, Math.ceil((line ?? 0) + 3), 4);
  const bw = hi > 25 ? 1.6 : hi > 10 ? 0.9 : 0.55;
  const ys = smooth(hist.concat(new Array(Math.max(0, hi + 1 - hist.length)).fill(0)), bw).slice(0, hi + 1);
  const maxY = Math.max(...ys) || 1;
  const x = (v: number) => ((v - lo) / (hi - lo || 1)) * (W - 20) + 10;
  const y = (v: number) => H - padB - (v / maxY) * (H - padB - 18);
  const pts = ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = (from: number, to: number) => {
    const idx = ys.map((_, i) => i).filter((i) => i >= from && i <= to);
    if (!idx.length) return "";
    return `M${x(idx[0])},${H - padB} L${idx.map((i) => pts[i]).join(" L")} L${x(idx[idx.length - 1])},${H - padB} Z`;
  };
  const cut = line == null ? null : Math.floor(line);
  const over = line == null ? null : hist.reduce((a, c, i) => (i > line ? a + c : a), 0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(lo + f * (hi - lo)));
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", maxHeight: 180 }}
        role="img"
        aria-label={`Fördelning över simulerade kvällar, snitt ${num(mean)}${line != null ? `, linje ${line}` : ""}`}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const v = Math.round(((e.clientX - r.left) / r.width) * W);
          const val = Math.round(((v - 10) / (W - 20)) * (hi - lo) + lo);
          setHover(val >= 0 && val <= hi ? val : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={10} x2={W - 10} y1={H - padB} y2={H - padB} stroke="var(--line, rgba(127,127,127,.3))" strokeWidth={1} />
        {cut == null ? (
          <path d={area(0, hi)} fill="var(--acc)" fillOpacity={0.18} />
        ) : (
          <>
            <path d={area(0, cut)} fill="var(--dim2)" fillOpacity={0.14} />
            <path d={area(cut + 1, hi)} fill="var(--acc)" fillOpacity={0.22} />
          </>
        )}
        <polyline points={pts.join(" ")} fill="none" stroke="var(--dim)" strokeWidth={2} strokeLinejoin="round" />
        {line != null && (
          <>
            <line x1={x(line)} x2={x(line)} y1={10} y2={H - padB} stroke="var(--text, currentColor)" strokeWidth={2} />
            <text x={x(line)} y={9} textAnchor="middle" fontSize={11} fill="var(--text, currentColor)">
              {String(line).replace(".", ",")}
            </text>
          </>
        )}
        <line x1={x(mean)} x2={x(mean)} y1={22} y2={H - padB} stroke="var(--acc)" strokeWidth={2} strokeDasharray="4 4" />
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--dim2)">
            {t}
          </text>
        ))}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={10} y2={H - padB} stroke="var(--dim2)" strokeWidth={1} strokeOpacity={0.6} />
        )}
      </svg>
      <div style={{ fontSize: 12, color: "var(--dim)", minHeight: 18 }}>
        {hover != null ? (
          <>
            <b className="ap-num">{hist[hover] ?? 0}</b> av {total} kvällar exakt {hover} · {pct((hist.slice(hover + 1).reduce((a, b) => a + b, 0)) / total, 0)} över {hover}
          </>
        ) : over != null ? (
          <>
            <b className="ap-num">{over}</b> av {total} simulerade kvällar över {String(line).replace(".", ",")} · streckat = modellens snitt
          </>
        ) : (
          <>Streckat = modellens snitt. Lägg till en linje nedan för att se över/under.</>
        )}
      </div>
    </div>
  );
}

function sideText(q: PropQuote) {
  return q.bestSide === "over" ? "Över" : q.bestSide === "under" ? "Under" : "—";
}

function AddPropLine({ gameId, playerId, stat, onSaved }: { gameId: number; playerId: number; stat: PropStat; onSaved: () => void }) {
  const [book, setBook] = useState("");
  const [line, setLine] = useState("");
  const [over, setOver] = useState("");
  const [under, setUnder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/nba/props", { gameId, playerId, stat, book, line, over, under });
      setOver("");
      setUnder("");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kunde inte spara");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ap-nba-form" style={{ padding: "10px 0 0" }}>
      <div className="ap-field">
        <label>Bolag</label>
        <input className="ap-input" value={book} onChange={(e) => setBook(e.target.value)} placeholder="t.ex. Unibet" />
      </div>
      <div className="ap-field">
        <label>Linje</label>
        <input className="ap-input" inputMode="decimal" value={line} onChange={(e) => setLine(e.target.value)} placeholder="22,5" />
      </div>
      <div className="ap-field">
        <label>Över</label>
        <input className="ap-input" inputMode="decimal" value={over} onChange={(e) => setOver(e.target.value)} placeholder="1,87" />
      </div>
      <div className="ap-field">
        <label>Under</label>
        <input className="ap-input" inputMode="decimal" value={under} onChange={(e) => setUnder(e.target.value)} placeholder="1,87" />
      </div>
      <button className="ap-btn" disabled={busy} onClick={save}>
        Lägg till
      </button>
      {err && <span style={{ color: "var(--red)", fontSize: 12 }}>{err}</span>}
    </div>
  );
}

export function PropsPanel({
  gameId,
  props,
  teamAbbr,
  editable,
  onChanged,
}: {
  gameId: number;
  props: PlayerPropView[];
  teamAbbr: Map<number, string>;
  editable: boolean;
  onChanged: () => void;
}) {
  const [stat, setStat] = useState<PropStat>("pts");
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(
    () =>
      props
        .filter((p) => p.stats[stat])
        .sort((a, b) => {
          const ea = a.stats[stat]?.best?.edge ?? -9;
          const eb = b.stats[stat]?.best?.edge ?? -9;
          return eb - ea || (b.stats[stat]?.mean ?? 0) - (a.stats[stat]?.mean ?? 0);
        }),
    [props, stat]
  );
  const del = async (id: number) => {
    await api.del(`/api/nba/props?id=${id}`).catch(() => null);
    onChanged();
  };
  const GRID = "1.6fr 60px 70px 1.3fr 90px 24px";
  return (
    <Card style={{ padding: 0, marginBottom: 16 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">Spelarprops</span>
        <span style={{ fontSize: 11.5, color: "var(--dim2)" }}>5 000 simulerade kvällar per spelare · modellen väger 15 % mot linjen</span>
      </div>
      <div style={{ padding: "10px 16px 0" }}>
        <div className="ap-seg">
          {STATS.map((s) => (
            <button key={s} className={stat === s ? "is-active" : ""} onClick={() => setStat(s)}>
              {PROP_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="ap-nba-scroll">
        <div className="ap-table" style={{ minWidth: 600 }}>
          <div className="ap-thead" style={{ gridTemplateColumns: GRID }}>
            <span>Spelare</span>
            <span className="ap-r">Min</span>
            <span className="ap-r">Modell</span>
            <span>Bästa linje</span>
            <span className="ap-r">Edge</span>
            <span />
          </div>
          {rows.length === 0 && (
            <div className="ap-trow" style={{ gridTemplateColumns: "1fr", color: "var(--dim2)" }}>
              Inga spelare med minst 8 minuter.
            </div>
          )}
          {rows.map((p) => {
            const s = p.stats[stat]!;
            const b = s.best;
            const isOpen = open === p.playerId;
            return (
              <div key={p.playerId}>
                <button
                  type="button"
                  className={`ap-trow${b?.flagged ? " ap-nba-flag" : ""}`}
                  style={{ gridTemplateColumns: GRID, width: "100%", textAlign: "left", background: "none", border: 0, font: "inherit", color: "inherit", cursor: "pointer" }}
                  onClick={() => setOpen(isOpen ? null : p.playerId)}
                  aria-expanded={isOpen}
                >
                  <span className="ap-ell">
                    <b>{p.name}</b> <span style={{ color: "var(--dim2)", fontSize: 11 }}>{teamAbbr.get(p.teamId)}</span>
                    {s.quotes.length > 0 && <span style={{ color: "var(--dim2)", fontSize: 11 }}> · {s.quotes.length} bk</span>}
                  </span>
                  <span className="ap-r ap-num">{num(p.minutes, 0)}</span>
                  <span className="ap-r ap-num">
                    <b>{num(s.mean)}</b>
                  </span>
                  <span className="ap-num ap-ell">
                    {b ? (
                      <>
                        {sideText(b)} {String(b.line).replace(".", ",")} @ {dec(b.bestSide === "under" ? b.under : b.over)}
                        <span style={{ color: "var(--dim2)" }}> {b.book}</span>
                      </>
                    ) : (
                      <span style={{ color: "var(--dim2)" }}>
                        {num(s.q10, 0)}–{num(s.q90, 0)} (80 %)
                      </span>
                    )}
                  </span>
                  <span className={`ap-r ap-num ${b?.edge == null ? "" : b.edge >= 0 ? "pos" : "neg"}`}>{b?.edge == null ? "—" : `${(b.edge * 100).toFixed(1)} %`}</span>
                  <span style={{ color: "var(--dim2)" }}>{isOpen ? "▾" : "›"}</span>
                </button>
                {isOpen && (
                  <div style={{ padding: "8px 16px 16px", borderBottom: "1px solid var(--line, rgba(127,127,127,.18))" }}>
                    <Distribution hist={s.hist} mean={s.mean} line={b?.line ?? null} />
                    {s.quotes.length > 0 && (
                      <div className="ap-table" style={{ marginTop: 8 }}>
                        <div className="ap-thead" style={{ gridTemplateColumns: "1.2fr 70px 70px 70px 1fr 1fr 60px" }}>
                          <span>Bolag</span>
                          <span className="ap-r">Linje</span>
                          <span className="ap-r">Över</span>
                          <span className="ap-r">Under</span>
                          <span className="ap-r">Modell · marknad</span>
                          <span className="ap-r">Edge</span>
                          <span />
                        </div>
                        {s.quotes.map((q) => (
                          <div key={q.id} className={`ap-trow${q.flagged ? " ap-nba-flag" : ""}`} style={{ gridTemplateColumns: "1.2fr 70px 70px 70px 1fr 1fr 60px" }}>
                            <span className="ap-ell">
                              {q.book}
                              <span style={{ color: "var(--dim2)", fontSize: 11 }}> · {q.source === "manual" ? "eget" : q.source}</span>
                            </span>
                            <span className="ap-r ap-num">{String(q.line).replace(".", ",")}</span>
                            <span className="ap-r ap-num">{dec(q.over)}</span>
                            <span className="ap-r ap-num">{dec(q.under)}</span>
                            <span className="ap-r ap-num">
                              {pct(q.pModel, 0)} · {q.pMarket == null ? "—" : pct(q.pMarket, 0)}
                            </span>
                            <span className={`ap-r ap-num ${q.edge == null ? "" : q.edge >= 0 ? "pos" : "neg"}`}>
                              {q.edge == null ? "—" : `${(q.edge * 100).toFixed(1)} % ${sideText(q)}`}
                            </span>
                            <span className="ap-r">
                              {q.source === "manual" && (
                                <button className="ap-btn ghost" style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => del(q.id)}>
                                  Ta bort
                                </button>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: "var(--dim2)", marginTop: 8 }}>
                      Modellens P(över) vägs 15 % mot linjens pris efter att marginalen räknats bort — linjen bär resten. Spelare som inte spelar blir void.
                    </div>
                    {editable && <AddPropLine gameId={gameId} playerId={p.playerId} stat={stat} onSaved={onChanged} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
