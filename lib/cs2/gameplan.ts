// Docen "GAMEPLAN Analysis Template" som data: en rapport per lag, karta och
// sida (T / CT) med exakt docens sektioner och rubriker, fyllda ur HLTV-
// statistik och demofakta. Fritexten i docen (planer, påminnelser) blir egna
// anteckningar per sektion (Cs2GameplanNote) som UI:t lägger bredvid.
//
// Docen är skriven ur ett lags perspektiv ("OUR = Falcons"). Här är den
// neutral: "vs [OPPONENT]" är matchens motståndare när en finns, och
// "WHAT WE DID LAST" är lagets senaste kartor på banan (H2H först).

import type { PlayerSideFacts, RoundFact, UtilityThrow } from "./demo/types";
import { prettyPlace } from "./demo/places";
import { siteOfPlace } from "./demo/analyze";
import { mapLabel } from "./maps";
import { topCounts, type TeamMapRow } from "./profiles";
import { ROLE_LABEL, type Role } from "./roles";
import type { Side } from "./types";

export const SECTION_KEYS = [
  "positions",
  "lowbuys",
  "antieco",
  "gameplan",
  "focus",
  "buyrounds",
  "setups",
  "awp",
  "last",
  "utility",
  "extra",
  "afterpause",
  "badstart",
  "reminders",
  "sample",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_META: Record<SectionKey, { title: string; sub: string; betting?: string }> = {
  positions: {
    title: "POSITIONS",
    sub: "AWP och spot 1–4 — var spelarna står",
    betting: "Rollen styr kills: entry och AWP tar flest öppningsdueller, ett ankare på en plats som sällan träffas får färre.",
  },
  lowbuys: {
    title: "LOWBUYS (when losing pistol)",
    sub: "Rundan efter förlorad pistol",
    betting: "Ekonomisvängningar avgör om kartan blir jämn — fler rundor betyder fler kills.",
  },
  antieco: {
    title: "ANTIECO",
    sub: "Fullköp mot motståndarens eco",
    betting: "Tappade anti-ecos ger extra rundor; anti-eco-rundor blåser upp kills för det köpande laget.",
  },
  gameplan: { title: "GAMEPLAN SUGGESTIONS + INFO", sub: "Mönster och svagheter ur datan" },
  focus: {
    title: "SPECIFICS / FOCUS",
    sub: "Spelare för spelare",
    betting: "Underlaget för spelarprops: kills per runda i vunna/förlorade rundor, HS och öppningsdueller.",
  },
  buyrounds: { title: "BUY ROUND PLAN", sub: "Lagets 1:a, 2:a och 3:e fullköp per halvlek" },
  setups: { title: "% SETUPS (tendencies)", sub: "Hur laget ställer upp, i procent av rundorna" },
  awp: {
    title: "% AWP",
    sub: "AWP-spelarens mönster",
    betting: "En aggressiv AWP ger fler tidiga dueller åt båda håll — påverkar AWP:ns kills och första kill.",
  },
  last: { title: "WHAT WE DID LAST", sub: "Senaste kartorna på banan" },
  utility: { title: "UTILITY THEY USE A LOT", sub: "Vanligaste granaterna och var de landar" },
  extra: { title: "EXTRA INFO", sub: "Lurk, smokes och fakes" },
  afterpause: {
    title: "AFTER PAUSE TACTIC / TENDENCY",
    sub: "Rundan efter lagets taktiska timeout",
    betting: "Live: hur laget svarar efter en timeout.",
  },
  badstart: {
    title: "PLAN IF WE HAVE A BAD START",
    sub: "Hur laget reagerar på motgång",
    betting: "Comeback-benägenhet påverkar rundhandikapp och totala rundor.",
  },
  reminders: { title: "REMINDERS", sub: "Egna anteckningar" },
  sample: { title: "SAMPLE SIZE", sub: "Underlaget bakom siffrorna" },
};

export interface GameplanItem {
  label: string;
  value: string;
  /** Antal rundor/kartor bakom siffran. */
  n?: number;
  tone?: "pos" | "neg" | "warn";
  /** Underpunkter, som docens tre punkter per spelare. */
  detail?: string[];
}

export interface GameplanSection {
  key: SectionKey;
  title: string;
  sub: string;
  betting?: string;
  items: GameplanItem[];
  /** Förklaring när sektionen saknar data. */
  empty?: string;
}

export interface GameplanReport {
  teamId: number;
  teamName: string;
  mapName: string;
  mapLabel: string;
  side: Side;
  opponentName: string | null;
  sections: GameplanSection[];
  sample: { maps: number; demoMaps: number; rounds: number; months: number; from: string | null; to: string | null };
}

export interface GameplanPlayer {
  playerId: number | null;
  steamIds: string[];
  nickname: string;
  role: Role | string | null;
  facts: PlayerSideFacts | null;
}

export interface GameplanInput {
  teamId: number;
  teamName: string;
  mapName: string;
  side: Side;
  months: number;
  /** HLTV-kartor på banan inom urvalet (nyast först). */
  maps: TeamMapRow[];
  /** Demofakta för lagets rundor på sidan, inom urvalet. */
  rounds: Array<RoundFact & { mapId: number }>;
  players: GameplanPlayer[];
  /** steamId → nick. */
  nick: (steamId: string | null) => string;
  opponentId?: number | null;
  opponentName?: string | null;
  teamNames: Map<number, string>;
}

// ---------------------------------------------------------------------------
// Formatering
// ---------------------------------------------------------------------------

const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)} %`);
const dec = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d).replace(".", ","));
const rate = (n: number, d: number) => (d > 0 ? n / d : null);
const share = (n: number, d: number) => `${pct(rate(n, d))} (${n}/${d})`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function mode<T>(xs: T[]): { value: T; count: number } | null {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of m) if (!best || count > best.count) best = { value, count };
  return best;
}

function distribution(xs: string[], labels?: Record<string, string>): string {
  if (xs.length === 0) return "—";
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${labels?.[k] ?? k} ${pct(n / xs.length)}`)
    .join(" · ");
}

