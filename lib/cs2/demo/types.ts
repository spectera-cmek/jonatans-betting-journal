// Typer för demopipelinen.
//
//   demofil ──readRawDemo──► RawDemo ──normalizeRaw──► NormalizedDemo
//           ──analyzeDemo──► TeamSideFacts / PlayerSideFacts (sparas i DB)
//
// NormalizedDemo sparas också komprimerat lokalt (.cache/cs2/demos/norm), så
// analysen kan köras om (`npm run cs2:demos -- --reanalyze`) när nya mått
// läggs till — utan att ladda ner demon igen.

import type { RoundEndReason, Side } from "../types";

/** Höj när analysen ändras på ett sätt som gör gamla fakta inaktuella. */
export const DEMO_FACTS_VERSION = 1;

/** CS2-demos spelas in i 64 tick per sekund. */
export const DEFAULT_TICKRATE = 64;

export type GrenadeType = "smoke" | "flash" | "molotov" | "he" | "decoy";
export type BuyType = "pistol" | "eco" | "force" | "full";

// ---------------------------------------------------------------------------
// Rådata ur demoparser2 (otypade rader, fältnamn varierar mellan versioner)
// ---------------------------------------------------------------------------

export type RawRow = Record<string, unknown>;

export interface RawDemo {
  header: Record<string, unknown>;
  /** parseEvents — varje rad har `event_name`. */
  events: RawRow[];
  /** parseGrenades — en rad per tick och projektil. */
  grenades: RawRow[];
  /** parseTicks vid provtickarna (rundstart, freeze-end + n s). */
  samples: RawRow[];
  /** parseTicks för timeout-flaggorna under freeze-tiden. */
  timeoutSamples: RawRow[];
  /** parseTicks var ~2 s, för koordinat → callout-rutnätet. */
  gridSamples: RawRow[];
  /** Tickarna samples togs vid, per runda (se SAMPLE_OFFSETS_SEC). */
  sampleTicks: Array<{ round: number; offsetSec: number; tick: number }>;
}

// ---------------------------------------------------------------------------
// Normaliserad demo
// ---------------------------------------------------------------------------

export interface DemoRound {
  /** 1-baserat rundnummer i matchen (ordinarie + övertid). */
  n: number;
  startTick: number;
  freezeEndTick: number;
  endTick: number;
  winner: Side;
  reason: RoundEndReason;
}

export interface DemoKill {
  round: number;
  tick: number;
  attacker: string | null;
  victim: string;
  assister: string | null;
  flashAssist: boolean;
  weapon: string;
  headshot: boolean;
  attackerPlace: string | null;
  victimPlace: string | null;
}

export interface DemoGrenade {
  round: number;
  type: GrenadeType;
  thrower: string | null;
  throwTick: number;
  landTick: number;
  x: number;
  y: number;
  z: number;
}

export interface DemoSample {
  round: number;
  /** Sekunder efter freeze-end (negativt = under freeze-tiden). */
  offsetSec: number;
  steamId: string;
  side: Side | null;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  place: string | null;
  equipValue: number | null;
  hasAwp: boolean;
}

export interface DemoBomb {
  round: number;
  tick: number;
  kind: "planted" | "defused";
  site: "A" | "B" | null;
  player: string | null;
  x: number | null;
  y: number | null;
}

export interface NormalizedDemo {
  mapName: string;
  tickrate: number;
  players: Array<{ steamId: string; name: string; clan: string | null }>;
  rounds: DemoRound[];
  /** Spelarens sida per runda: sides[rundnummer][steamId]. */
  sides: Record<number, Record<string, Side>>;
  kills: DemoKill[];
  grenades: DemoGrenade[];
  samples: DemoSample[];
  bombs: DemoBomb[];
  /** Taktisk timeout tagen under freeze-tiden före runda `round`. */
  timeouts: Array<{ round: number; side: Side }>;
  /** Skada från granater/molotov per runda och spelare. */
  utilityDamage: Array<{ round: number; attacker: string; damage: number }>;
  /** Positioner för callout-rutnätet: [x, y, z, place]. */
  gridSamples: Array<[number, number, number, string]>;
  /** Fält som saknades i demoparserns utdata — visas i schemakontrollen. */
  missingFields: string[];
}

