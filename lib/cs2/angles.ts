// Angles: datadrivna skäl att avvika från bokens linje.
//
// En angle är inte ett spel — den är en flagga med en siffra och ett urval
// bakom sig. Regler med trösklar på både effekt och sample, så att tre kartors
// brus inte blir en "angle". Prissatta linjer med edge kommer först.

import type { Cs2Market } from "./types";

export interface Angle {
  kind:
    | "edge"
    | "map_kpr"
    | "rounds"
    | "mismatch"
    | "pistol"
    | "awp_peek"
    | "entry"
    | "antieco"
    | "new_roster"
    | "thin_data";
  title: string;
  detail: string;
  /** 1 = svag, 3 = stark. Varningar har 0. */
  strength: 0 | 1 | 2 | 3;
  markets: Cs2Market[];
  playerId?: number;
  teamId?: number;
  mapName?: string;
}

export interface AnglePlayerInput {
  playerId: number;
  nickname: string;
  teamId: number;
  teamName: string;
  /** KPR per karta och totalt, med antal kartor. */
  kprByMap: Record<string, { kpr: number; maps: number }>;
  kprAll: number | null;
  mapsAll: number;
  /** Kartor för nuvarande lag inom perioden. */
  mapsForTeam: number;
  awpRounds: number;
  awpEarlyKills: number;
  openingShare: number | null;
  openingRounds: number;
}

export interface AngleMapInput {
  mapName: string;
  label: string;
  /** P(kartan spelas som karta 1 eller 2). */
  pIn12: number;
  expRounds: number;
  pOt: number;
}

export interface AngleTeamInput {
  teamId: number;
  name: string;
  pistolWinRate: number | null;
  pistolN: number;
  antiEcoLossRate: number | null;
  antiEcoN: number;
  mapsInWindow: number;
}

