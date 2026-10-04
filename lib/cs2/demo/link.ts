// Kopplar demons spelare (steamId + namn) till HLTV-spelare, och demons lag
// "A"/"B" till HLTV-lag.
//
// Spelarnamnen i en demo är oftast nicken, ibland med lag-tagg ("Vitality |
// ZywOo") eller sponsor. Matchningen görs mot kartans tio spelare från
// HLTV-scoreboarden — det är ett litet, känt urval, så en tolerant jämförelse
// räcker och felmatchningar syns direkt i valideringen (kills ska stämma).

import type { DemoTeam } from "./analyze";

export interface LineupPlayer {
  playerId: number;
  nickname: string;
  teamId: number;
}

export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Levenshtein-avstånd, för små stavningsskillnader (0 ↔ o, l ↔ 1). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Hur bra ett demonamn passar en nick. Lägre är bättre; null = ingen träff. */
export function nameScore(demoName: string, nick: string): number | null {
  const d = normName(demoName);
  const n = normName(nick);
  if (!d || !n) return null;
  if (d === n) return 0;
  // Taggar runt nicken: "vitalityzywoo", "zywoobetway".
  if (n.length >= 3 && d.includes(n)) return 1;
  if (d.length >= 3 && n.includes(d)) return 2;
  const dist = editDistance(d, n);
  if (dist <= Math.max(1, Math.floor(n.length / 4))) return 2 + dist;
  return null;
}

/**
 * steamId → HLTV-spelare. Redan kända länkar vinner. Övriga matchas girigt på
 * bästa namnpoäng, en HLTV-spelare per steamId.
 */
export function linkPlayers(
  demoPlayers: Array<{ steamId: string; name: string }>,
  lineup: LineupPlayer[],
  known: Map<string, number>
): Map<string, LineupPlayer> {
  const out = new Map<string, LineupPlayer>();
  const used = new Set<number>();
  for (const p of demoPlayers) {
    const pid = known.get(p.steamId);
    const hit = pid != null ? lineup.find((l) => l.playerId === pid) : undefined;
    if (hit) {
      out.set(p.steamId, hit);
      used.add(hit.playerId);
    }
  }
  const candidates: Array<{ steamId: string; player: LineupPlayer; score: number }> = [];
  for (const p of demoPlayers) {
    if (out.has(p.steamId)) continue;
    for (const l of lineup) {
      if (used.has(l.playerId)) continue;
      const s = nameScore(p.name, l.nickname);
      if (s != null) candidates.push({ steamId: p.steamId, player: l, score: s });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  for (const c of candidates) {
    if (out.has(c.steamId) || used.has(c.player.playerId)) continue;
    out.set(c.steamId, c.player);
    used.add(c.player.playerId);
  }
  return out;
}

/**
 * Demolag → HLTV-lag genom majoritet bland de länkade spelarna. Faller
 * tillbaka på lagnamnet i demon (team_clan_name) när länkarna inte räcker.
 */
export function linkTeams(
  teamOf: Record<string, DemoTeam>,
  links: Map<string, LineupPlayer>,
  clans: Map<string, string | null>,
  hltvTeams: Array<{ id: number; name: string }>
): Record<DemoTeam, number | null> {
  const votes: Record<DemoTeam, Map<number, number>> = { A: new Map(), B: new Map() };
  for (const [steamId, team] of Object.entries(teamOf)) {
    const l = links.get(steamId);
    if (!l) continue;
    votes[team].set(l.teamId, (votes[team].get(l.teamId) ?? 0) + 1);
  }
  const top = (m: Map<number, number>): number | null => {
    const sorted = [...m.entries()].sort((x, y) => y[1] - x[1]);
    return sorted.length ? sorted[0][0] : null;
  };
  let a: number | null = top(votes.A);
  let b: number | null = top(votes.B);

  const byClan = (team: DemoTeam): number | null => {
    const names = Object.entries(teamOf)
      .filter(([, t]) => t === team)
      .map(([id]) => clans.get(id))
      .filter((c): c is string => !!c);
    for (const c of names) {
      const hit = hltvTeams.find((t) => normName(t.name) === normName(c) || nameScore(c, t.name) != null);
      if (hit) return hit.id;
    }
    return null;
  };
  if (a == null) a = byClan("A");
  if (b == null) b = byClan("B");
  // Två lag i en karta: känner vi det ena är det andra givet.
  if (a != null && b == null) b = hltvTeams.find((t) => t.id !== a)?.id ?? null;
  if (b != null && a == null) a = hltvTeams.find((t) => t.id !== b)?.id ?? null;
  if (a != null && a === b) b = hltvTeams.find((t) => t.id !== a)?.id ?? null;
  return { A: a, B: b };
}
