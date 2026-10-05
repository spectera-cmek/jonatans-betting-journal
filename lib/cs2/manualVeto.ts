// Kartorna i en match, inmatade för hand — när HLTV:s veto inte är inläst
// än (inläsningen kräver datorn, kartorna syns redan hos boken).
//
// Sparas som vanliga Cs2Veto-rader men med steg från MANUAL_STEP, så de går
// att känna igen och ta bort. Läser cs2:ingest sedan in HLTV:s riktiga veto
// ersätts de helt (applyMatchPage tar bort alla rader för matchen).

import { canonicalMap } from "./maps";
import type { SeriesFormat } from "./types";

/** Manuella vetorader har steg MANUAL_STEP + 1, + 2 … */
export const MANUAL_STEP = 100;

export const MAPS_PER_FORMAT: Record<SeriesFormat, number> = { bo1: 1, bo3: 3, bo5: 5 };

export interface ManualVetoInput {
  mapName: string;
  /** Laget som valde kartan, eller null om okänt. Den sista kartan är decider. */
  pickedBy?: number | null;
}

export interface ManualVetoRow {
  step: number;
  teamId: number | null;
  action: "pick" | "decider";
  mapName: string;
}

export function isManualVetoStep(step: number): boolean {
  return step > MANUAL_STEP;
}

/**
 * Kontrollerar kartorna och gör dem till vetorader. Sista kartan är decider
 * (bo1: den enda). Fel ges som svensk text för formuläret.
 */
export function buildManualVeto(
  format: SeriesFormat,
  maps: ManualVetoInput[],
  teamIds: [number, number]
): { rows: ManualVetoRow[] } | { error: string } {
  const need = MAPS_PER_FORMAT[format];
  if (maps.length !== need) return { error: `${format.toUpperCase()} har ${need} ${need === 1 ? "karta" : "kartor"}.` };
  const names: string[] = [];
  for (const m of maps) {
    const name = canonicalMap(String(m.mapName ?? ""));
    if (!name) return { error: `Okänd karta: ${m.mapName || "(tom)"}` };
    if (names.includes(name)) return { error: "Samma karta kan inte väljas två gånger." };
    names.push(name);
  }
  const rows: ManualVetoRow[] = names.map((mapName, i) => {
    const last = i === names.length - 1;
    const by = maps[i].pickedBy;
    return {
      step: MANUAL_STEP + i + 1,
      teamId: !last && by != null && teamIds.includes(by) ? by : null,
      action: last ? "decider" : "pick",
      mapName,
    };
  });
  return { rows };
}