const BUY_LABEL: Record<string, string> = { eco: "eco", force: "force", full: "fullköp", pistol: "pistol" };

function utilityTable(throws: UtilityThrow[], rounds: number, top: number): GameplanItem[] {
  const counts = new Map<string, { type: string; place: string | null; total: number; rounds: Set<string> }>();
  throws.forEach((t) => {
    const key = `${t.type}@${t.place ?? "okänt"}`;
    let c = counts.get(key);
    if (!c) counts.set(key, (c = { type: t.type, place: t.place, total: 0, rounds: new Set() }));
    c.total++;
    c.rounds.add((t as UtilityThrow & { roundKey?: string }).roundKey ?? "");
  });
  return [...counts.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, top)
    .map((c) => {
      const perRound = c.total / Math.max(1, rounds);
      return {
        label: `${perRound >= 1.5 ? `${Math.round(perRound)}x ` : ""}${c.type[0].toUpperCase()}${c.type.slice(1)} ${prettyPlace(c.place)}`,
        value: `${dec(perRound, 1)} per runda · i ${pct(c.rounds.size / Math.max(1, rounds))} av rundorna`,
        n: rounds,
      };
    });
}

// ---------------------------------------------------------------------------
// Sektioner
// ---------------------------------------------------------------------------

function sectionPositions(inp: GameplanInput): GameplanSection {
  const withFacts = inp.players.filter((p) => p.facts && p.facts.rounds > 0);
  const byAwp = [...withFacts].sort((a, b) => rate(b.facts!.awpRounds, b.facts!.rounds)! - rate(a.facts!.awpRounds, a.facts!.rounds)!);
  const awper = byAwp[0] && rate(byAwp[0].facts!.awpRounds, byAwp[0].facts!.rounds)! >= 0.3 ? byAwp[0] : null;
  const spots = withFacts.filter((p) => p !== awper);
  const describe = (p: GameplanPlayer) => {
    const tops = topCounts(p.facts!.places, 2);
    const where = tops.map((t) => `${prettyPlace(t.key)} ${pct(t.share)}`).join(", ") || "okänt";
    return `${p.nickname}${p.role ? ` (${ROLE_LABEL[p.role as Role] ?? p.role})` : ""} · ${where}`;
  };
  const items: GameplanItem[] = [];
  if (awper) items.push({ label: "AWP", value: describe(awper), n: awper.facts!.rounds });
  spots.forEach((p, i) => items.push({ label: `SPOT ${i + 1}`, value: describe(p), n: p.facts!.rounds }));
  return { key: "positions", ...SECTION_META.positions, items, empty: items.length ? undefined : "Inga demos tolkade för kartan och sidan än." };
}

