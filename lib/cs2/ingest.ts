// Skriver tolkade HLTV-sidor till CS2-databasen. Idempotent: varje funktion
// kan köras om på samma sida utan dubbletter, och fält som sidan saknar
// skrivs aldrig över med null.
//
// Delas av scripts/cs2/ingest.ts och scripts/cs2/update.ts.

import type { PrismaClient } from ".prisma/cs2-client";
import type { HltvMapStats, HltvMatchPage, HltvRankedTeam, HltvTeamPage } from "./hltv/parse";
import { summarizeRounds } from "./hltv/parse";
import type { Side } from "./types";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Lag som syns i en match men inte finns ännu skapas obevakade ("vid behov"). */
async function ensureTeam(db: PrismaClient, id: number, name: string, slug?: string | null) {
  await db.cs2Team.upsert({
    where: { id },
    create: { id, name, slug: slug ?? null, tracked: false },
    update: { name, ...(slug ? { slug } : {}) },
  });
}

/**
 * Rankingen: topp `topN` blir bevakade, lag som fallit ur listan slutar
 * bevakas (men behåller sin historik). Trupperna sätts från rankingens lineup.
 */
export async function applyRanking(db: PrismaClient, ranked: HltvRankedTeam[], topN: number): Promise<number[]> {
  const top = ranked.filter((r) => r.rank <= topN);
  const ids = top.map((r) => r.team.id);
  await db.cs2Team.updateMany({ where: { tracked: true, id: { notIn: ids } }, data: { tracked: false } });
  for (const r of top) {
    await db.cs2Team.upsert({
      where: { id: r.team.id },
      create: { id: r.team.id, name: r.team.name, slug: r.team.slug, rank: r.rank, rankPoints: r.points, tracked: true },
      update: { name: r.team.name, slug: r.team.slug ?? undefined, rank: r.rank, rankPoints: r.points, tracked: true },
    });
    for (const p of r.players) {
      await db.cs2Player.upsert({
        where: { id: p.id },
        create: { id: p.id, nickname: p.nickname, teamId: r.team.id },
        update: { nickname: p.nickname, teamId: r.team.id },
      });
    }
  }
  return ids;
}

/** Lagsidan: namn, land och nuvarande trupp. Spelare som lämnat kopplas loss. */
export async function applyTeamPage(db: PrismaClient, teamId: number, page: HltvTeamPage): Promise<void> {
  await db.cs2Team.update({
    where: { id: teamId },
    data: {
      ...(page.name ? { name: page.name } : {}),
      ...(page.country ? { country: page.country } : {}),
      rosterFetchedAt: new Date(),
    },
  });
  if (page.players.length === 0) return; // trasig sida — rör inte truppen
  const ids = page.players.map((p) => p.id);
  await db.cs2Player.updateMany({ where: { teamId, id: { notIn: ids } }, data: { teamId: null } });
  for (const p of page.players) {
    await db.cs2Player.upsert({
      where: { id: p.id },
      create: { id: p.id, nickname: p.nickname, realName: p.realName, country: p.country, teamId },
      update: {
        nickname: p.nickname,
        teamId,
        ...(p.realName ? { realName: p.realName } : {}),
        ...(p.country ? { country: p.country } : {}),
      },
    });
  }
}

/** Halvlekarnas sidor → rundor per lag och sida (när HLTV markerat sidorna). */
export function sideRoundsFromHalves(
  halves: Array<{ team1: number; team2: number; team1Side: Side | null }>
): { team1Ct: number; team1T: number; team2Ct: number; team2T: number; team1StartSide: Side | null } | null {
  if (halves.length === 0 || halves.some((h) => h.team1Side == null)) return null;
  let team1Ct = 0,
    team1T = 0,
    team2Ct = 0,
    team2T = 0;
  for (const h of halves) {
    if (h.team1Side === "ct") {
      team1Ct += h.team1;
      team2T += h.team2;
    } else {
      team1T += h.team1;
      team2Ct += h.team2;
    }
  }
  return { team1Ct, team1T, team2Ct, team2T, team1StartSide: halves[0].team1Side };
}

