// Spelarroller härledda ur demofakta — docens POSITIONS ("AWP", "SPOT 1–4")
// och den roll kills-modellen lutar sig mot.
//
// Rollerna delas ut inom laget, inte mot absoluta trösklar: det finns alltid
// en spelare som tar flest öppningsdueller på T-sidan, även i ett passivt lag.
// En egen rättning (roleManual) vinner alltid i UI:t.

import type { PrismaClient } from ".prisma/cs2-client";
import type { PlayerSideFacts } from "./demo/types";

export type Role = "awper" | "entry" | "lurker" | "anchor" | "support" | "rifler";

export const ROLE_LABEL: Record<Role, string> = {
  awper: "AWP",
  entry: "Entry",
  lurker: "Lurker",
  anchor: "Ankare",
  support: "Support",
  rifler: "Rifler",
};

export interface RoleInput {
  playerId: number;
  teamId: number;
  ct: Pick<PlayerSideFacts, "rounds" | "awpRounds" | "siteRounds" | "util" | "flashAssists" | "openingAttempts">;
  t: Pick<PlayerSideFacts, "rounds" | "awpRounds" | "lurkRounds" | "util" | "flashAssists" | "openingAttempts">;
}

const rate = (n: number, d: number) => (d > 0 ? n / d : 0);

/** Minsta antal rundor innan en roll alls delas ut. */
export const ROLE_MIN_ROUNDS = 40;

export function deriveRoles(players: RoleInput[]): Map<number, Role> {
  const out = new Map<number, Role>();
  const byTeam = new Map<number, RoleInput[]>();
  for (const p of players) {
    if (p.ct.rounds + p.t.rounds < ROLE_MIN_ROUNDS) continue;
    const list = byTeam.get(p.teamId);
    if (list) list.push(p);
    else byTeam.set(p.teamId, [p]);
  }
  for (const team of byTeam.values()) {
    const left = new Set(team);
    const take = (score: (p: RoleInput) => number, role: Role, min: number) => {
      let best: RoleInput | null = null;
      let bestScore = min;
      for (const p of left) {
        const s = score(p);
        if (s > bestScore) {
          best = p;
          bestScore = s;
        }
      }
      if (best) {
        out.set(best.playerId, role);
        left.delete(best);
      }
    };
    take((p) => rate(p.ct.awpRounds + p.t.awpRounds, p.ct.rounds + p.t.rounds), "awper", 0.35);
    take((p) => rate(p.t.openingAttempts, p.t.rounds), "entry", 0.12);
    take((p) => rate(p.t.lurkRounds, p.t.rounds), "lurker", 0.2);
    take((p) => rate(p.ct.siteRounds, p.ct.rounds), "anchor", 0.4);
    take((p) => rate(p.ct.util.flash + p.t.util.flash + 2 * (p.ct.flashAssists + p.t.flashAssists), p.ct.rounds + p.t.rounds), "support", 0.6);
    for (const p of left) out.set(p.playerId, "rifler");
  }
  return out;
}

/** Summerar demofakta per spelare och sida (bara de fält rollerna läser). */
export function sumRoleFacts(rows: Array<{ side: string; facts: PlayerSideFacts }>): Pick<RoleInput, "ct" | "t"> {
  const zero = () => ({
    rounds: 0,
    awpRounds: 0,
    siteRounds: 0,
    lurkRounds: 0,
    flashAssists: 0,
    openingAttempts: 0,
    util: { smoke: 0, flash: 0, molotov: 0, he: 0, decoy: 0 },
  });
  const acc = { ct: zero(), t: zero() };
  for (const r of rows) {
    const s = r.side === "ct" ? acc.ct : acc.t;
    const f = r.facts;
    s.rounds += f.rounds;
    s.awpRounds += f.awpRounds;
    s.siteRounds += f.siteRounds;
    s.lurkRounds += f.lurkRounds;
    s.flashAssists += f.flashAssists;
    s.openingAttempts += f.openingAttempts;
    for (const k of Object.keys(s.util) as Array<keyof typeof s.util>) s.util[k] += f.util?.[k] ?? 0;
  }
  return acc;
}

/** Räknar om roleDerived för alla spelare med demofakta senaste 120 dagarna. */
export async function updateDerivedRoles(db: PrismaClient, days = 120): Promise<number> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.cs2DemoPlayerMap.findMany({
    where: { playerId: { not: null }, teamId: { not: null }, map: { playedAt: { gte: since } } },
    select: { playerId: true, teamId: true, side: true, facts: true },
  });
  const players = await db.cs2Player.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.playerId!))] } }, select: { id: true, teamId: true } });
  const currentTeam = new Map(players.map((p) => [p.id, p.teamId]));

  const grouped = new Map<number, Array<{ side: string; facts: PlayerSideFacts }>>();
  for (const r of rows) {
    // Bara rader från spelarens nuvarande lag — roller följer laget.
    if (currentTeam.get(r.playerId!) !== r.teamId) continue;
    const list = grouped.get(r.playerId!);
    const item = { side: r.side, facts: r.facts as unknown as PlayerSideFacts };
    if (list) list.push(item);
    else grouped.set(r.playerId!, [item]);
  }
  const inputs: RoleInput[] = [];
  for (const [playerId, list] of grouped) {
    const teamId = currentTeam.get(playerId);
    if (teamId == null) continue;
    inputs.push({ playerId, teamId, ...sumRoleFacts(list) });
  }
  const roles = deriveRoles(inputs);
  for (const [playerId, role] of roles) await db.cs2Player.update({ where: { id: playerId }, data: { roleDerived: role } });
  return roles.size;
}
