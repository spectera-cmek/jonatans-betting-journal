// Demokön: välj serier, ladda ner, packa upp, tolka, spara, städa.
// Delas av scripts/cs2/demos.ts och scripts/cs2/update.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PrismaClient } from ".prisma/cs2-client";
import type { HltvSession } from "../hltv/session";
import { extractDemos } from "./archive";
import type { DemoparserApi } from "./parseDemo";
import { analyzeAndStore, loadNormalized, processDemoFiles, type ProcessResult } from "./process";
import { AVG_SERIES_GB, buildDemoQueue, type QueuedSeries } from "./queue";
import { DEMO_FACTS_VERSION } from "./types";

const DAY = 86_400_000;

export interface DemoRunOptions {
  confirm: boolean;
  /** Bara lag med en match inom `days` dagar. */
  upcomingOnly: boolean;
  days: number;
  teams: number[];
  perTeamMap: number;
  months: number;
  maxGb: number;
  maxSeries: number;
  keepDemos: boolean;
  retryFailed: boolean;
  cacheDir: string;
  /** Tolka om exakt dessa matcher, även om de redan är klara (--redo-match). */
  redoMatches?: number[];
}

export interface DemoRunSummary {
  queued: number;
  estimatedGb: number;
  processedSeries: number;
  processedMaps: number;
  downloadedGb: number;
  results: ProcessResult[];
  errors: string[];
  stoppedBy: "gb" | "series" | null;
}

type Log = (msg: string) => void;

async function teamsWithUpcoming(db: PrismaClient, days: number): Promise<number[]> {
  const now = new Date();
  const until = new Date(now.getTime() + days * DAY);
  const rows = await db.cs2Match.findMany({
    where: { status: { in: ["scheduled", "live"] }, startAt: { gte: new Date(now.getTime() - 6 * 3_600_000), lte: until } },
    select: { team1Id: true, team2Id: true },
  });
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.team1Id) ids.add(r.team1Id);
    if (r.team2Id) ids.add(r.team2Id);
  }
  return [...ids];
}

export async function planDemoQueue(db: PrismaClient, opts: DemoRunOptions): Promise<QueuedSeries[]> {
  if (opts.redoMatches?.length) {
    const rows = await db.cs2Match.findMany({
      where: { id: { in: opts.redoMatches }, demoUrl: { not: null } },
      select: { id: true, demoUrl: true, startAt: true, maps: { select: { id: true } } },
    });
    return rows.map((r) => ({ matchId: r.id, demoUrl: r.demoUrl!, maps: r.maps.map((m) => m.id), priority: false, playedAt: r.startAt }));
  }
  const upcoming = await teamsWithUpcoming(db, opts.days);
  let teams: number[];
  if (opts.teams.length > 0) teams = opts.teams;
  else if (opts.upcomingOnly) teams = upcoming;
  else {
    const tracked = await db.cs2Team.findMany({ where: { tracked: true }, select: { id: true } });
    teams = [...new Set([...upcoming, ...tracked.map((t) => t.id)])];
  }
  const since = new Date(Date.now() - opts.months * 30 * DAY);
  const rows = await db.cs2Map.findMany({
    where: { playedAt: { gte: since }, OR: [{ team1Id: { in: teams } }, { team2Id: { in: teams } }] },
    select: {
      id: true,
      matchId: true,
      mapName: true,
      playedAt: true,
      team1Id: true,
      team2Id: true,
      demoParsedAt: true,
      match: { select: { demoUrl: true, demoStatus: true } },
    },
  });
  return buildDemoQueue(
    rows.map((r) => ({
      mapId: r.id,
      matchId: r.matchId,
      mapName: r.mapName,
      playedAt: r.playedAt,
      team1Id: r.team1Id,
      team2Id: r.team2Id,
      demoParsedAt: r.demoParsedAt,
      demoUrl: r.match.demoUrl,
      demoStatus: r.match.demoStatus,
    })),
    { teams, priorityTeams: new Set(upcoming), perTeamMap: opts.perTeamMap, since, retryFailed: opts.retryFailed }
  );
}