/**
 * Matchsidan: serien, vetot och de spelade kartorna. Kartraderna skapas här
 * med resultat och halvlekar; mapstats-sidan fyller sedan på rundhistorik och
 * scoreboards (applyMapStats).
 */
export async function applyMatchPage(
  db: PrismaClient,
  matchId: number,
  slug: string | null,
  page: HltvMatchPage
): Promise<{ mapStatsIds: number[] }> {
  const t1 = page.team1;
  const t2 = page.team2;
  if (t1) await ensureTeam(db, t1.id, t1.name, t1.slug);
  if (t2) await ensureTeam(db, t2.id, t2.name, t2.slug);

  const startAt = page.startAt ?? new Date();
  const winnerId =
    page.status === "finished" && page.score1 != null && page.score2 != null && page.score1 !== page.score2
      ? page.score1 > page.score2
        ? t1?.id ?? null
        : t2?.id ?? null
      : null;

  const data = {
    slug,
    eventId: page.event?.id ?? null,
    eventName: page.event?.name ?? null,
    startAt,
    format: page.format ?? "bo3",
    team1Id: t1?.id ?? null,
    team2Id: t2?.id ?? null,
    team1Name: t1?.name ?? "TBD",
    team2Name: t2?.name ?? "TBD",
    score1: page.score1,
    score2: page.score2,
    winnerId,
    status: page.status,
    lan: page.lan,
    vetoText: page.vetoLines.length ? page.vetoLines.join("\n") : null,
    demoUrl: page.demoUrl,
    // En sida utan uppställningar (trasig eller TBD) skriver inte över en känd.
    ...(page.lineups.some((l) => l.teamId != null && l.players.length >= 5)
      ? { lineups: page.lineups.map((l) => ({ teamId: l.teamId, players: l.players })) }
      : {}),
    pageFetchedAt: new Date(),
  };
  const existing = await db.cs2Match.findUnique({ where: { id: matchId }, select: { demoStatus: true } });
  await db.cs2Match.upsert({
    where: { id: matchId },
    create: { id: matchId, ...data },
    // En demo som redan tolkats ska inte nollställas av en ny sidhämtning.
    update: { ...data, demoStatus: existing?.demoStatus ?? "none" },
  });

  // Vetot ersätts helt — det är en ögonblicksbild av sidan.
  if (page.vetoes.length > 0) {
    await db.cs2Veto.deleteMany({ where: { matchId } });
    const teamIdFor = (name: string | null) => {
      if (!name) return null;
      if (t1 && norm(name) === norm(t1.name)) return t1.id;
      if (t2 && norm(name) === norm(t2.name)) return t2.id;
      return null;
    };
    await db.cs2Veto.createMany({
      data: page.vetoes.map((v) => ({
        matchId,
        step: v.step,
        teamId: teamIdFor(v.teamName),
        teamName: v.teamName,
        action: v.action,
        mapName: v.mapName,
      })),
      skipDuplicates: true,
    });
  }

  const mapStatsIds: number[] = [];
  if (!t1 || !t2) return { mapStatsIds };
  for (const m of page.maps) {
    if (!m.played || m.mapStatsId == null || m.team1Score == null || m.team2Score == null) continue;
    mapStatsIds.push(m.mapStatsId);
    const sides = sideRoundsFromHalves(m.halves);
    const pickedVeto = page.vetoes.find((v) => v.action === "pick" && v.mapName === m.mapName);
    const pickedById =
      m.pickedBy === "team1"
        ? t1.id
        : m.pickedBy === "team2"
          ? t2.id
          : pickedVeto?.teamName
            ? norm(pickedVeto.teamName) === norm(t1.name)
              ? t1.id
              : norm(pickedVeto.teamName) === norm(t2.name)
                ? t2.id
                : null
            : null;
    const mapData = {
      matchId,
      mapNumber: m.mapNumber,
      mapName: m.mapName,
      playedAt: startAt,
      pickedById,
      team1Id: t1.id,
      team2Id: t2.id,
      team1Rounds: m.team1Score,
      team2Rounds: m.team2Score,
      otRounds: m.otRounds,
      winnerId: m.team1Score > m.team2Score ? t1.id : m.team2Score > m.team1Score ? t2.id : null,
      ...(sides
        ? {
            team1StartSide: sides.team1StartSide,
            team1CtRounds: sides.team1Ct,
            team1TRounds: sides.team1T,
            team2CtRounds: sides.team2Ct,
            team2TRounds: sides.team2T,
          }
        : {}),
    };
    await db.cs2Map.upsert({
      where: { id: m.mapStatsId },
      create: { id: m.mapStatsId, ...mapData },
      update: mapData,
    });
  }
  return { mapStatsIds };
}

