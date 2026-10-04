// NormalizedDemo → fakta per lag/sida och spelare/sida.
//
// Lagen i en demo heter här "A" (CT i runda 1) och "B". Kopplingen till
// HLTV-lag och HLTV-spelare görs efteråt (link.ts) — analysen är ren och kan
// testas med syntetiska demos.

import type { RoundEndReason, Side } from "../types";
import {
  DEMO_FACTS_VERSION,
  type BuyType,
  type DemoKill,
  type DemoRound,
  type DemoSample,
  type GrenadeType,
  type NormalizedDemo,
  type PlayerSideFacts,
  type RoundFact,
  type TeamSideFacts,
  type UtilityThrow,
} from "./types";

export type DemoTeam = "A" | "B";
export type PlaceLookup = (x: number, y: number, z: number) => string | null;

export interface DemoAnalysis {
  teamOf: Record<string, DemoTeam>;
  teams: Record<DemoTeam, Record<Side, TeamSideFacts>>;
  players: Array<{ steamId: string; name: string; team: DemoTeam; side: Side; facts: PlayerSideFacts }>;
  /** Rundvinnare per demolag — jämförs med HLTV:s rundhistorik. */
  roundWinners: Array<{ n: number; team: DemoTeam; side: Side }>;
  /** Kills per spelare över hela kartan — jämförs med HLTV:s scoreboard. */
  killTotals: Record<string, number>;
}

/** Ekonomitrösklar på lagets samlade utrustningsvärde vid freeze-end. */
export const ECO_MAX = 5000;
export const FULL_MIN = 20000;

const SETUP_OFFSET = 20;
const EARLY_OFFSET = 12;
const LURK_OFFSET = 35;
const LURK_MIN_DIST = 1500;
const AWP_EARLY_SEC = 12;

const other = (s: Side): Side => (s === "ct" ? "t" : "ct");
const otherTeam = (t: DemoTeam): DemoTeam => (t === "A" ? "B" : "A");

export function buyType(equip: number | null, pistol: boolean): BuyType {
  if (pistol) return "pistol";
  if (equip == null) return "full";
  if (equip < ECO_MAX) return "eco";
  if (equip < FULL_MIN) return "force";
  return "full";
}

/** 0 = första halvlek, 1 = andra, 2+ = övertidens halvlekar (3 rundor var). */
export function halfOf(n: number): number {
  if (n <= 12) return 0;
  if (n <= 24) return 1;
  return 2 + Math.floor((n - 25) / 3);
}

export function isPistolRound(n: number): boolean {
  return n === 1 || n === 13;
}

export function siteOfPlace(place: string | null | undefined): "A" | "B" | null {
  if (!place) return null;
  const p = place.toLowerCase().replace(/[\s_]/g, "");
  if (/bombsitea|^asite|sitea$/.test(p)) return "A";
  if (/bombsiteb|^bsite|siteb$/.test(p)) return "B";
  return null;
}

export function zoneOf(
  place: string | null,
  x: number,
  y: number,
  sites: { A?: [number, number]; B?: [number, number] }
): "A" | "B" | "M" {
  const s = siteOfPlace(place);
  if (s) return s;
  if (sites.A && sites.B) {
    const dA = Math.hypot(x - sites.A[0], y - sites.A[1]);
    const dB = Math.hypot(x - sites.B[0], y - sites.B[1]);
    const near = Math.min(dA, dB);
    const far = Math.max(dA, dB);
    if (far > 0 && near / far < 0.55) return dA < dB ? "A" : "B";
  }
  return "M";
}

/** Rundans slutorsak, härledd ur bomb och överlevande när demon inte säger det. */
export function inferReason(
  round: DemoRound,
  planted: boolean,
  defused: boolean,
  aliveAtEnd: Record<Side, number>
): RoundEndReason {
  if (round.reason !== "unknown") return round.reason;
  if (round.winner === "ct" && defused) return "bomb_defused";
  if (round.winner === "t" && planted) return aliveAtEnd.ct > 0 ? "bomb_exploded" : "elimination";
  if (round.winner === "ct") return aliveAtEnd.t > 0 && !planted ? "time" : "elimination";
  return "elimination";
}

