"use client";

// Kartorna för hand, för när HLTV:s veto inte är inläst än men boken redan
// visar dem. Modellen räknar då med de riktiga kartorna i stället för
// vetosannolikheter. HLTV:s veto ersätter det vid nästa cs2:ingest.

import { useState } from "react";
import { Card } from "@/components/ui";
import { IC, I } from "@/components/icons";
import { api } from "@/lib/fetcher";
import { mapLabel } from "@/lib/cs2/maps";
import type { MatchupView } from "@/lib/cs2/matchup";

const COUNT = { bo1: 1, bo3: 3, bo5: 5 } as const;

export function ManualVeto({ v, onSaved }: { v: MatchupView; onSaved: () => void }) {
  const n = COUNT[v.match.format] ?? 3;
  const [open, setOpen] = useState(false);
  const [maps, setMaps] = useState<string[]>(() => (v.vetoManual ? v.vetoMaps : Array(n).fill("")).slice(0, n));
  const [picks, setPicks] = useState<string[]>(() => Array(n).fill(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // HLTV:s veto är inläst — inget att mata in.
  if (v.vetoKnown && !v.vetoManual) return null;

  const label = (i: number) => (i === n - 1 ? (n === 1 ? "Karta" : "Decider") : `Karta ${i + 1}`);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/cs2/matches/${v.match.id}/veto`, {
        maps: maps.map((m, i) => ({ mapName: m, pickedBy: picks[i] ? Number(picks[i]) : null })),
      });
      setOpen(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte spara");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/cs2/matches/${v.match.id}/veto`);
      setMaps(Array(n).fill(""));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte ta bort");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <b>Kartor</b>{" "}
          <span style={{ color: "var(--dim)", fontSize: 12.5 }}>
            {v.vetoManual
              ? `inmatade för hand: ${v.vetoMaps.map(mapLabel).join(" → ")}`
              : "vetot är inte inläst — modellen räknar med sannolikheter. Vet du kartorna? Lägg in dem."}
          </span>
        </div>
        {!open && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ap-btn ghost" disabled={busy} onClick={() => setOpen(true)}>
              <I p={IC.edit} size={14} /> {v.vetoManual ? "Ändra" : "Lägg in kartor"}
            </button>
            {v.vetoManual && (
              <button className="ap-btn ghost" disabled={busy} onClick={remove}>
                Ta bort kartorna
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
              <div className="ap-field">
                <label htmlFor={`mv-map-${i}`}>{label(i)}</label>
                <div className="ap-select">
                  <select
                    id={`mv-map-${i}`}
                    value={maps[i] ?? ""}
                    onChange={(e) => setMaps((m) => m.map((x, j) => (j === i ? e.target.value : x)))}
                  >
                    <option value="">Välj karta</option>
                    {v.pool.map((m) => (
                      <option key={m} value={m}>
                        {mapLabel(m)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {i < n - 1 ? (
                <div className="ap-field">
                  <label htmlFor={`mv-pick-${i}`}>Valdes av</label>
                  <div className="ap-select">
                    <select id={`mv-pick-${i}`} value={picks[i] ?? ""} onChange={(e) => setPicks((p) => p.map((x, j) => (j === i ? e.target.value : x)))}>
                      <option value="">Vet inte</option>
                      <option value={v.team1.id}>{v.team1.name}</option>
                      <option value={v.team2.id}>{v.team2.name}</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div style={{ alignSelf: "end", fontSize: 12, color: "var(--dim2)", paddingBottom: 10 }}>
                  {n === 1 ? "" : "spelas om det står 1–1"}
                </div>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ap-btn" disabled={busy || maps.some((m) => !m)} onClick={save}>
              {busy ? "Sparar…" : "Spara kartorna"}
            </button>
            <button className="ap-btn ghost" disabled={busy} onClick={() => setOpen(false)}>
              Avbryt
            </button>
          </div>
        </div>
      )}
      {error && <div style={{ marginTop: 8, color: "var(--neg, #ef4444)", fontSize: 12.5 }}>{error}</div>}
    </Card>
  );
}