// ---------------------------------------------------------------------------
// Fakta som sparas i DB
// ---------------------------------------------------------------------------

export interface UtilityThrow {
  type: GrenadeType;
  /** Callout där granaten landade. */
  place: string | null;
  /** Sekunder efter freeze-end när den kastades. */
  sec: number;
  thrower: string | null;
}

/** En runda ur ett lags perspektiv på en sida. */
export interface RoundFact {
  n: number;
  /** 0 = första halvlek, 1 = andra, 2+ = övertid. */
  half: number;
  won: boolean;
  reason: RoundEndReason;
  pistol: boolean;
  buy: BuyType;
  oppBuy: BuyType;
  equip: number;
  oppEquip: number;
  /** 1, 2, 3 … för lagets fullköp i halvleken; null om inte fullköp. */
  buyIndex: number | null;
  /** Rundan direkt efter en förlorad pistol (docens LOWBUYS). */
  afterLostPistol: boolean;
  /** Laget tog timeout före rundan (docens AFTER PAUSE). */
  afterTimeout: boolean;
  oppTimeout: boolean;
  /** Förlorade rundor i rad före den här. */
  lossStreakBefore: number;
  scoreBefore: [number, number];
  firstKillSec: number | null;
  /** own = laget tog rundans första kill. */
  firstKillBy: "own" | "opp" | null;
  firstKillPlace: string | null;
  openingKiller: string | null;
  openingVictim: string | null;
  plantSite: "A" | "B" | null;
  plantSec: number | null;
  /** Sorterad callout-signatur, t.ex. "BombsiteA×2 Connector BombsiteB×2". */
  setup: string | null;
  /** Zoner: "A2-M1-B2". */
  zones: string | null;
  /** Position per spelare vid provtiden (20 s). */
  positions: Record<string, string | null>;
  /** Spelare med AWP vid provtiden. */
  awpers: string[];
  /** Spelaren längst från resten av laget (T, 35 s) — lurkern. */
  lurker: string | null;
  utility: UtilityThrow[];
  kills: number;
  deaths: number;
  /** Levande vid rundslut — sparbeteende i förlorade rundor. */
  aliveAtEnd: number;
}

export interface TeamSideFacts {
  v: number;
  rounds: RoundFact[];
}

export interface PlayerSideFacts {
  v: number;
  rounds: number;
  roundsWon: number;
  kills: number;
  killsWon: number;
  killsLost: number;
  killsOt: number;
  headshots: number;
  deaths: number;
  assists: number;
  flashAssists: number;
  awpKills: number;
  /** Rundor spelaren deltog i rundans första duell. */
  openingAttempts: number;
  openingKills: number;
  openingDeaths: number;
  pistolRounds: number;
  pistolKills: number;
  /** [2k, 3k, 4k, 5k] */
  multi: [number, number, number, number];
  clutchAttempts: number;
  clutchWins: number;
  util: Record<GrenadeType, number>;
  utilDamage: number;
  /** Callout → antal rundor vid provtiden. */
  places: Record<string, number>;
  /** Callout → AWP-kills därifrån. */
  awpKillPlaces: Record<string, number>;
  /** "smoke@Window" → antal. */
  grenades: Record<string, number>;
  /** Rundor med AWP i händerna vid provtiden. */
  awpRounds: number;
  /** AWP-kills inom de första 12 sekunderna (spawn-/öppningspeek). */
  awpEarlyKills: number;
  /** Rundor spelaren var lagets lurker. */
  lurkRounds: number;
  /** CT: rundor spelaren stod på en bombplats vid provtiden. */
  siteRounds: number;
  /** Kills per runda i ordning — för spridning och OT-split. */
  rk: number[];
}