function sectionLowbuys(inp: GameplanInput): GameplanSection {
  const rs = inp.rounds.filter((r) => r.afterLostPistol);
  if (rs.length === 0) return { key: "lowbuys", ...SECTION_META.lowbuys, items: [], empty: "Ingen förlorad pistol på den här sidan i urvalet." };
  const lost = rs.filter((r) => !r.won);
  const next = inp.rounds.filter((r) => rs.some((x) => x.mapId === r.mapId && r.n === x.n + 1));
  const zones = mode(rs.map((r) => r.zones).filter((z): z is string => !!z));
  const own = rs.filter((r) => r.firstKillBy === "own").length;
  const items: GameplanItem[] = [
    { label: "Köp", value: distribution(rs.map((r) => r.buy), BUY_LABEL), n: rs.length },
    { label: "Vann rundan", value: share(rs.filter((r) => r.won).length, rs.length), n: rs.length },
    { label: "Vann rundan därpå", value: next.length ? share(next.filter((r) => r.won).length, next.length) : "—", n: next.length },
    { label: "Vanligaste uppställning", value: zones ? `${zones.value} · ${pct(zones.count / rs.length)}` : "—", n: rs.length },
    {
      label: "Första kill",
      value: `${pct(rate(own, rs.length))} egna · snitt ${dec(avg(rs.map((r) => r.firstKillSec).filter((x): x is number => x != null)), 0)} s`,
      n: rs.length,
    },
    {
      label: "Sparar vid förlust",
      value: lost.length ? `${dec(avg(lost.map((r) => r.aliveAtEnd)), 1)} vid liv vid rundslut` : "—",
      n: lost.length,
    },
  ];
  return { key: "lowbuys", ...SECTION_META.lowbuys, items };
}

function sectionAntieco(inp: GameplanInput): GameplanSection {
  const anti = inp.rounds.filter((r) => r.buy === "full" && r.oppBuy === "eco" && !r.pistol);
  const antiForce = inp.rounds.filter((r) => r.buy === "full" && r.oppBuy === "force" && !r.pistol);
  if (anti.length === 0 && antiForce.length === 0) return { key: "antieco", ...SECTION_META.antieco, items: [], empty: "Inga anti-eco-rundor i urvalet." };
  const lostAnti = anti.filter((r) => !r.won).length;
  const lossRate = rate(lostAnti, anti.length);
  const early = anti.filter((r) => r.firstKillSec != null && r.firstKillSec <= 15).length;
  return {
    key: "antieco",
    ...SECTION_META.antieco,
    items: [
      { label: "Vinst mot eco", value: share(anti.length - lostAnti, anti.length), n: anti.length },
      {
        label: "Tappade anti-ecos",
        value: `${lostAnti} st (${pct(lossRate)})`,
        n: anti.length,
        tone: lossRate != null && lossRate > 0.12 ? "warn" : undefined,
      },
      { label: "Döda per anti-eco-runda", value: dec(avg(anti.map((r) => r.deaths)), 1), n: anti.length },
      { label: "Första duell före 15 s", value: pct(rate(early, anti.length)), n: anti.length },
      { label: "Vinst mot force", value: antiForce.length ? share(antiForce.filter((r) => r.won).length, antiForce.length) : "—", n: antiForce.length },
    ],
  };
}