export interface AngleInputs {
  players: AnglePlayerInput[];
  maps: AngleMapInput[];
  teams: AngleTeamInput[];
  /** P(lag 1 vinner serien). */
  pTeam1: number;
  team1Name: string;
  team2Name: string;
  /** Ligans snitt av förväntade rundor per karta. */
  leagueRounds: number;
  pricedLines: Array<{ label: string; edge: number | null; bestSide: string | null; market: Cs2Market; playerId?: number | null }>;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const dec = (x: number, d = 2) => x.toFixed(d).replace(".", ",");

export function buildAngles(inp: AngleInputs): Angle[] {
  const out: Angle[] = [];

  for (const l of inp.pricedLines) {
    if (l.edge == null || l.edge < 0.04) continue;
    out.push({
      kind: "edge",
      title: `${l.label}: ${l.bestSide === "over" ? "över/ja" : "under/nej"} har ${pct(l.edge)} edge`,
      detail: "Modellen blandad med bokens avviggade pris ger positivt väntevärde. Kontrollera linjen och böckernas OT-regel innan spel.",
      strength: l.edge >= 0.1 ? 3 : l.edge >= 0.06 ? 2 : 1,
      markets: [l.market],
      playerId: l.playerId ?? undefined,
    });
  }

  // Kartspecifik KPR mot spelarens nivå, på kartor som troligen spelas.
  for (const p of inp.players) {
    if (p.kprAll == null || p.kprAll <= 0) continue;
    for (const m of inp.maps) {
      const s = p.kprByMap[m.mapName];
      if (!s || s.maps < 4 || m.pIn12 < 0.35) continue;
      const rel = s.kpr / p.kprAll - 1;
      if (Math.abs(rel) < 0.12) continue;
      out.push({
        kind: "map_kpr",
        title: `${p.nickname} ${rel > 0 ? "lyfter" : "tappar"} på ${m.label}: ${dec(s.kpr)} kills/runda mot ${dec(p.kprAll)} totalt`,
        detail: `${s.maps} kartor på ${m.label}. Kartan spelas som karta 1–2 med ${pct(m.pIn12)} sannolikhet — påverkar kills-linjen för karta 1–2.`,
        strength: Math.abs(rel) >= 0.2 && s.maps >= 6 ? 2 : 1,
        markets: ["kills"],
        playerId: p.playerId,
        mapName: m.mapName,
      });
    }
    if (p.mapsForTeam < 3 && p.mapsAll >= 3) {
      out.push({
        kind: "new_roster",
        title: `${p.nickname} är ny i ${p.teamName}`,
        detail: `Bara ${p.mapsForTeam} kartor med laget i perioden — siffrorna kommer främst från tidigare lag och roll.`,
        strength: 0,
        markets: ["kills", "headshots"],
        playerId: p.playerId,
      });
    }
    if (p.awpRounds >= 40 && p.awpEarlyKills / p.awpRounds >= 0.22) {
      out.push({
        kind: "awp_peek",
        title: `${p.nickname} spawn-/öppningspeekar med AWP`,
        detail: `${pct(p.awpEarlyKills / p.awpRounds)} av AWP-rundorna ger en AWP-kill inom 12 s (${p.awpRounds} rundor). Fler tidiga dueller — talar för första kill-marknader.`,
        strength: 1,
        markets: ["player_first_kill", "first_kill"],
        playerId: p.playerId,
      });
    }
    if (p.openingShare != null && p.openingRounds >= 80 && p.openingShare >= 0.3) {
      out.push({
        kind: "entry",
        title: `${p.nickname} tar ${pct(p.openingShare)} av lagets öppningskills`,
        detail: `Över ${p.openingRounds} rundor. En hög andel gör honom till lagets troligaste första kill.`,
        strength: 1,
        markets: ["player_first_kill"],
        playerId: p.playerId,
      });
    }
  }

  for (const m of inp.maps) {
    if (m.pIn12 < 0.35) continue;
    const diff = m.expRounds - inp.leagueRounds;
    if (Math.abs(diff) >= 1.2 || m.pOt >= 0.15) {
      out.push({
        kind: "rounds",
        title: `${m.label}: förväntat ${dec(m.expRounds, 1)} rundor (övertid ${pct(m.pOt)})`,
        detail: `${diff > 0 ? "Jämnare" : "Mer ensidig"} karta än ligasnittet ${dec(inp.leagueRounds, 1)} — ${diff > 0 ? "fler" : "färre"} rundor drar alla spelares kills åt samma håll.`,
        strength: Math.abs(diff) >= 2 || m.pOt >= 0.2 ? 2 : 1,
        markets: ["rounds", "kills", "headshots"],
        mapName: m.mapName,
      });
    }
  }

  const fav = Math.max(inp.pTeam1, 1 - inp.pTeam1);
  if (fav >= 0.75) {
    const favName = inp.pTeam1 >= 0.5 ? inp.team1Name : inp.team2Name;
    const dogName = inp.pTeam1 >= 0.5 ? inp.team2Name : inp.team1Name;
    out.push({
      kind: "mismatch",
      title: `${favName} klar favorit (${pct(fav)})`,
      detail: `Ensidiga kartor ger färre rundor — ${dogName}s spelare får få vunna rundor att ta kills i, och en snabb 2–0 stänger karta 3.`,
      strength: fav >= 0.85 ? 2 : 1,
      markets: ["kills", "total_maps", "map_handicap"],
    });
  }

  for (const t of inp.teams) {
    if (t.pistolWinRate != null && t.pistolN >= 12 && Math.abs(t.pistolWinRate - 0.5) >= 0.12) {
      out.push({
        kind: "pistol",
        title: `${t.name} vinner ${pct(t.pistolWinRate)} av pistolrundorna`,
        detail: `${t.pistolN} pistolrundor i perioden. Pistoler är brusiga — modellen krymper hårt, så en avvikelse här är värd att titta på.`,
        strength: t.pistolN >= 24 ? 2 : 1,
        markets: ["pistol"],
        teamId: t.teamId,
      });
    }
    if (t.antiEcoLossRate != null && t.antiEcoN >= 15 && t.antiEcoLossRate >= 0.15) {
      out.push({
        kind: "antieco",
        title: `${t.name} tappar ${pct(t.antiEcoLossRate)} av anti-ecos`,
        detail: `${t.antiEcoN} anti-eco-rundor ur demos. Tappade ecos ger motståndaren ekonomi och kartan fler rundor.`,
        strength: 1,
        markets: ["rounds", "map_handicap"],
        teamId: t.teamId,
      });
    }
    if (t.mapsInWindow < 6) {
      out.push({
        kind: "thin_data",
        title: `Lite data för ${t.name}`,
        detail: `${t.mapsInWindow} kartor i perioden — modellen lutar sig mest mot ligasnittet för laget.`,
        strength: 0,
        markets: [],
        teamId: t.teamId,
      });
    }
  }

  return out.sort((a, b) => (a.kind === "edge" ? -1 : 0) - (b.kind === "edge" ? -1 : 0) || b.strength - a.strength);
}
