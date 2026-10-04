// demoparser2 → NormalizedDemo.
//
// Två delar:
//  - readRawDemo: anropar @laihoe/demoparser2 (native modul, bara lokalt).
//    Modulen laddas dynamiskt, så resten av appen bygger även där den saknas.
//  - normalizeRaw: ren funktion från otypade rader till NormalizedDemo.
//    demoparser2:s fältnamn har skiftat mellan versioner, så varje fält läses
//    via en lista kandidatnamn, och det som saknas rapporteras i
//    `missingFields` i stället för att tyst bli fel.

import type { RoundEndReason, Side } from "../types";
import { canonicalMap } from "../maps";
import {
  DEFAULT_TICKRATE,
  type DemoBomb,
  type DemoGrenade,
  type DemoKill,
  type DemoRound,
  type DemoSample,
  type GrenadeType,
  type NormalizedDemo,
  type RawDemo,
  type RawRow,
} from "./types";

/** Provtiderna efter freeze-end: utrustning (1 s), tidigt (12 s), setup (20 s), lurk (35 s). */
export const SAMPLE_OFFSETS_SEC = [1, 12, 20, 35] as const;

const EVENTS = [
  "round_start",
  "round_freeze_end",
  "round_end",
  "round_announce_match_start",
  "player_death",
  "bomb_planted",
  "bomb_defused",
  "player_hurt",
];

const SAMPLE_PROPS = ["X", "Y", "Z", "last_place_name", "team_num", "is_alive", "current_equip_value", "inventory", "team_clan_name"];
const TIMEOUT_PROPS = ["is_terrorist_timeout", "is_ct_timeout"];
const GRID_PROPS = ["X", "Y", "Z", "last_place_name", "is_alive"];

// ---------------------------------------------------------------------------
// Små läshjälpare
// ---------------------------------------------------------------------------

function pick(row: RawRow, keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(true|1|yes)$/i.test(v.trim());
  return false;
}

/** team_num 2/3, "T"/"CT", "TERRORIST" → sida. */
export function normSide(v: unknown): Side | null {
  if (typeof v === "number") return v === 3 ? "ct" : v === 2 ? "t" : null;
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "3" || s === "CT" || s === "COUNTER-TERRORIST" || s === "COUNTERTERRORIST") return "ct";
  if (s === "2" || s === "T" || s === "TERRORIST" || s === "TERRORISTS") return "t";
  return null;
}

/**
 * round_end.reason som sträng. Numeriska koder lämnas som "unknown": enumen
 * har varit både 0- och 1-baserad mellan spelversioner, och analysen härleder
 * orsaken säkrare ur bombhändelser och kills (se inferReason i analyze.ts).
 */
export function normReason(v: unknown): RoundEndReason {
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()))) return "unknown";
  const s = String(v ?? "").toLowerCase();
  if (/bomb(ed)?_?explo|target_?bombed|bombed/.test(s)) return "bomb_exploded";
  if (/defus/.test(s)) return "bomb_defused";
  if (/saved|time|target_saved/.test(s)) return "time";
  if (/killed|elim|win/.test(s)) return "elimination";
  return "unknown";
}

export function normGrenadeType(v: unknown): GrenadeType | null {
  const s = String(v ?? "").toLowerCase();
  if (/smoke/.test(s)) return "smoke";
  if (/flash/.test(s)) return "flash";
  if (/molo|incen|inferno|fire/.test(s)) return "molotov";
  if (/decoy/.test(s)) return "decoy";
  if (/\bhe\b|hegrenade|he_?grenade|frag|explosive/.test(s)) return "he";
  return null;
}

export function normWeapon(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/^weapon_/, "")
    .trim();
}

const UTILITY_WEAPONS = new Set(["hegrenade", "inferno", "molotov", "incgrenade"]);

// ---------------------------------------------------------------------------
// Rundor
// ---------------------------------------------------------------------------

/**
 * Bygger matchens rundor ur round_end/round_freeze_end/round_start.
 *
 * Uppvärmning och knivrunda sorteras bort på två sätt: allt före den sista
 * `round_announce_match_start` ignoreras, och om HLTV:s slutresultat är känt
 * (`expectedRounds`) behålls bara så många sista rundor.
 */
