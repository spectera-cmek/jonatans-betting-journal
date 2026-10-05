// En karta i flera demofiler. Efter en serverkrasch eller omstart delar
// HLTV-arkivet ibland upp kartan i två (eller fler) .dem. Varje del
// normaliseras för sig, med rundnummer från 1; här fogas de ihop till en
// karta: rundorna numreras i följd och tickarna flyttas så att delarna
// inte överlappar.
//
// Vid en återställning spelas den avbrutna rundan om. Den saknar round_end
// och följer därför inte med. Blir det ändå fler rundor än kartan hade
// (återställt till en tidigare runda) är det de sista rundorna i den
// tidigare delen som spelades om — de tas bort.

import type { NormalizedDemo } from "./types";

/** Avstånd mellan delarnas tidslinjer, i tickar. */
const PART_GAP_TICKS = 1_000_000;

function lastTick(d: NormalizedDemo): number {
  let max = 0;
  for (const r of d.rounds) max = Math.max(max, r.endTick);
  for (const k of d.kills) max = Math.max(max, k.tick);
  for (const g of d.grenades) max = Math.max(max, g.landTick, g.throwTick);
  for (const b of d.bombs) max = Math.max(max, b.tick);
  return max;
}

/** Tar bort de `drop` sista rundorna ur en del (de spelades om i nästa del). */
function dropLastRounds(d: NormalizedDemo, drop: number): NormalizedDemo {
  if (drop <= 0) return d;
  const keep = new Set(d.rounds.slice(0, Math.max(0, d.rounds.length - drop)).map((r) => r.n));
  const inKept = (round: number) => keep.has(round);
  return {
    ...d,
    rounds: d.rounds.filter((r) => keep.has(r.n)),
    sides: Object.fromEntries(Object.entries(d.sides).filter(([n]) => keep.has(Number(n)))),
    kills: d.kills.filter((k) => inKept(k.round)),
    grenades: d.grenades.filter((g) => inKept(g.round)),
    samples: d.samples.filter((s) => inKept(s.round)),
    bombs: d.bombs.filter((b) => inKept(b.round)),
    timeouts: d.timeouts.filter((t) => inKept(t.round)),
    utilityDamage: d.utilityDamage.filter((u) => inKept(u.round)),
  };
}

/**
 * Fogar ihop delarna (i spelordning) till en karta. `expectedRounds` är
 * kartans rundor enligt HLTV; överskott tas från slutet av tidigare delar.
 */
export function mergeDemoParts(partsIn: NormalizedDemo[], expectedRounds?: number | null): NormalizedDemo {
  let parts = partsIn.filter((p) => p.rounds.length > 0);
  if (parts.length === 0) return partsIn[0];
  if (parts.length === 1) return parts[0];

  // Överskott: ta bort de sista rundorna i delen före varje omstart, bakifrån.
  const total = parts.reduce((a, p) => a + p.rounds.length, 0);
  let surplus = expectedRounds ? total - expectedRounds : 0;
  for (let i = parts.length - 2; i >= 0 && surplus > 0; i--) {
    const drop = Math.min(surplus, parts[i].rounds.length);
    parts = parts.map((p, j) => (j === i ? dropLastRounds(p, drop) : p));
    surplus -= drop;
  }

  const out: NormalizedDemo = {
    mapName: parts[0].mapName,
    tickrate: parts[0].tickrate,
    players: [],
    rounds: [],
    sides: {},
    kills: [],
    grenades: [],
    samples: [],
    bombs: [],
    timeouts: [],
    utilityDamage: [],
    gridSamples: [],
    missingFields: [],
  };
  const players = new Map<string, NormalizedDemo["players"][number]>();
  const missing = new Set<string>();
  let roundOffset = 0;
  let tickOffset = 0;
  for (const p of parts) {
    // Rundnummer i delen → nummer i den sammanfogade kartan (i följd, utan hål).
    const renum = new Map(p.rounds.map((r, i) => [r.n, roundOffset + i + 1]));
    const R = (n: number) => renum.get(n);
    const T = (t: number) => t + tickOffset;

    for (const r of p.rounds) {
      out.rounds.push({ ...r, n: R(r.n)!, startTick: T(r.startTick), freezeEndTick: T(r.freezeEndTick), endTick: T(r.endTick) });
    }
    for (const [n, s] of Object.entries(p.sides)) {
      const m = R(Number(n));
      if (m != null) out.sides[m] = s;
    }
    for (const k of p.kills) if (R(k.round) != null) out.kills.push({ ...k, round: R(k.round)!, tick: T(k.tick) });
    for (const g of p.grenades)
      if (R(g.round) != null) out.grenades.push({ ...g, round: R(g.round)!, throwTick: T(g.throwTick), landTick: T(g.landTick) });
    for (const s of p.samples) if (R(s.round) != null) out.samples.push({ ...s, round: R(s.round)! });
    for (const b of p.bombs) if (R(b.round) != null) out.bombs.push({ ...b, round: R(b.round)!, tick: T(b.tick) });
    for (const t of p.timeouts) if (R(t.round) != null) out.timeouts.push({ ...t, round: R(t.round)! });
    for (const u of p.utilityDamage) if (R(u.round) != null) out.utilityDamage.push({ ...u, round: R(u.round)! });
    out.gridSamples.push(...p.gridSamples);
    for (const pl of p.players) {
      const prev = players.get(pl.steamId);
      players.set(pl.steamId, prev ? { ...prev, clan: prev.clan ?? pl.clan } : pl);
    }
    for (const f of p.missingFields) missing.add(f);

    roundOffset += p.rounds.length;
    tickOffset = T(lastTick(p)) + PART_GAP_TICKS;
  }
  out.players = [...players.values()];
  out.missingFields = [...missing];
  return out;
}