function emptyPlayerFacts(): PlayerSideFacts {
  return {
    v: DEMO_FACTS_VERSION,
    rounds: 0,
    roundsWon: 0,
    kills: 0,
    killsWon: 0,
    killsLost: 0,
    killsOt: 0,
    headshots: 0,
    deaths: 0,
    assists: 0,
    flashAssists: 0,
    awpKills: 0,
    openingAttempts: 0,
    openingKills: 0,
    openingDeaths: 0,
    pistolRounds: 0,
    pistolKills: 0,
    multi: [0, 0, 0, 0],
    clutchAttempts: 0,
    clutchWins: 0,
    util: { smoke: 0, flash: 0, molotov: 0, he: 0, decoy: 0 },
    utilDamage: 0,
    places: {},
    awpKillPlaces: {},
    grenades: {},
    awpRounds: 0,
    awpEarlyKills: 0,
    lurkRounds: 0,
    siteRounds: 0,
    rk: [],
  };
}

const inc = (rec: Record<string, number>, key: string, by = 1) => {
  rec[key] = (rec[key] ?? 0) + by;
};

/** Giltig kill: en spelare dödar en motståndare (inte självmord, inte lagkamrat). */
function isValidKill(k: DemoKill, sides: Record<string, Side> | undefined): boolean {
  if (!k.attacker || k.attacker === k.victim) return false;
  const a = sides?.[k.attacker];
  const v = sides?.[k.victim];
  return !!a && !!v && a !== v;
}