export function buildRounds(events: RawRow[], expectedRounds?: number | null): DemoRound[] {
  const byName = (name: string) =>
    events
      .filter((e) => e.event_name === name)
      .map((e) => ({ e, tick: num(e.tick) ?? -1 }))
      .filter((x) => x.tick >= 0)
      .sort((a, b) => a.tick - b.tick);

  const starts = byName("round_announce_match_start");
  const matchStart = starts.length ? starts[starts.length - 1].tick : -1;

  let ends = byName("round_end").filter(({ e, tick }) => {
    if (tick <= matchStart) return false;
    if (bool(pick(e, ["is_warmup_period"]))) return false;
    return normSide(pick(e, ["winner", "winner_side", "winner_team"])) !== null;
  });
  // Dubbla round_end på samma tick förekommer — behåll en.
  ends = ends.filter((x, i) => i === 0 || x.tick !== ends[i - 1].tick);
  if (expectedRounds && ends.length > expectedRounds) ends = ends.slice(ends.length - expectedRounds);

  const freezeEnds = byName("round_freeze_end").map((x) => x.tick);
  const roundStarts = byName("round_start").map((x) => x.tick);

  const rounds: DemoRound[] = [];
  for (let i = 0; i < ends.length; i++) {
    const endTick = ends[i].tick;
    const prevEnd = i > 0 ? ends[i - 1].tick : Math.max(matchStart, 0);
    const fe = freezeEnds.filter((t) => t > prevEnd && t < endTick);
    const freezeEndTick = fe.length ? fe[fe.length - 1] : prevEnd;
    const rs = roundStarts.filter((t) => t > prevEnd && t <= freezeEndTick);
    const startTick = rs.length ? rs[rs.length - 1] : prevEnd;
    rounds.push({
      n: i + 1,
      startTick,
      freezeEndTick,
      endTick,
      winner: normSide(pick(ends[i].e, ["winner", "winner_side", "winner_team"]))!,
      reason: normReason(pick(ends[i].e, ["reason", "round_end_reason"])),
    });
  }
  return rounds;
}

/** Rundan en tick hör till: från rundans start till nästa rundas start. */
export function roundIndexer(rounds: DemoRound[], tailTicks = 10 * DEFAULT_TICKRATE): (tick: number) => number | null {
  return (tick: number) => {
    for (let i = 0; i < rounds.length; i++) {
      const from = rounds[i].startTick;
      const to = i + 1 < rounds.length ? rounds[i + 1].startTick : rounds[i].endTick + tailTicks;
      if (tick >= from && tick < to) return rounds[i].n;
    }
    return null;
  };
}