/**
 * Mapstats-sidan: rundhistorik och scoreboards (all/ct/t). Lagordningen på
 * sidan kan skilja sig från matchsidans — den speglas då, så team1 alltid
 * betyder samma lag som i Cs2Map.
 */
export async function applyMapStats(db: PrismaClient, mapStatsId: number, stats: HltvMapStats): Promise<{ players: number }> {
  const map = await db.cs2Map.findUnique({ where: { id: mapStatsId } });
  if (!map) throw new Error(`Kartan ${mapStatsId} finns inte — hämta matchsidan först`);

  const swapped = stats.team1?.id === map.team2Id && stats.team2?.id === map.team1Id;
  const rounds = swapped
    ? stats.rounds.map((r) => ({ ...r, winner: r.winner === "team1" ? ("team2" as const) : ("team1" as const) }))
    : stats.rounds;
  const startSide: Side | null = stats.team1StartSide
    ? swapped
      ? stats.team1StartSide === "ct"
        ? "t"
        : "ct"
      : stats.team1StartSide
    : null;

  const sum = summarizeRounds(rounds);
  const consistent = rounds.length === map.team1Rounds + map.team2Rounds;
  await db.cs2Map.update({
    where: { id: mapStatsId },
    data: {
      ...(stats.playedAt ? { playedAt: stats.playedAt } : {}),
      ...(startSide ? { team1StartSide: startSide } : {}),
      // Rundhistoriken används bara om den går ihop med slutresultatet.
      ...(consistent && rounds.length > 0
        ? {
            roundHistory: rounds as unknown as object,
            team1CtRounds: sum.team1Ct,
            team1TRounds: sum.team1T,
            team2CtRounds: sum.team2Ct,
            team2TRounds: sum.team2T,
            otRounds: sum.otRounds,
          }
        : {}),
      statsFetchedAt: new Date(),
    },
  });

  if (stats.players.length === 0) return { players: 0 };
  await db.cs2PlayerMap.deleteMany({ where: { mapId: mapStatsId } });
  await db.cs2PlayerMap.createMany({
    data: stats.players.map((p) => ({
      mapId: mapStatsId,
      playerId: p.playerId,
      nickname: p.nickname,
      teamId: p.teamId,
      side: p.side,
      kills: p.kills,
      headshots: p.headshots,
      assists: p.assists,
      flashAssists: p.flashAssists,
      deaths: p.deaths,
      kast: p.kast,
      adr: p.adr,
      rating: p.rating,
      openingDiff: p.openingDiff,
    })),
    skipDuplicates: true,
  });
  // Spelare som inte setts förut skapas med laget de spelade för här.
  const seen = new Map<number, { nickname: string; teamId: number }>();
  for (const p of stats.players) if (p.side === "all") seen.set(p.playerId, { nickname: p.nickname, teamId: p.teamId });
  const existing = new Set(
    (await db.cs2Player.findMany({ where: { id: { in: [...seen.keys()] } }, select: { id: true } })).map((p) => p.id)
  );
  for (const [id, p] of seen) {
    if (existing.has(id)) continue;
    const teamKnown = await db.cs2Team.findUnique({ where: { id: p.teamId }, select: { id: true } });
    await db.cs2Player.create({ data: { id, nickname: p.nickname, teamId: teamKnown ? p.teamId : null } });
  }
  return { players: seen.size };
}