export async function runDemoQueue(
  db: PrismaClient,
  session: HltvSession,
  api: DemoparserApi | null,
  opts: DemoRunOptions,
  log: Log
): Promise<DemoRunSummary> {
  const queue = await planDemoQueue(db, opts);
  const summary: DemoRunSummary = {
    queued: queue.length,
    estimatedGb: Math.round(queue.length * AVG_SERIES_GB * 10) / 10,
    processedSeries: 0,
    processedMaps: 0,
    downloadedGb: 0,
    results: [],
    errors: [],
    stoppedBy: null,
  };
  if (!opts.confirm || !api) return summary;

  const rawDir = path.join(opts.cacheDir, "demos", "raw");
  for (const series of queue) {
    if (summary.processedSeries >= opts.maxSeries) {
      summary.stoppedBy = "series";
      break;
    }
    if (summary.downloadedGb >= opts.maxGb) {
      summary.stoppedBy = "gb";
      break;
    }
    const dir = path.join(rawDir, String(series.matchId));
    try {
      log(`  ↓ match ${series.matchId} (${series.maps.length} kartor${series.priority ? ", kommande match" : ""})`);
      const archive = await session.downloadDemo(series.demoUrl, dir);
      const size = (await fs.stat(archive)).size;
      summary.downloadedGb += size / 1e9;
      const demos = await extractDemos(archive, dir);
      const { results, errors } = await processDemoFiles(db, api, demos, series.matchId, opts.cacheDir);
      summary.errors.push(...errors);
      const done = results.length;
      for (const res of results) {
        summary.processedMaps++;
        summary.results.push(res);
        const flags = [
          res.parts && res.parts > 1 ? `${res.parts} delar ihopfogade` : "",
          res.killDiffs.length ? `${res.killDiffs.length} kill-avvikelser` : "kills stämmer",
          res.roundsOk === false ? "rundor STÄMMER INTE" : res.roundsOk ? "rundor stämmer" : "",
          res.missingFields.length ? `saknade fält: ${res.missingFields.join(", ")}` : "",
        ].filter(Boolean);
        log(`    ✓ ${res.mapName}: ${res.rounds} rundor, ${res.linkedPlayers}/10 spelare länkade · ${flags.join(" · ")}`);
      }
      await db.cs2Match.update({
        where: { id: series.matchId },
        data: done > 0 ? { demoStatus: "done", demoError: null } : { demoStatus: "failed", demoError: "ingen karta i arkivet kunde tolkas" },
      });
      summary.processedSeries++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`match ${series.matchId}: ${msg}`);
      await db.cs2Match.update({
        where: { id: series.matchId },
        data: { demoStatus: /404|not found|saknas/i.test(msg) ? "unavailable" : "failed", demoError: msg.slice(0, 500) },
      });
    } finally {
      if (!opts.keepDemos) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  summary.downloadedGb = Math.round(summary.downloadedGb * 100) / 100;
  return summary;
}

/** Räkna om demofakta ur den lokala cachen — utan nedladdning. */
export async function reanalyzeCached(db: PrismaClient, cacheDir: string, onlyOutdated: boolean, log: Log): Promise<ProcessResult[]> {
  const maps = await db.cs2Map.findMany({
    where: onlyOutdated
      ? { demoParsedAt: { not: null }, OR: [{ demoVersion: null }, { demoVersion: { lt: DEMO_FACTS_VERSION } }] }
      : { demoParsedAt: { not: null } },
    select: { id: true },
  });
  const out: ProcessResult[] = [];
  let missing = 0;
  for (const m of maps) {
    const demo = await loadNormalized(cacheDir, m.id);
    if (!demo) {
      missing++;
      continue;
    }
    out.push(await analyzeAndStore(db, m.id, demo, { mergeGrid: false }));
  }
  log(`Omanalyserat ${out.length} kartor ur cachen (${missing} saknades lokalt).`);
  return out;
}