function sectionGameplan(inp: GameplanInput): GameplanSection {
  const rs = inp.rounds.filter((r) => !r.pistol);
  if (rs.length === 0) return { key: "gameplan", ...SECTION_META.gameplan, items: [], empty: "Inga demos tolkade för kartan och sidan än." };
  const planted = rs.filter((r) => r.plantSite);
  const items: GameplanItem[] = [{ label: "Rundvinst på sidan", value: share(rs.filter((r) => r.won).length, rs.length), n: rs.length }];
  if (inp.side === "t") {
    items.push(
      { label: "Plantar", value: planted.length ? distribution(planted.map((r) => `${r.plantSite}-site`)) : "—", n: planted.length },
      { label: "Vinst med plant", value: planted.length ? share(planted.filter((r) => r.won).length, planted.length) : "—", n: planted.length },
      { label: "Vinst utan plant", value: share(rs.filter((r) => !r.plantSite && r.won).length, rs.filter((r) => !r.plantSite).length), n: rs.length - planted.length },
      { label: "Snitt tid till plant", value: `${dec(avg(planted.map((r) => r.plantSec).filter((x): x is number => x != null)), 0)} s`, n: planted.length }
    );
  } else {
    for (const site of ["A", "B"] as const) {
      const hit = planted.filter((r) => r.plantSite === site);
      items.push({
        label: `Försvar efter plant på ${site}`,
        value: hit.length ? share(hit.filter((r) => r.won).length, hit.length) : "—",
        n: hit.length,
        tone: hit.length >= 5 && rate(hit.filter((r) => r.won).length, hit.length)! < 0.2 ? "warn" : undefined,
      });
    }
    items.push({ label: "Motståndarna plantar", value: planted.length ? distribution(planted.map((r) => `${r.plantSite}-site`)) : "—", n: planted.length });
  }
  const ownFk = rs.filter((r) => r.firstKillBy === "own");
  const oppFk = rs.filter((r) => r.firstKillBy === "opp");
  items.push(
    { label: "Vinst efter egen första kill", value: ownFk.length ? share(ownFk.filter((r) => r.won).length, ownFk.length) : "—", n: ownFk.length },
    { label: "Vinst efter motståndarens första kill", value: oppFk.length ? share(oppFk.filter((r) => r.won).length, oppFk.length) : "—", n: oppFk.length }
  );
  return { key: "gameplan", ...SECTION_META.gameplan, items };
}

function sectionFocus(inp: GameplanInput): GameplanSection {
  const items: GameplanItem[] = [];
  for (const p of inp.players) {
    const f = p.facts;
    if (!f || f.rounds === 0) continue;
    const lostRounds = f.rounds - f.roundsWon;
    const places = topCounts(f.places, 2).map((t) => `${prettyPlace(t.key)} ${pct(t.share)}`).join(", ");
    const nades = topCounts(f.grenades, 2)
      .map((t) => {
        const [type, place] = t.key.split("@");
        return `${type} ${prettyPlace(place)} ${dec(t.count / f.rounds, 1)}/runda`;
      })
      .join(", ");
    const multi = f.multi.reduce((a, b) => a + b, 0);
    const detail = [
      `Står: ${places || "okänt"}`,
      `KPR ${dec(rate(f.kills, f.rounds))} (vunna ${dec(rate(f.killsWon, f.roundsWon))} / förlorade ${dec(rate(f.killsLost, lostRounds))}) · HS ${pct(rate(f.headshots, f.kills))}`,
      `Öppningsduell i ${pct(rate(f.openingAttempts, f.rounds))} av rundorna, vinner ${pct(rate(f.openingKills, f.openingAttempts))}`,
      `Utility: ${nades || "—"}`,
      `2k+ i ${pct(rate(multi, f.rounds))} av rundorna · clutch ${f.clutchWins}/${f.clutchAttempts}`,
    ];
    if (f.awpKills > 0) {
      detail.push(
        `AWP-kills från: ${topCounts(f.awpKillPlaces, 3).map((t) => `${prettyPlace(t.key)} ${pct(t.share)}`).join(", ")}`
      );
    }
    items.push({
      label: `${p.nickname}${p.role ? ` · ${ROLE_LABEL[p.role as Role] ?? p.role}` : ""}`,
      value: `${dec(rate(f.kills, f.rounds))} kills/runda`,
      n: f.rounds,
      detail,
    });
  }
  return { key: "focus", ...SECTION_META.focus, items, empty: items.length ? undefined : "Inga demos tolkade för kartan och sidan än." };
}

