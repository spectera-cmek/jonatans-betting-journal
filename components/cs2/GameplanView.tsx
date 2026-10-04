"use client";

/**
 * Docen "GAMEPLAN Analysis Template" för ett lag, en karta och en sida —
 * samma sektioner och rubriker som docen, fyllda ur HLTV och demos. Varje
 * sektion har ett eget anteckningsfält för docens fritext (planer,
 * påminnelser), sparat per lag/karta/sida.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import type { GameplanReport, GameplanSection } from "@/lib/cs2/gameplan";
import { mapLabel } from "@/lib/cs2/maps";
import { Card } from "@/components/ui";
import { Cs2Empty, SampleWindowPicker, SideLegend } from "./common";

interface GameplanResponse {
  dbConfigured: boolean;
  maps: string[];
  report: GameplanReport | null;
  notes: Record<string, { text: string; updatedBy: string | null; updatedAt: string }>;
}

function NoteEditor({
  teamId,
  mapName,
  side,
  section,
  initial,
}: {
  teamId: number;
  mapName: string;
  side: "t" | "ct";
  section: string;
  initial: { text: string; updatedBy: string | null; updatedAt: string } | undefined;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [saved, setSaved] = useState(initial?.text ?? "");
  const [meta, setMeta] = useState(initial ? `${initial.updatedBy ?? ""} · ${new Date(initial.updatedAt).toLocaleDateString("sv-SE")}` : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!!initial?.text);

  useEffect(() => {
    setText(initial?.text ?? "");
    setSaved(initial?.text ?? "");
    setOpen(!!initial?.text);
  }, [initial?.text, teamId, mapName, side, section]);

  const save = async () => {
    if (text === saved) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.put<{ updatedBy?: string; updatedAt?: string }>("/api/cs2/notes", { teamId, mapName, side, section, text });
      setSaved(text);
      setMeta(r.updatedAt ? `${r.updatedBy ?? ""} · ${new Date(r.updatedAt).toLocaleDateString("sv-SE")}` : "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kunde inte spara");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="ap-btn ghost" style={{ marginTop: 10, padding: "5px 10px", fontSize: 11.5 }} onClick={() => setOpen(true)}>
        + Egen anteckning
      </button>
    );
  }
  return (
    <div className="ap-cs2-note">
      <textarea
        value={text}
        placeholder="Egna anteckningar — sparas när du lämnar fältet"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        aria-label="Egen anteckning"
      />
      <div className="ap-cs2-note-meta">
        <span>{busy ? "Sparar…" : err ? <span className="neg">{err}</span> : text !== saved ? "Ej sparat" : meta}</span>
      </div>
    </div>
  );
}

function Section({ s, side, teamId, mapName, note }: { s: GameplanSection; side: "t" | "ct"; teamId: number; mapName: string; note: GameplanResponse["notes"][string] | undefined }) {
  return (
    <section className={`ap-cs2-sec is-${side}`}>
      <h3>{s.title}</h3>
      <div className="ap-cs2-sec-sub">{s.sub}</div>
      {s.items.length > 0 ? (
        <ul className="ap-cs2-items">
          {s.items.map((it, i) => (
            <li key={i} className={`ap-cs2-item ${it.tone ?? ""}`}>
              <span style={{ color: "var(--dim)" }}>{it.label}</span>
              {it.value ? (
                <>
                  {": "}
                  <b>{it.value}</b>
                </>
              ) : null}
              {it.n != null && <span className="ap-cs2-n">n={it.n}</span>}
              {it.detail && it.detail.length > 0 && (
                <ul>
                  {it.detail.map((d, j) => (
                    <li key={j}>{d}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : s.key !== "reminders" ? (
        <div className="ap-cs2-empty">{s.empty ?? "Ingen data."}</div>
      ) : null}
      {s.betting && <div className="ap-cs2-bet">Betting: {s.betting}</div>}
      {s.key !== "sample" && <NoteEditor teamId={teamId} mapName={mapName} side={side} section={s.key} initial={note} />}
    </section>
  );
}

export function GameplanView({
  teamId,
  initialMap,
  opponents = [],
  initialVs = null,
}: {
  teamId: number;
  initialMap?: string | null;
  opponents?: Array<{ id: number; name: string }>;
  initialVs?: number | null;
}) {
  const [map, setMap] = useState<string | null>(initialMap ?? null);
  const [side, setSide] = useState<"t" | "ct">("t");
  const [win, setWin] = useState({ maps: 10, months: 6 });
  const [vs, setVs] = useState<number | null>(initialVs);
  const [data, setData] = useState<GameplanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ side, maps: String(win.maps), months: String(win.months) });
    if (map) qs.set("map", map);
    if (vs) qs.set("vs", String(vs));
    api
      .get<GameplanResponse>(`/api/cs2/teams/${teamId}/gameplan?${qs}`)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        if (!map && r.report) setMap(r.report.mapName);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Kunde inte hämta gameplan"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [teamId, map, side, win.maps, win.months, vs]);

  const report = data?.report ?? null;

  return (
    <div className="ap-cs2">
      <Card>
        <div className="ap-cs2-controls">
          <div className="ap-field">
            <label htmlFor="gp-map">Karta</label>
            <div className="ap-select">
              <select id="gp-map" value={map ?? ""} onChange={(e) => setMap(e.target.value || null)}>
                {(data?.maps ?? (map ? [map] : [])).map((m) => (
                  <option key={m} value={m}>
                    {mapLabel(m)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="ap-field">
            <label>Sida</label>
            <div className="ap-cs2-side" role="group" aria-label="Sida">
              <button type="button" className={`is-t ${side === "t" ? "is-active" : ""}`} onClick={() => setSide("t")}>
                T SIDE
              </button>
              <button type="button" className={`is-ct ${side === "ct" ? "is-active" : ""}`} onClick={() => setSide("ct")}>
                CT SIDE
              </button>
            </div>
          </div>
          <SampleWindowPicker maps={win.maps} months={win.months} onChange={setWin} />
          {opponents.length > 0 && (
            <div className="ap-field">
              <label htmlFor="gp-vs">Motståndare</label>
              <div className="ap-select">
                <select id="gp-vs" value={vs ?? ""} onChange={(e) => setVs(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Ingen</option>
                  {opponents.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </Card>

      {error && <Cs2Empty title="Kunde inte hämta gameplan" hint={error} />}
      {!error && !loading && data && !report && (
        <Cs2Empty title="Laget har inga kartor i perioden" hint="Öka perioden, eller läs in fler matcher med npm run cs2:ingest." />
      )}

      {report && (
        <>
          <div className={`ap-cs2-gp-head is-${side}`}>
            <div>
              <h2>
                {report.mapLabel} · {report.teamName}
                {report.opponentName ? ` vs ${report.opponentName}` : ""}
              </h2>
              <SideLegend />
            </div>
            <span className="ap-cs2-plan">{side === "t" ? "T SIDE PLAN" : "CT SIDE PLAN"}</span>
          </div>
          {report.sample.demoMaps === 0 && (
            <div className="ap-cs2-warn" style={{ marginBottom: 12 }}>
              Ingen demo är tolkad för {report.mapLabel} än — de taktiska sektionerna (positioner, utility, setups, timeouts) fylls
              när du kör <code>npm run cs2:demos -- --confirm --team {teamId}</code>. Resultat och rundor kommer från HLTV redan nu.
            </div>
          )}
          <div className="ap-cs2-gp" style={{ opacity: loading ? 0.55 : 1 }}>
            {report.sections.map((s) => (
              <Section key={`${report.mapName}-${side}-${s.key}`} s={s} side={side} teamId={teamId} mapName={report.mapName} note={data?.notes[s.key]} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
