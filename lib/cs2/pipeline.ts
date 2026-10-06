// Inläsningsflödet mot HLTV, delat av scripts/cs2/ingest.ts och update.ts.
//
//   ranking → lagsidor (trupp + kommande matcher) → resultatlistor
//   → matchsidor (veto, kartor, demolänk) → mapstats (rundor, scoreboards)
//
// Motståndare utanför topplistan hämtas "vid behov": när de har en kommande
// match mot ett bevakat lag läses deras senaste resultat också in, så att
// modellen har något att räkna på.

import type { PrismaClient } from ".prisma/cs2-client";
import {
  parseMapStats,
  parseMatchPage,
  parseRanking,
  parseResults,
  parseTeamPage,
  resultsHasNextPage,
} from "./hltv/parse";
import { HltvBudgetError, type HltvSession } from "./hltv/session";
import { hltvUrls } from "./hltv/urls";
import { applyMapStats, applyMatchPage, applyRanking, applyTeamPage } from "./ingest";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface IngestOptions {
  confirm: boolean;
  topN: number;
  months: number;
  ranking: "vrs" | "hltv";
  /** Extra lag (HLTV-id) att läsa in oavsett ranking. */
  extraTeams: number[];
  /** Hoppa över rankingsteget och använd lagen som redan är bevakade. */
  skipRanking: boolean;
  /** Hur långt fram kommande matcher hämtas, och motståndare läses in. */
  upcomingDays: number;
}

export interface IngestSummary {
  trackedTeams: number;
  upcomingMatches: number;
  matchPagesNeeded: number;
  mapStatsNeeded: number;
  matchesWritten: number;
  mapsWritten: number;
  onDemandTeams: number;
  fetched: number;
  cacheHits: number;
  stoppedByBudget: boolean;
  errors: string[];
}

type Log = (msg: string) => void;