export function analyzeDemo(demo: NormalizedDemo, placeOf: PlaceLookup = () => null): DemoAnalysis {
  const { rounds, sides, tickrate } = demo;

  // 1) Lagtillhörighet: CT i första rundan = A. Sena inhopp avgörs mot en
  //    lagkamrat som redan har lag, i en runda där båda är med.
  const teamOf: Record<string, DemoTeam> = {};
  const first = rounds[0] ? sides[rounds[0].n] ?? {} : {};
  for (const [id, s] of Object.entries(first)) teamOf[id] = s === "ct" ? "A" : "B";
  for (const r of rounds) {
    const rs = sides[r.n] ?? {};
    const ref = Object.entries(rs).find(([id]) => teamOf[id]);
    if (!ref) continue;
    const [refId, refSide] = ref;
    for (const [id, s] of Object.entries(rs)) {
      if (teamOf[id]) continue;
      teamOf[id] = s === refSide ? teamOf[refId] : otherTeam(teamOf[refId]);
    }
  }

  /** Lagets sida i en runda (majoritet bland lagets spelare). */
  const teamSide = (n: number, team: DemoTeam): Side | null => {
    const rs = sides[n] ?? {};
    let ct = 0,
      t = 0;
    for (const [id, s] of Object.entries(rs)) {
      if (teamOf[id] !== team) continue;
      s === "ct" ? ct++ : t++;
    }
    if (ct === 0 && t === 0) return null;
    return ct >= t ? "ct" : "t";
  };

  // Bombplatsernas mittpunkter i den här demon, för zonindelningen.
  const siteSum: Record<"A" | "B", { x: number; y: number; n: number }> = { A: { x: 0, y: 0, n: 0 }, B: { x: 0, y: 0, n: 0 } };
  for (const b of demo.bombs) {
    if (b.kind !== "planted" || !b.site || b.x == null || b.y == null) continue;
    siteSum[b.site].x += b.x;
    siteSum[b.site].y += b.y;
    siteSum[b.site].n += 1;
  }
  const sites: { A?: [number, number]; B?: [number, number] } = {};
  for (const s of ["A", "B"] as const) if (siteSum[s].n > 0) sites[s] = [siteSum[s].x / siteSum[s].n, siteSum[s].y / siteSum[s].n];

  // Index per runda.
  const killsBy = new Map<number, DemoKill[]>();
  for (const k of demo.kills) {
    const list = killsBy.get(k.round);
    if (list) list.push(k);
    else killsBy.set(k.round, [k]);
  }
  const samplesBy = new Map<string, DemoSample[]>();
  for (const s of demo.samples) {
    const key = `${s.round}:${s.offsetSec}`;
    const list = samplesBy.get(key);
    if (list) list.push(s);
    else samplesBy.set(key, [s]);
  }
  const samplesAt = (n: number, off: number) => samplesBy.get(`${n}:${off}`) ?? [];

  const teams: DemoAnalysis["teams"] = {
    A: { ct: { v: DEMO_FACTS_VERSION, rounds: [] }, t: { v: DEMO_FACTS_VERSION, rounds: [] } },
    B: { ct: { v: DEMO_FACTS_VERSION, rounds: [] }, t: { v: DEMO_FACTS_VERSION, rounds: [] } },
  };
  const playerFacts = new Map<string, PlayerSideFacts>();
  const pf = (id: string, side: Side) => {
    const key = `${id}|${side}`;
    let f = playerFacts.get(key);
    if (!f) playerFacts.set(key, (f = emptyPlayerFacts()));
    return f;
  };
  const killTotals: Record<string, number> = {};
  const roundWinners: DemoAnalysis["roundWinners"] = [];

  const score: Record<DemoTeam, number> = { A: 0, B: 0 };
  const lossStreak: Record<DemoTeam, number> = { A: 0, B: 0 };
  const fullBuys: Record<DemoTeam, Record<number, number>> = { A: {}, B: {} };
  const lostRound: Record<DemoTeam, Set<number>> = { A: new Set(), B: new Set() };

  for (const r of rounds) {
    const rs = sides[r.n] ?? {};
    const sideA = teamSide(r.n, "A") ?? "ct";
    const sideOfTeam: Record<DemoTeam, Side> = { A: sideA, B: other(sideA) };
    const winnerTeam: DemoTeam = sideOfTeam.A === r.winner ? "A" : "B";
    roundWinners.push({ n: r.n, team: winnerTeam, side: r.winner });

    const roundKills = (killsBy.get(r.n) ?? []).filter((k) => isValidKill(k, rs));
    const allDeaths = killsBy.get(r.n) ?? [];
    const membersOf = (team: DemoTeam) => Object.keys(rs).filter((id) => teamOf[id] === team);
    const members: Record<DemoTeam, string[]> = { A: membersOf("A"), B: membersOf("B") };
    const deadBy = (team: DemoTeam, untilTick = Infinity) =>
      new Set(allDeaths.filter((k) => k.tick <= untilTick && teamOf[k.victim] === team).map((k) => k.victim));
    const aliveEnd: Record<DemoTeam, number> = {
      A: members.A.length - deadBy("A", r.endTick).size,
      B: members.B.length - deadBy("B", r.endTick).size,
    };

    const bombs = demo.bombs.filter((b) => b.round === r.n);
    const plant = bombs.find((b) => b.kind === "planted") ?? null;
    const defused = bombs.some((b) => b.kind === "defused");
    const reason = inferReason(r, !!plant, defused, {
      [sideOfTeam.A]: aliveEnd.A,
      [sideOfTeam.B]: aliveEnd.B,
    } as Record<Side, number>);

    const fk = roundKills[0] ?? null;
    const sec = (tick: number) => Math.round(((tick - r.freezeEndTick) / tickrate) * 10) / 10;

    const equip: Record<DemoTeam, number | null> = { A: null, B: null };
    for (const s of samplesAt(r.n, 1)) {
      const team = teamOf[s.steamId];
      if (!team || s.equipValue == null) continue;
      equip[team] = (equip[team] ?? 0) + s.equipValue;
    }
    const pistol = isPistolRound(r.n);
    const half = halfOf(r.n);
    const buys: Record<DemoTeam, BuyType> = { A: buyType(equip.A, pistol), B: buyType(equip.B, pistol) };

    // Spelarpositioner vid setup-tiden.
    const setupSamples = samplesAt(r.n, SETUP_OFFSET);
    const lurkSamples = samplesAt(r.n, LURK_OFFSET);

    for (const team of ["A", "B"] as const) {
      const side = sideOfTeam[team];
      const opp = otherTeam(team);
      const won = winnerTeam === team;

      let buyIndex: number | null = null;
      if (buys[team] === "full") {
        fullBuys[team][half] = (fullBuys[team][half] ?? 0) + 1;
        buyIndex = fullBuys[team][half];
      }

      const mine = setupSamples.filter((s) => teamOf[s.steamId] === team);
      const positions: Record<string, string | null> = {};
      const placeCounts: Record<string, number> = {};
      const zone = { A: 0, M: 0, B: 0 };
      for (const s of mine) {
        positions[s.steamId] = s.place;
        if (s.place) inc(placeCounts, s.place);
        zone[zoneOf(s.place, s.x, s.y, sites)]++;
      }
      const setup = Object.keys(placeCounts).length
        ? Object.entries(placeCounts)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([p, n]) => (n > 1 ? `${p}×${n}` : p))
            .join(" ")
        : null;

      // Lurkern: T-spelaren längst från resten av laget vid 35 s.
      let lurker: string | null = null;
      if (side === "t") {
        const alive = lurkSamples.filter((s) => teamOf[s.steamId] === team && s.alive);
        if (alive.length >= 3) {
          let best = { id: "", d: 0 };
          for (const p of alive) {
            const rest = alive.filter((o) => o !== p);
            const cx = rest.reduce((a, o) => a + o.x, 0) / rest.length;
            const cy = rest.reduce((a, o) => a + o.y, 0) / rest.length;
            const d = Math.hypot(p.x - cx, p.y - cy);
            if (d > best.d) best = { id: p.steamId, d };
          }
          if (best.d >= LURK_MIN_DIST) lurker = best.id;
        }
      }

      const utility: UtilityThrow[] = demo.grenades
        .filter((g) => g.round === r.n && g.thrower && teamOf[g.thrower] === team)
        .map((g) => ({ type: g.type, place: placeOf(g.x, g.y, g.z), sec: sec(g.throwTick), thrower: g.thrower }));

      const fact: RoundFact = {
        n: r.n,
        half,
        won,
        reason,
        pistol,
        buy: buys[team],
        oppBuy: buys[opp],
        equip: equip[team] ?? 0,
        oppEquip: equip[opp] ?? 0,
        buyIndex,
        afterLostPistol: (r.n === 2 && lostRound[team].has(1)) || (r.n === 14 && lostRound[team].has(13)),
        afterTimeout: demo.timeouts.some((t) => t.round === r.n && t.side === side),
        oppTimeout: demo.timeouts.some((t) => t.round === r.n && t.side !== side),
        lossStreakBefore: lossStreak[team],
        scoreBefore: [score[team], score[opp]],
        firstKillSec: fk ? sec(fk.tick) : null,
        firstKillBy: fk ? (teamOf[fk.attacker!] === team ? "own" : "opp") : null,
        firstKillPlace: fk ? fk.victimPlace ?? fk.attackerPlace : null,
        openingKiller: fk?.attacker ?? null,
        openingVictim: fk?.victim ?? null,
        plantSite: plant?.site ?? null,
        plantSec: plant ? sec(plant.tick) : null,
        setup,
        zones: mine.length ? `A${zone.A}-M${zone.M}-B${zone.B}` : null,
        positions,
        awpers: mine.filter((s) => s.hasAwp).map((s) => s.steamId),
        lurker,
        utility,
        kills: roundKills.filter((k) => teamOf[k.attacker!] === team).length,
        deaths: allDeaths.filter((k) => teamOf[k.victim] === team).length,
        aliveAtEnd: Math.max(0, aliveEnd[team]),
      };
      teams[team][side].rounds.push(fact);
    }

    // Clutchar: följ levande spelare kill för kill fram till rundslut.
    const alive: Record<DemoTeam, Set<string>> = { A: new Set(members.A), B: new Set(members.B) };
    const clutch: Partial<Record<DemoTeam, string>> = {};
    for (const k of allDeaths) {
      if (k.tick > r.endTick) break;
      const vt = teamOf[k.victim];
      if (!vt) continue;
      alive[vt].delete(k.victim);
      for (const team of ["A", "B"] as const) {
        if (clutch[team] || alive[team].size !== 1 || alive[otherTeam(team)].size < 1) continue;
        clutch[team] = [...alive[team]][0];
      }
    }

    // Spelarfakta för rundan.
    const earlyAwp = new Set<string>();
    for (const s of samplesAt(r.n, EARLY_OFFSET)) if (s.hasAwp) earlyAwp.add(s.steamId);
    for (const [id, side] of Object.entries(rs)) {
      const team = teamOf[id];
      if (!team) continue;
      const f = pf(id, side);
      const won = winnerTeam === team;
      f.rounds++;
      if (won) f.roundsWon++;
      const mineKills = roundKills.filter((k) => k.attacker === id);
      const n = mineKills.length;
      killTotals[id] = (killTotals[id] ?? 0) + n;
      f.kills += n;
      if (won) f.killsWon += n;
      else f.killsLost += n;
      if (r.n > 24) f.killsOt += n;
      f.rk.push(n);
      if (n >= 2) f.multi[Math.min(n, 5) - 2]++;
      for (const k of mineKills) {
        if (k.headshot) f.headshots++;
        if (k.weapon === "awp") {
          f.awpKills++;
          inc(f.awpKillPlaces, k.attackerPlace ?? "okänt");
          if (sec(k.tick) <= AWP_EARLY_SEC) f.awpEarlyKills++;
        }
      }
      f.deaths += allDeaths.filter((k) => k.victim === id).length;
      for (const k of roundKills) {
        if (k.assister !== id) continue;
        f.assists++;
        if (k.flashAssist) f.flashAssists++;
      }
      if (fk && (fk.attacker === id || fk.victim === id)) {
        f.openingAttempts++;
        if (fk.attacker === id) f.openingKills++;
        else f.openingDeaths++;
      }
      if (isPistolRound(r.n)) {
        f.pistolRounds++;
        f.pistolKills += n;
      }
      if (clutch[team] === id) {
        f.clutchAttempts++;
        if (won) f.clutchWins++;
      }
      for (const g of demo.grenades) {
        if (g.round !== r.n || g.thrower !== id) continue;
        f.util[g.type as GrenadeType]++;
        if (g.type !== "decoy") inc(f.grenades, `${g.type}@${placeOf(g.x, g.y, g.z) ?? "okänt"}`);
      }
      for (const d of demo.utilityDamage) if (d.round === r.n && d.attacker === id) f.utilDamage += d.damage;
      const setupSample = setupSamples.find((s) => s.steamId === id);
      if (setupSample?.place) {
        inc(f.places, setupSample.place);
        if (side === "ct" && siteOfPlace(setupSample.place)) f.siteRounds++;
      }
      if (setupSample?.hasAwp || earlyAwp.has(id)) f.awpRounds++;
      const tf = teams[team][side].rounds[teams[team][side].rounds.length - 1];
      if (tf?.lurker === id) f.lurkRounds++;
    }

    score[winnerTeam]++;
    lossStreak[winnerTeam] = 0;
    lossStreak[otherTeam(winnerTeam)]++;
    lostRound[otherTeam(winnerTeam)].add(r.n);
  }

  const names = new Map(demo.players.map((p) => [p.steamId, p.name]));
  const players: DemoAnalysis["players"] = [];
  for (const [key, facts] of playerFacts) {
    const [steamId, side] = key.split("|") as [string, Side];
    const team = teamOf[steamId];
    if (!team) continue;
    players.push({ steamId, name: names.get(steamId) ?? steamId, team, side, facts });
  }

  return { teamOf, teams, players, roundWinners, killTotals };
}