/** Provtickarna per runda — tidpunkter efter rundslut hoppas över. */
export function sampleTicksFor(rounds: DemoRound[], tickrate = DEFAULT_TICKRATE): RawDemo["sampleTicks"] {
  const out: RawDemo["sampleTicks"] = [];
  for (const r of rounds) {
    for (const off of SAMPLE_OFFSETS_SEC) {
      const tick = r.freezeEndTick + Math.round(off * tickrate);
      if (tick < r.endTick) out.push({ round: r.n, offsetSec: off, tick });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisering
// ---------------------------------------------------------------------------

function siteFromPlace(place: string | null): "A" | "B" | null {
  if (!place) return null;
  const p = place.toLowerCase().replace(/[\s_]/g, "");
  if (/bombsitea|^asite|sitea$|^a$/.test(p)) return "A";
  if (/bombsiteb|^bsite|siteb$|^b$/.test(p)) return "B";
  return null;
}

export function normalizeRaw(raw: RawDemo, opts: { expectedRounds?: number | null; tickrate?: number } = {}): NormalizedDemo {
  const tickrate = opts.tickrate ?? DEFAULT_TICKRATE;
  const missing = new Set<string>();
  const mapName = canonicalMap(str(pick(raw.header, ["map_name", "mapname", "map"]))) ?? "unknown";
  if (mapName === "unknown") missing.add("header.map_name");

  const rounds = buildRounds(raw.events, opts.expectedRounds);
  if (rounds.length === 0) missing.add("round_end.winner");
  const roundOf = roundIndexer(rounds, 10 * tickrate);

  // Provtickarna → rundnummer och offset.
  const tickInfo = new Map<number, { round: number; offsetSec: number }>();
  for (const s of raw.sampleTicks) tickInfo.set(s.tick, { round: s.round, offsetSec: s.offsetSec });

  const players = new Map<string, { steamId: string; name: string; clan: string | null }>();
  const sides: Record<number, Record<string, Side>> = {};
  const samples: DemoSample[] = [];
  let sawPlace = false,
    sawEquip = false,
    sawInventory = false,
    sawClan = false;
  for (const row of raw.samples) {
    const tick = num(row.tick);
    const steamId = str(pick(row, ["steamid", "steam_id", "player_steamid"]));
    if (tick == null || !steamId) continue;
    const info = tickInfo.get(tick);
    if (!info) continue;
    const side = normSide(pick(row, ["team_num", "team_number", "team"]));
    if (!side) continue; // spectator / ingen sida
    const name = str(pick(row, ["name", "player_name"])) ?? steamId;
    const clan = str(pick(row, ["team_clan_name", "clan_name"]));
    if (clan) sawClan = true;
    if (!players.has(steamId)) players.set(steamId, { steamId, name, clan });
    else if (clan && !players.get(steamId)!.clan) players.get(steamId)!.clan = clan;

    if (info.offsetSec === SAMPLE_OFFSETS_SEC[0]) {
      (sides[info.round] ??= {})[steamId] = side;
    }
    const place = str(pick(row, ["last_place_name", "place"]));
    if (place) sawPlace = true;
    const equip = num(pick(row, ["current_equip_value", "equip_value"]));
    if (equip != null) sawEquip = true;
    const inv = pick(row, ["inventory"]);
    if (inv !== undefined) sawInventory = true;
    const invText = Array.isArray(inv) ? inv.join(" ") : String(inv ?? "");
    samples.push({
      round: info.round,
      offsetSec: info.offsetSec,
      steamId,
      side,
      alive: pick(row, ["is_alive"]) === undefined ? true : bool(pick(row, ["is_alive"])),
      x: num(pick(row, ["X", "x"])) ?? 0,
      y: num(pick(row, ["Y", "y"])) ?? 0,
      z: num(pick(row, ["Z", "z"])) ?? 0,
      place,
      equipValue: equip,
      hasAwp: /\bawp\b/i.test(invText),
    });
  }
  // Rundor utan prov vid 1 s (kort runda) ärver förra rundans sidor.
  for (const r of rounds) {
    if (!sides[r.n]) {
      const prev = sides[r.n - 1];
      if (prev) sides[r.n] = { ...prev };
    }
  }
  if (raw.samples.length > 0) {
    if (!sawPlace) missing.add("ticks.last_place_name");
    if (!sawEquip) missing.add("ticks.current_equip_value");
    if (!sawInventory) missing.add("ticks.inventory");
    if (!sawClan) missing.add("ticks.team_clan_name");
  } else {
    missing.add("ticks (inga provrader)");
  }

  const sideAt = (round: number, steamId: string | null) => (steamId ? sides[round]?.[steamId] ?? null : null);

  // Kills.
  const kills: DemoKill[] = [];
  let sawVictimPlace = false;
  for (const e of raw.events) {
    if (e.event_name !== "player_death") continue;
    const tick = num(e.tick);
    if (tick == null) continue;
    const round = roundOf(tick);
    if (round == null) continue;
    const victim = str(pick(e, ["user_steamid", "victim_steamid"]));
    if (!victim) continue;
    const attacker = str(pick(e, ["attacker_steamid"]));
    const victimPlace = str(pick(e, ["user_last_place_name", "victim_last_place_name"]));
    if (victimPlace) sawVictimPlace = true;
    kills.push({
      round,
      tick,
      attacker: attacker && attacker !== "0" ? attacker : null,
      victim,
      assister: str(pick(e, ["assister_steamid"])),
      flashAssist: bool(pick(e, ["assistedflash", "assisted_flash"])),
      weapon: normWeapon(pick(e, ["weapon"])),
      headshot: bool(pick(e, ["headshot"])),
      attackerPlace: str(pick(e, ["attacker_last_place_name"])),
      victimPlace,
    });
    for (const [id, nameKey] of [
      [victim, "user_name"],
      [attacker, "attacker_name"],
    ] as const) {
      if (id && !players.has(id)) {
        const nm = str(e[nameKey]);
        if (nm) players.set(id, { steamId: id, name: nm, clan: null });
      }
    }
  }
  if (kills.length > 0 && !sawVictimPlace) missing.add("player_death.user_last_place_name");
  kills.sort((a, b) => a.tick - b.tick);

  // Bomben.
  const bombs: DemoBomb[] = [];
  for (const e of raw.events) {
    if (e.event_name !== "bomb_planted" && e.event_name !== "bomb_defused") continue;
    const tick = num(e.tick);
    if (tick == null) continue;
    const round = roundOf(tick);
    if (round == null) continue;
    const place = str(pick(e, ["user_last_place_name"]));
    const siteRaw = str(pick(e, ["site"]));
    bombs.push({
      round,
      tick,
      kind: e.event_name === "bomb_planted" ? "planted" : "defused",
      site: siteFromPlace(place) ?? (siteRaw && /^[ab]$/i.test(siteRaw) ? (siteRaw.toUpperCase() as "A" | "B") : null),
      player: str(pick(e, ["user_steamid"])),
      x: num(pick(e, ["user_X", "user_x"])),
      y: num(pick(e, ["user_Y", "user_y"])),
    });
  }

  // Granatskada.
  const utilityDamage: NormalizedDemo["utilityDamage"] = [];
  for (const e of raw.events) {
    if (e.event_name !== "player_hurt") continue;
    if (!UTILITY_WEAPONS.has(normWeapon(pick(e, ["weapon"])))) continue;
    const tick = num(e.tick);
    const attacker = str(pick(e, ["attacker_steamid"]));
    const dmg = num(pick(e, ["dmg_health", "damage"]));
    if (tick == null || !attacker || dmg == null) continue;
    const round = roundOf(tick);
    if (round == null) continue;
    // Skada på lagkamrater räknas inte.
    const victim = str(pick(e, ["user_steamid"]));
    if (victim && sideAt(round, victim) === sideAt(round, attacker)) continue;
    utilityDamage.push({ round, attacker, damage: dmg });
  }

  // Granater: en projektil = alla rader med samma entity-id.
  const byEntity = new Map<string, RawRow[]>();
  for (const g of raw.grenades) {
    const id = str(pick(g, ["grenade_entity_id", "entity_id", "entityid"]));
    if (!id) continue;
    const list = byEntity.get(id);
    if (list) list.push(g);
    else byEntity.set(id, [g]);
  }
  const grenades: DemoGrenade[] = [];
  for (const rows of byEntity.values()) {
    const sorted = rows
      .map((r) => ({ r, tick: num(r.tick) }))
      .filter((x): x is { r: RawRow; tick: number } => x.tick != null)
      .sort((a, b) => a.tick - b.tick);
    if (sorted.length === 0) continue;
    const type = normGrenadeType(pick(sorted[0].r, ["grenade_type", "type", "name"]));
    if (!type) continue;
    // Sista raden med en position = landnings-/detonationspunkten.
    const last = [...sorted].reverse().find((x) => num(pick(x.r, ["x", "X"])) != null);
    if (!last) continue;
    const round = roundOf(sorted[0].tick);
    if (round == null) continue;
    grenades.push({
      round,
      type,
      thrower: str(pick(sorted[0].r, ["steamid", "thrower_steamid"])),
      throwTick: sorted[0].tick,
      landTick: last.tick,
      x: num(pick(last.r, ["x", "X"]))!,
      y: num(pick(last.r, ["y", "Y"])) ?? 0,
      z: num(pick(last.r, ["z", "Z"])) ?? 0,
    });
  }
  grenades.sort((a, b) => a.throwTick - b.throwTick);

  // Timeouts under freeze-tiden.
  const timeouts: NormalizedDemo["timeouts"] = [];
  const seenTo = new Set<string>();
  let sawTimeoutField = false;
  for (const row of raw.timeoutSamples) {
    const tick = num(row.tick);
    if (tick == null) continue;
    const tFlag = pick(row, ["is_terrorist_timeout", "terrorist_timeout"]);
    const ctFlag = pick(row, ["is_ct_timeout", "ct_timeout"]);
    if (tFlag !== undefined || ctFlag !== undefined) sawTimeoutField = true;
    const round = rounds.find((r) => tick <= r.freezeEndTick && tick >= (rounds[r.n - 2]?.endTick ?? 0));
    if (!round) continue;
    for (const [flag, side] of [
      [tFlag, "t"],
      [ctFlag, "ct"],
    ] as const) {
      if (!bool(flag)) continue;
      const key = `${round.n}:${side}`;
      if (seenTo.has(key)) continue;
      seenTo.add(key);
      timeouts.push({ round: round.n, side });
    }
  }
  if (raw.timeoutSamples.length > 0 && !sawTimeoutField) missing.add("ticks.is_ct_timeout/is_terrorist_timeout");

  const gridSamples: NormalizedDemo["gridSamples"] = [];
  for (const row of raw.gridSamples) {
    if (gridSamples.length >= 25_000) break;
    if (pick(row, ["is_alive"]) !== undefined && !bool(pick(row, ["is_alive"]))) continue;
    const place = str(pick(row, ["last_place_name", "place"]));
    const x = num(pick(row, ["X", "x"]));
    const y = num(pick(row, ["Y", "y"]));
    const z = num(pick(row, ["Z", "z"]));
    if (!place || x == null || y == null || z == null) continue;
    gridSamples.push([Math.round(x), Math.round(y), Math.round(z), place]);
  }

  return {
    mapName,
    tickrate,
    players: [...players.values()],
    rounds,
    sides,
    kills,
    grenades,
    samples,
    bombs,
    timeouts,
    utilityDamage,
    gridSamples,
    missingFields: [...missing],
  };
}

// ---------------------------------------------------------------------------
// IO mot demoparser2
// ---------------------------------------------------------------------------

/** Den del av @laihoe/demoparser2 som används. Returtyperna är otypade i paketet. */
export interface DemoparserApi {
  parseHeader(path: string): Record<string, unknown>;
  parseEvents(path: string, events: string[], playerExtra?: string[], otherExtra?: string[]): RawRow[];
  parseTicks(path: string, props: string[], ticks?: number[]): RawRow[];
  parseGrenades(path: string): RawRow[];
}

export async function loadDemoparser(): Promise<DemoparserApi> {
  // Variabeln hindrar TypeScript från att kräva paketets typer vid build —
  // det är ett valfritt beroende som bara finns där demos tolkas.
  const name = "@laihoe/demoparser2";
  try {
    const mod = (await import(name)) as { default?: DemoparserApi } & DemoparserApi;
    return (mod.default ?? mod) as DemoparserApi;
  } catch (err) {
    throw new Error(
      `@laihoe/demoparser2 kunde inte laddas (${err instanceof Error ? err.message : err}). ` +
        "Kör `npm install` igen — paketet har färdiga binärer för Windows, macOS och Linux."
    );
  }
}

export function readRawDemo(api: DemoparserApi, file: string, opts: { expectedRounds?: number | null; tickrate?: number } = {}): RawDemo {
  const tickrate = opts.tickrate ?? DEFAULT_TICKRATE;
  const header = api.parseHeader(file) ?? {};
  const events = api.parseEvents(file, EVENTS, ["last_place_name", "X", "Y", "Z", "team_num"], ["total_rounds_played", "is_warmup_period"]) ?? [];
  const rounds = buildRounds(events, opts.expectedRounds);
  const sampleTicks = sampleTicksFor(rounds, tickrate);
  const samples = sampleTicks.length ? api.parseTicks(file, SAMPLE_PROPS, sampleTicks.map((s) => s.tick)) ?? [] : [];

  // Timeouts tas under freeze-tiden: prova varje sekund från förra rundslutet.
  const toTicks: number[] = [];
  for (let i = 0; i < rounds.length; i++) {
    const from = i > 0 ? rounds[i - 1].endTick : rounds[i].startTick;
    for (let t = from; t <= rounds[i].freezeEndTick; t += tickrate) toTicks.push(t);
  }
  const timeoutSamples = toTicks.length ? api.parseTicks(file, TIMEOUT_PROPS, toTicks) ?? [] : [];

  const gridTicks: number[] = [];
  for (const r of rounds) for (let t = r.freezeEndTick; t < r.endTick; t += 2 * tickrate) gridTicks.push(t);
  const gridSamples = gridTicks.length ? api.parseTicks(file, GRID_PROPS, gridTicks) ?? [] : [];

  const grenades = api.parseGrenades(file) ?? [];
  return { header, events, grenades, samples, timeoutSamples, gridSamples, sampleTicks };
}