async function trackedTeamIds(db: PrismaClient): Promise<number[]> {
  const rows = await db.cs2Team.findMany({ where: { tracked: true }, orderBy: { rank: "asc" }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Matchid:n i ett lags resultatlista sedan `since`, sida för sida. */
/**
 * Matchsida för en match som resultatlistan säger är spelad. Sidan cachades
 * kanske medan matchen var kommande eller live — då står den kvar som
 * scheduled för alltid, så en sådan sida hämtas om.
 */
export async function playedMatchPage(session: Pick<HltvSession, "getHtml">, urlPath: string) {
  const page = parseMatchPage(await session.getHtml(urlPath, { maxAgeMs: Infinity }));
  if (page.status === "finished" || page.status === "cancelled") return page;
  return parseMatchPage(await session.getHtml(urlPath, { maxAgeMs: 0 }));
}

async function resultMatchIds(
  session: HltvSession,
  teamId: number,
  since: Date,
  log: Log
): Promise<Array<{ id: number; slug: string | null }>> {
  const out: Array<{ id: number; slug: string | null }> = [];
  const now = new Date();
  for (let offset = 0; offset < 1000; offset += 100) {
    // Första sidan ändras när laget spelar (dagens matcher ska med); äldre sidor är i praktiken fasta.
    const html = await session.getHtml(hltvUrls.teamResults(teamId, since, now, offset), {
      maxAgeMs: offset === 0 ? 3 * HOUR : 7 * DAY,
    });
    const items = parseResults(html);
    for (const it of items) out.push({ id: it.matchId, slug: it.slug });
    if (items.length < 100 || !resultsHasNextPage(html)) break;
  }
  if (out.length === 0) log(`    (inga resultat för lag ${teamId} sedan ${since.toISOString().slice(0, 10)})`);
  return out;
}

export async function runIngest(db: PrismaClient, session: HltvSession, opts: IngestOptions, log: Log): Promise<IngestSummary> {
  const summary: IngestSummary = {
    trackedTeams: 0,
    upcomingMatches: 0,
    matchPagesNeeded: 0,
    mapStatsNeeded: 0,
    matchesWritten: 0,
    mapsWritten: 0,
    onDemandTeams: 0,
    fetched: 0,
    cacheHits: 0,
    stoppedByBudget: false,
    errors: [],
  };
  const since = new Date(Date.now() - opts.months * 30 * DAY);

  try {
    // 1) Ranking → bevakade lag.
    let teamIds: number[];
    if (opts.skipRanking) {
      teamIds = await trackedTeamIds(db);
    } else {
      const url = opts.ranking === "vrs" ? hltvUrls.vrsRanking() : hltvUrls.hltvRanking();
      const ranked = parseRanking(await session.getHtml(url, { maxAgeMs: DAY }));
      if (ranked.length === 0) {
        summary.errors.push(`Rankingsidan (${url}) gav inga lag — parsern behöver ses över. Använder redan bevakade lag.`);
        teamIds = await trackedTeamIds(db);
      } else if (opts.confirm) {
        teamIds = await applyRanking(db, ranked, opts.topN);
      } else {
        teamIds = ranked.filter((r) => r.rank <= opts.topN).map((r) => r.team.id);
      }
      log(`Ranking (${opts.ranking}): ${ranked.length} lag, bevakar topp ${opts.topN}`);
    }
    for (const id of opts.extraTeams) if (!teamIds.includes(id)) teamIds.push(id);
    summary.trackedTeams = teamIds.length;

    // 2) Lagsidor: trupp + kommande matcher.
    const upcoming = new Map<number, { slug: string | null; startAt: Date | null }>();
    const horizon = Date.now() + opts.upcomingDays * DAY;
    for (const teamId of teamIds) {
      const team = await db.cs2Team.findUnique({ where: { id: teamId }, select: { slug: true, name: true } });
      const page = parseTeamPage(await session.getHtml(hltvUrls.team(teamId, team?.slug ?? "x"), { maxAgeMs: 12 * HOUR }));
      if (opts.confirm) {
        // Lag som bara kommer via --team blir "vid behov", inte bevakade.
        if (!team) await db.cs2Team.create({ data: { id: teamId, name: page.name ?? `team-${teamId}`, tracked: false } });
        await applyTeamPage(db, teamId, page);
      }
      for (const u of page.upcoming) {
        if (u.startAt && u.startAt.getTime() > horizon) continue;
        upcoming.set(u.matchId, { slug: u.slug, startAt: u.startAt });
      }
    }
    summary.upcomingMatches = upcoming.size;
    log(`Lagsidor klara: ${teamIds.length} lag, ${upcoming.size} kommande matcher inom ${opts.upcomingDays} dagar`);

    // 3) Resultatlistor → matcher som saknas eller inte är färdiga i DB.
    const wanted = new Map<number, string | null>();
    for (const teamId of teamIds) {
      for (const r of await resultMatchIds(session, teamId, since, log)) wanted.set(r.id, r.slug);
    }

    // 4) Kommande matcher först — de avgör vilka motståndare som behövs.
    const opponents = new Set<number>();
    for (const [matchId, { slug, startAt }] of upcoming) {
      // Vetot publiceras strax före start — då får sidan bara vara 10 min gammal.
      const startsSoon = startAt != null && startAt.getTime() - Date.now() < 3 * HOUR;
      const html = await session.getHtml(hltvUrls.match(matchId, slug ?? "x"), { maxAgeMs: startsSoon ? 10 * 60_000 : 2 * HOUR });
      const page = parseMatchPage(html);
      if (opts.confirm) await applyMatchPage(db, matchId, slug, page);
      for (const t of [page.team1, page.team2]) if (t && !teamIds.includes(t.id)) opponents.add(t.id);
    }
    summary.onDemandTeams = opponents.size;
    if (opponents.size > 0) log(`Vid behov: ${opponents.size} motståndare utanför topplistan läses också in`);
    for (const teamId of opponents) {
      for (const r of await resultMatchIds(session, teamId, since, log)) wanted.set(r.id, r.slug);
    }

    const known = new Map(
      (
        await db.cs2Match.findMany({
          where: { id: { in: [...wanted.keys()] } },
          select: { id: true, status: true, pageFetchedAt: true },
        })
      ).map((m) => [m.id, m])
    );
    const toFetch = [...wanted.entries()].filter(([id]) => {
      const k = known.get(id);
      return !k || k.status !== "finished" || !k.pageFetchedAt;
    });
    summary.matchPagesNeeded = toFetch.length;

    const pendingMaps = await db.cs2Map.count({ where: { statsFetchedAt: null } });
    if (!opts.confirm) {
      // Grov uppskattning: ~2,3 kartor per serie i bo3-dominerade scheman.
      summary.mapStatsNeeded = pendingMaps + Math.round(toFetch.length * 2.3);
      return summary;
    }

    // 5) Matchsidor.
    let i = 0;
    for (const [matchId, slug] of toFetch) {
      i++;
      try {
        const page = await playedMatchPage(session, hltvUrls.match(matchId, slug ?? "x"));
        if (!page.team1 || !page.team2) {
          summary.errors.push(`Match ${matchId}: lagen gick inte att läsa`);
          continue;
        }
        await applyMatchPage(db, matchId, slug, page);
        summary.matchesWritten++;
        if (i % 25 === 0) log(`  … matchsidor ${i}/${toFetch.length}`);
      } catch (err) {
        if (err instanceof HltvBudgetError) throw err;
        summary.errors.push(`Match ${matchId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 6) Mapstats för alla kartor som saknar statistik.
    const maps = await db.cs2Map.findMany({ where: { statsFetchedAt: null }, select: { id: true }, orderBy: { playedAt: "desc" } });
    summary.mapStatsNeeded = maps.length;
    let j = 0;
    for (const m of maps) {
      j++;
      try {
        const stats = parseMapStats(await session.getHtml(hltvUrls.mapStats(m.id), { maxAgeMs: Infinity }));
        if (stats.players.length === 0) {
          summary.errors.push(`Karta ${m.id}: inga scoreboards hittades`);
          continue;
        }
        await applyMapStats(db, m.id, stats);
        summary.mapsWritten++;
        if (j % 25 === 0) log(`  … mapstats ${j}/${maps.length}`);
      } catch (err) {
        if (err instanceof HltvBudgetError) throw err;
        summary.errors.push(`Karta ${m.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    if (!(err instanceof HltvBudgetError)) throw err;
    summary.stoppedByBudget = true;
    log(err.message);
  } finally {
    summary.fetched = session.fetched;
    summary.cacheHits = session.cacheHits;
  }
  return summary;
}

/**
 * Tolkar om allt som redan finns i cachen — utan nätverk. Används efter en
 * parserrättning: `npm run cs2:ingest -- --reparse --confirm`.
 */
export async function runReparse(db: PrismaClient, session: HltvSession, log: Log): Promise<{ matches: number; maps: number; missing: number }> {
  let matches = 0,
    maps = 0,
    missing = 0;
  const all = await db.cs2Match.findMany({ select: { id: true, slug: true } });
  for (const m of all) {
    try {
      const page = parseMatchPage(await session.getHtml(hltvUrls.match(m.id, m.slug ?? "x")));
      if (page.team1 && page.team2) {
        await applyMatchPage(db, m.id, m.slug, page);
        matches++;
      }
    } catch {
      missing++;
    }
  }
  const allMaps = await db.cs2Map.findMany({ select: { id: true } });
  for (const m of allMaps) {
    try {
      const stats = parseMapStats(await session.getHtml(hltvUrls.mapStats(m.id)));
      if (stats.players.length > 0) {
        await applyMapStats(db, m.id, stats);
        maps++;
      }
    } catch {
      missing++;
    }
  }
  log(`Omtolkat ur cachen: ${matches} matcher, ${maps} kartor (${missing} saknades i cachen)`);
  return { matches, maps, missing };
}
