import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from ".prisma/cs2-client";
import { runQueuedDemos, type DemoRunOptions } from "../lib/cs2/demo/run";
import type { QueuedSeries } from "../lib/cs2/demo/queue";
import { HltvBlockedError, type HltvSession } from "../lib/cs2/hltv/session";

const series = (matchId: number): QueuedSeries => ({ matchId, demoUrl: `/download/demo/${matchId}`, maps: [1], priority: true, tier: 0, playedAt: new Date() });
const opts: DemoRunOptions = {
  confirm: true, upcomingOnly: true, days: 7, teams: [], perTeamMap: 10, months: 4, maxGb: 15, maxSeries: 25,
  keepDemos: false, retryFailed: false, cacheDir: path.join(os.tmpdir(), "cs2-demo-run-test"),
};

function fakeDb() {
  const updates: Array<{ id: number; demoStatus: string }> = [];
  const db = { cs2Match: { update: async (a: { where: { id: number }; data: { demoStatus: string } }) => { updates.push({ id: a.where.id, demoStatus: a.data.demoStatus }); return {}; } } };
  return { db: db as unknown as PrismaClient, updates };
}

describe("demosteget när Cloudflare blockerar", () => {
  it("ger upp efter fem stopp i rad och markerar inga matcher som misslyckade", async () => {
    const { db, updates } = fakeDb();
    let calls = 0;
    const session = { downloadDemo: async () => { calls++; throw new HltvBlockedError("https://www.hltv.org/"); }, restart: async () => {} };
    const s = await runQueuedDemos(db, session as unknown as HltvSession, {} as never, [1, 2, 3, 4, 5, 6, 7, 8].map(series), opts, () => {});
    expect(calls).toBe(5);
    expect(s.stoppedBy).toBe("blocked");
    expect(updates).toEqual([]);
  });

  it("andra fel räknas inte som stopp och markeras som förut", async () => {
    const { db, updates } = fakeDb();
    let calls = 0;
    const session = {
      downloadDemo: async () => {
        calls++;
        if (calls === 3) throw new Error("404 från HLTV: /download/demo/3");
        throw new HltvBlockedError("https://www.hltv.org/");
      },
      restart: async () => {},
    };
    const s = await runQueuedDemos(db, session as unknown as HltvSession, {} as never, [1, 2, 3, 4, 5, 6, 7, 8, 9].map(series), opts, () => {});
    expect(calls).toBe(8); // 2 stopp, ett 404 som nollställer, sedan 5 stopp i rad
    expect(s.stoppedBy).toBe("blocked");
    expect(updates).toEqual([{ id: 3, demoStatus: "unavailable" }]);
  });
});
