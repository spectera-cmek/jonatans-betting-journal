// Koordinat → callout ("BombsiteA", "TopofMid", "Banana" …) per karta.
//
// Spelarnas `last_place_name` finns i varje demo, men en granats landnings-
// punkt har bara koordinater. Rutnätet byggs ur spelarnas positioner: varje
// cell minns vilken callout spelare oftast stått i där. En granat som landar
// i en cell får cellens callout; i en tom cell används närmaste kända cell.
// Inga handritade kartor behövs, och nya kartor fungerar direkt.

export const GRID_CELL = 96; // världsenheter i x/y
export const GRID_Z = 160; // höjdband — skiljer t.ex. övre och undre Nuke

/** cellnyckel → [callout, antal observationer] */
export type GridCells = Record<string, [string, number]>;

export function cellKey(x: number, y: number, z: number, cell = GRID_CELL, zBand = GRID_Z): string {
  return `${Math.floor(x / cell)}:${Math.floor(y / cell)}:${Math.floor(z / zBand)}`;
}

/** Lägger till observationer i ett rutnät (muterar inte indata). */
export function addToGrid(cells: GridCells, samples: Array<[number, number, number, string]>): GridCells {
  // Räkna per cell och callout, och slå sedan ihop med befintliga celler.
  const tally = new Map<string, Map<string, number>>();
  for (const [key, [place, n]] of Object.entries(cells)) tally.set(key, new Map([[place, n]]));
  for (const [x, y, z, place] of samples) {
    const key = cellKey(x, y, z);
    let m = tally.get(key);
    if (!m) tally.set(key, (m = new Map()));
    m.set(place, (m.get(place) ?? 0) + 1);
  }
  const out: GridCells = {};
  for (const [key, m] of tally) {
    let best: [string, number] | null = null;
    let total = 0;
    for (const [place, n] of m) {
      total += n;
      if (!best || n > best[1]) best = [place, n];
    }
    // Antalet är cellens totala stöd; callouten är den vanligaste.
    if (best) out[key] = [best[0], total];
  }
  return out;
}

/**
 * Callout för en punkt: exakt cell, annars närmaste cell inom `radius` celler
 * i samma eller angränsande höjdband. null när inget finns i närheten.
 */
export function placeAt(cells: GridCells, x: number, y: number, z: number, radius = 4): string | null {
  const cx = Math.floor(x / GRID_CELL);
  const cy = Math.floor(y / GRID_CELL);
  const cz = Math.floor(z / GRID_Z);
  const exact = cells[`${cx}:${cy}:${cz}`];
  if (exact) return exact[0];
  let best: { place: string; d: number } | null = null;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const c = cells[`${cx + dx}:${cy + dy}:${cz + dz}`];
        if (!c) continue;
        // Höjdbandsbyte straffas — en granat på övre plan ska inte få undre planets namn.
        const d = dx * dx + dy * dy + dz * dz * 4;
        if (!best || d < best.d) best = { place: c[0], d };
      }
    }
  }
  return best?.place ?? null;
}

/** Läsbar callout: "TopofMid" → "Top of Mid", "BombsiteA" → "A-site". */
export function prettyPlace(place: string | null | undefined): string {
  if (!place) return "okänt";
  const p = place.trim();
  const site = p.match(/^Bombsite\s*([AB])$/i);
  if (site) return `${site[1].toUpperCase()}-site`;
  return p
    .replace(/([a-z])of([A-Z])/g, "$1 of $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}