function sectionBuyRounds(inp: GameplanInput): GameplanSection {
  const items: GameplanItem[] = [];
  const names = ["1st buy round", "2nd buy round", "3rd buy round"];
  for (let i = 1; i <= 3; i++) {
    const rs = inp.rounds.filter((r) => r.buyIndex === i);
    if (rs.length === 0) continue;
    const parts = [`vinst ${pct(rate(rs.filter((r) => r.won).length, rs.length))}`];
    if (inp.side === "t") {
      const planted = rs.filter((r) => r.plantSite);
      if (planted.length) parts.push(`plant ${distribution(planted.map((r) => `${r.plantSite}`))}`);
      const fk = mode(rs.map((r) => r.firstKillPlace).filter((x): x is string => !!x));
      if (fk) parts.push(`första kontakt ${prettyPlace(fk.value)} (${pct(fk.count / rs.length)})`);
    } else {
      const z = mode(rs.map((r) => r.zones).filter((x): x is string => !!x));
      if (z) parts.push(`setup ${z.value} (${pct(z.count / rs.length)})`);
    }
    const t = avg(rs.map((r) => r.firstKillSec).filter((x): x is number => x != null));
    if (t != null) parts.push(`första kill ~${Math.round(t)} s`);
    items.push({ label: names[i - 1], value: parts.join(" · "), n: rs.length });
  }
  return { key: "buyrounds", ...SECTION_META.buyrounds, items, empty: items.length ? undefined : "Inga fullköp i urvalet." };
}

