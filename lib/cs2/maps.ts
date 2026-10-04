// Kartnamn. HLTV skriver "Dust2", "Dust II" eller "d2" beroende på sida,
// demon säger "de_dust2" — allt lagras som en kanonisk nyckel.
//
// Kartpoolen hårdkodas INTE: Valve byter kartor i Active Duty, och en
// hårdkodad lista blir tyst fel. `activeMapPool` härleder den ur veton.

export interface MapInfo {
  key: string;
  label: string;
}

const KNOWN: MapInfo[] = [
  { key: "ancient", label: "Ancient" },
  { key: "anubis", label: "Anubis" },
  { key: "dust2", label: "Dust2" },
  { key: "inferno", label: "Inferno" },
  { key: "mirage", label: "Mirage" },
  { key: "nuke", label: "Nuke" },
  { key: "overpass", label: "Overpass" },
  { key: "train", label: "Train" },
  { key: "vertigo", label: "Vertigo" },
  { key: "cache", label: "Cache" },
  { key: "cobblestone", label: "Cobblestone" },
];

/** HLTV:s förkortningar i statistiklistor. */
const ALIASES: Record<string, string> = {
  anc: "ancient",
  anb: "anubis",
  anu: "anubis",
  d2: "dust2",
  "dust ii": "dust2",
  "dust 2": "dust2",
  inf: "inferno",
  mrg: "mirage",
  mir: "mirage",
  nuk: "nuke",
  ovp: "overpass",
  ovr: "overpass",
  trn: "train",
  vtg: "vertigo",
  ver: "vertigo",
  cch: "cache",
  cbl: "cobblestone",
};

/**
 * Kanonisk kartnyckel. Okända kartor behåller sitt (normaliserade) namn i
 * stället för att kastas — en ny Active Duty-karta ska synas, inte försvinna.
 */
export function canonicalMap(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s || s === "tba" || s === "default" || s === "-") return null;
  s = s.replace(/^(de|cs)_/, "").replace(/\s+/g, " ");
  if (ALIASES[s]) return ALIASES[s];
  const compact = s.replace(/[\s_-]+/g, "");
  if (ALIASES[compact]) return ALIASES[compact];
  const known = KNOWN.find((m) => m.key === compact);
  return known ? known.key : compact;
}

export function mapLabel(key: string): string {
  const known = KNOWN.find((m) => m.key === key);
  if (known) return known.label;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Aktiv kartpool: kartor som förekommit i minst `minAppearances` veton eller
 * spelade kartor sedan `since`. Sorterad efter förekomst, vanligast först.
 */
export function activeMapPool(
  appearances: Array<{ mapName: string; at: Date }>,
  since: Date,
  minAppearances = 3
): string[] {
  const counts = new Map<string, number>();
  for (const a of appearances) {
    if (a.at < since) continue;
    counts.set(a.mapName, (counts.get(a.mapName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minAppearances)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}