function sectionSetups(inp: GameplanInput): GameplanSection {
  const rs = inp.rounds.filter((r) => !r.pistol && r.buy === "full");
  if (rs.length === 0) return { key: "setups", ...SECTION_META.setups, items: [], empty: "Inga fullköpsrundor i urvalet." };
  const items: GameplanItem[] = [];
  const zones = new Map<string, number>();
  for (const r of rs) if (r.zones) zones.set(r.zones, (zones.get(r.zones) ?? 0) + 1);
  for (const [z, n] of [...zones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    items.push({ label: z, value: pct(n / rs.length), n: rs.length });
  }
  const early = rs.filter((r) => r.firstKillSec != null && r.firstKillSec <= 15).length;
  if (inp.side === "ct") {
    items.push({ label: "Tidig duell (≤15 s)", value: pct(rate(early, rs.length)), n: rs.length });
  } else {
    const planted = rs.filter((r) => r.plantSec != null);
    const cls = (s: number) => (s <= 35 ? "snabb" : s <= 70 ? "standard" : "sen");
    items.push({
      label: "Execute-tempo",
      value: planted.length ? `${distribution(planted.map((r) => cls(r.plantSec!)))} · ingen plant ${pct(rate(rs.length - planted.length, rs.length))}` : "—",
      n: rs.length,
    });
  }
  const top = mode(rs.map((r) => r.setup).filter((x): x is string => !!x));
  if (top) items.push({ label: "Vanligaste exakta setup", value: `${top.value} · ${pct(top.count / rs.length)}`, n: rs.length });
  return { key: "setups", ...SECTION_META.setups, items };
}

function sectionAwp(inp: GameplanInput): GameplanSection {
  const withAwp = inp.players.filter((p) => p.facts && p.facts.awpRounds > 0).sort((a, b) => b.facts!.awpRounds - a.facts!.awpRounds);
  const p = withAwp[0];
  if (!p || !p.facts) return { key: "awp", ...SECTION_META.awp, items: [], empty: "Ingen AWP-spelare i urvalet." };
  const f = p.facts;
  return {
    key: "awp",
    ...SECTION_META.awp,
    items: [
      { label: "AWP-spelare", value: `${p.nickname} · AWP i ${pct(rate(f.awpRounds, f.rounds))} av rundorna`, n: f.rounds },
      { label: "Tidiga AWP-kills (≤12 s)", value: `${dec(rate(f.awpEarlyKills, f.awpRounds))} per AWP-runda`, n: f.awpRounds },
      { label: "Öppningsduell", value: `${pct(rate(f.openingAttempts, f.rounds))} av rundorna, vinner ${pct(rate(f.openingKills, f.openingAttempts))}`, n: f.rounds },
      {
        label: "AWP-kills från",
        value: topCounts(f.awpKillPlaces, 4).map((t) => `${prettyPlace(t.key)} ${pct(t.share)}`).join(", ") || "—",
        n: f.awpKills,
      },
    ],
  };
}

function sectionLast(inp: GameplanInput): GameplanSection {
  const h2h = inp.opponentId ? inp.maps.filter((m) => m.opponentId === inp.opponentId) : [];
  const rest = inp.maps.filter((m) => !h2h.includes(m));
  const pickLabel: Record<string, string> = { own: "eget pick", opp: "deras pick", decider: "decider" };
  const items = [...h2h, ...rest].slice(0, 4).map((m) => ({
    label: `${m.playedAt.toISOString().slice(0, 10)} vs ${inp.teamNames.get(m.opponentId) ?? "?"}${h2h.includes(m) ? " (H2H)" : ""}`,
    value: `${m.roundsFor}–${m.roundsAgainst} ${m.won ? "vinst" : "förlust"} · start ${m.startSide?.toUpperCase() ?? "?"} · ${pickLabel[m.pick]}`,
    tone: (m.won ? "pos" : "neg") as GameplanItem["tone"],
  }));
  return { key: "last", ...SECTION_META.last, items, empty: items.length ? undefined : "Laget har inte spelat kartan i urvalet." };
}

function sectionUtility(inp: GameplanInput): GameplanSection {
  const rs = inp.rounds.filter((r) => !r.pistol);
  if (rs.length === 0) return { key: "utility", ...SECTION_META.utility, items: [], empty: "Inga demos tolkade för kartan och sidan än." };
  const tag = (r: RoundFact & { mapId: number }, list: UtilityThrow[]) => list.map((u) => ({ ...u, roundKey: `${r.mapId}:${r.n}` }));
  const items: GameplanItem[] = [];
  if (inp.side === "ct") {
    const def = rs.flatMap((r) => tag(r, r.utility.filter((u) => u.sec <= 30 && u.type !== "decoy")));
    items.push({ label: "CT DEFAULT (most common)", value: `första 30 s, ${rs.length} rundor`, n: rs.length });
    items.push(...utilityTable(def, rs.length, 6));
  } else {
    for (const site of ["A", "B"] as const) {
      const ex = rs.filter((r) => r.plantSite === site && r.plantSec != null);
      if (ex.length === 0) continue;
      const nades = ex.flatMap((r) => tag(r, r.utility.filter((u) => u.type !== "decoy" && u.sec <= r.plantSec! && u.sec >= r.plantSec! - 15)));
      items.push({ label: `${site} EXECUTE (default)`, value: `15 s före plant, ${ex.length} rundor`, n: ex.length });
      items.push(...utilityTable(nades, ex.length, 5));
    }
  }
  const all = rs.flatMap((r) => r.utility.filter((u) => u.type !== "decoy"));
  const byType = (t: string) => all.filter((u) => u.type === t).length / rs.length;
  items.push({
    label: "NOTES",
    value: `${dec(all.length / rs.length, 1)} granater per runda (smoke ${dec(byType("smoke"), 1)}, flash ${dec(byType("flash"), 1)}, molotov ${dec(byType("molotov"), 1)}, HE ${dec(byType("he"), 1)})`,
    n: rs.length,
  });
  return { key: "utility", ...SECTION_META.utility, items };
}

function sectionExtra(inp: GameplanInput): GameplanSection {
  const items: GameplanItem[] = [];
  if (inp.side === "t") {
    const lurkers = mode(inp.rounds.map((r) => r.lurker).filter((x): x is string => !!x));
    if (lurkers) {
      const smokes = inp.rounds.flatMap((r) => r.utility.filter((u) => u.thrower === lurkers.value && u.type === "smoke"));
      const top = mode(smokes.map((u) => u.place).filter((x): x is string => !!x));
      items.push({
        label: "SMOKES · lurker",
        value: `${inp.nick(lurkers.value)} lurkar i ${pct(lurkers.count / Math.max(1, inp.rounds.length))} av T-rundorna${top ? ` · vanligaste smoke: ${prettyPlace(top.value)}` : ""}`,
        n: inp.rounds.length,
      });
    }
    // Fake: minst två granater mot ena siten, plant på den andra.
    const planted = inp.rounds.filter((r) => r.plantSite);
    const fakes = planted.filter((r) => {
      const otherSite = r.plantSite === "A" ? "B" : "A";
      return r.utility.filter((u) => siteOfPlace(u.place) === otherSite && u.sec < (r.plantSec ?? 999)).length >= 2;
    });
    if (planted.length) items.push({ label: "PLANS · fakes", value: `utility mot ena siten, plant på den andra i ${share(fakes.length, planted.length)}`, n: planted.length });
  } else {
    const stacks = inp.rounds.filter((r) => r.zones && /A[3-5]|B[3-5]/.test(r.zones));
    if (inp.rounds.length) items.push({ label: "PLANS · stacks", value: `3+ på samma site i ${share(stacks.length, inp.rounds.length)}`, n: inp.rounds.length });
  }
  return { key: "extra", ...SECTION_META.extra, items, empty: items.length ? undefined : "Inget att visa ur urvalet." };
}

function sectionAfterPause(inp: GameplanInput): GameplanSection {
  const after = inp.rounds.filter((r) => r.afterTimeout);
  const oppAfter = inp.rounds.filter((r) => r.oppTimeout);
  const base = rate(inp.rounds.filter((r) => r.won).length, inp.rounds.length);
  const items: GameplanItem[] = [];
  if (after.length) {
    const v = rate(after.filter((r) => r.won).length, after.length);
    items.push({ label: "Efter egen timeout", value: `vinst ${share(after.filter((r) => r.won).length, after.length)} (sidans snitt ${pct(base)})`, n: after.length, tone: v != null && base != null ? (v > base + 0.1 ? "pos" : v < base - 0.1 ? "neg" : undefined) : undefined });
    if (inp.side === "t") {
      const planted = after.filter((r) => r.plantSite);
      if (planted.length) items.push({ label: "Val efter timeout", value: `plant ${distribution(planted.map((r) => `${r.plantSite}-site`))}`, n: planted.length });
    } else {
      const z = mode(after.map((r) => r.zones).filter((x): x is string => !!x));
      if (z) items.push({ label: "Setup efter timeout", value: `${z.value} (${pct(z.count / after.length)})`, n: after.length });
    }
  }
  if (oppAfter.length) items.push({ label: "Efter motståndarens timeout", value: `vinst ${share(oppAfter.filter((r) => r.won).length, oppAfter.length)}`, n: oppAfter.length });
  return { key: "afterpause", ...SECTION_META.afterpause, items, empty: items.length ? undefined : "Inga timeouts på den här sidan i urvalet." };
}

function sectionBadStart(inp: GameplanInput): GameplanSection {
  const items: GameplanItem[] = [];
  const streak = inp.rounds.filter((r) => r.lossStreakBefore >= 3);
  const base = rate(inp.rounds.filter((r) => r.won).length, inp.rounds.length);
  if (streak.length) {
    items.push({ label: "Efter 3+ förlorade i rad", value: `vinst ${share(streak.filter((r) => r.won).length, streak.length)} (sidans snitt ${pct(base)})`, n: streak.length });
  }
  const pistols = inp.rounds.filter((r) => r.pistol);
  if (pistols.length) items.push({ label: "Pistol på sidan", value: `vinst ${share(pistols.filter((r) => r.won).length, pistols.length)}`, n: pistols.length });
  const withRounds = inp.maps.filter((m) => m.rounds && m.rounds.length > 0);
  const lostFirst = withRounds.filter((m) => m.rounds![0] && !m.rounds![0].won);
  if (lostFirst.length) items.push({ label: "Förlorad första pistol → kartan", value: `vann ${share(lostFirst.filter((m) => m.won).length, lostFirst.length)}`, n: lostFirst.length });
  const trailed = withRounds.filter((m) => {
    let f = 0,
      a = 0;
    for (const r of m.rounds!) {
      r.won ? f++ : a++;
      if (a - f >= 5) return true;
    }
    return false;
  });
  if (withRounds.length) items.push({ label: "Låg under med 5+ → vann ändå", value: trailed.length ? share(trailed.filter((m) => m.won).length, trailed.length) : "aldrig under med 5+", n: trailed.length });
  return { key: "badstart", ...SECTION_META.badstart, items, empty: items.length ? undefined : "För lite data i urvalet." };
}

function sectionSample(inp: GameplanInput, demoMaps: number): GameplanSection {
  const dates = inp.maps.map((m) => m.playedAt.getTime());
  return {
    key: "sample",
    ...SECTION_META.sample,
    items: [
      { label: "Officiella kartor", value: `${inp.maps.length} (varav ${demoMaps} med tolkad demo)`, n: inp.maps.length },
      { label: "Rundor på sidan", value: String(inp.rounds.length), n: inp.rounds.length },
      {
        label: "Period",
        value: dates.length ? `${new Date(Math.min(...dates)).toISOString().slice(0, 10)} – ${new Date(Math.max(...dates)).toISOString().slice(0, 10)} (senaste ${inp.months} mån)` : `senaste ${inp.months} mån`,
      },
    ],
  };
}

export function buildGameplan(inp: GameplanInput): GameplanReport {
  const demoMaps = new Set(inp.rounds.map((r) => r.mapId)).size;
  const sections: GameplanSection[] = [
    sectionPositions(inp),
    sectionLowbuys(inp),
    sectionAntieco(inp),
    sectionGameplan(inp),
    sectionFocus(inp),
    sectionBuyRounds(inp),
    sectionSetups(inp),
    sectionAwp(inp),
    sectionLast(inp),
    sectionUtility(inp),
    sectionExtra(inp),
    sectionAfterPause(inp),
    sectionBadStart(inp),
    { key: "reminders", ...SECTION_META.reminders, items: [] },
    sectionSample(inp, demoMaps),
  ];
  const dates = inp.maps.map((m) => m.playedAt.getTime());
  return {
    teamId: inp.teamId,
    teamName: inp.teamName,
    mapName: inp.mapName,
    mapLabel: mapLabel(inp.mapName),
    side: inp.side,
    opponentName: inp.opponentName ?? null,
    sections,
    sample: {
      maps: inp.maps.length,
      demoMaps,
      rounds: inp.rounds.length,
      months: inp.months,
      from: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      to: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    },
  };
}
