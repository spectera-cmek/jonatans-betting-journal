import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runClosingNearKickoff, runGradeByScores, runClosing, type SyncResult } from "@/lib/sync";

export const dynamic = "force-dynamic";
// Same ceiling as /api/sync. The runners batch their work to stay under it.
export const maxDuration = 60;

/**
 * Scheduled sync, authenticated by a shared secret rather than a browser
 * session.
 *
 * /api/sync requires a signed session cookie, so nothing outside a logged-in
 * browser could ever trigger it. The only automation was a Windows scheduled
 * task that needs a specific machine to be powered on and interactively logged
 * in — which is why closing-odds coverage sat at 5 % of the journal.
 *
 * Grading is deliberately global: it settles pending bets for every account
 * against objective final scores, exactly as /api/sync does.
 *
 * Jobs:
 *   clv     near-kickoff closing capture via The Odds API (the T-30…T+5 window)
 *   grade   settle finished events from the free ESPN scoreboard
 *   closing retroactive closing odds via TheStatsAPI (slower, wider net)
 */
const JOBS: Record<string, () => Promise<SyncResult>> = {
  clv: () => runClosingNearKickoff(),
  // Tagged "cron" so /rattning can show what the night settled on its own.
  grade: () => runGradeByScores({ source: "cron" }),
  closing: () => runClosing(),
};

export async function GET(req: Request, { params }: { params: { job: string } }) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed. Without a secret configured the endpoint would be an open
    // trigger for third-party API spend.
    return NextResponse.json(
      { ok: false, message: "CRON_SECRET is not set — scheduled sync is disabled." },
      { status: 503 }
    );
  }

  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. An external
  // scheduler can send the same header, or ?key= for schedulers that cannot.
  const auth = req.headers.get("authorization");
  const key = new URL(req.url).searchParams.get("key");
  if (auth !== `Bearer ${secret}` && key !== secret) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const run = JOBS[params.job];
  if (!run) {
    return NextResponse.json(
      { ok: false, message: `Unknown job "${params.job}". Try: ${Object.keys(JOBS).join(", ")}` },
      { status: 404 }
    );
  }

  // Every run leaves a `cron:<job>` row, empty or failed ones included. The
  // runners only log when they changed something, so without this a quiet
  // night and a cron that never fired look identical — which is how a month
  // of failed closing captures went unnoticed before.
  try {
    const result = await run();
    await logRun(params.job, result.message || "ok");
    return NextResponse.json({ job: params.job, ...result });
  } catch (e) {
    console.error(`cron/${params.job}`, e);
    await logRun(params.job, `FEL: ${(e as Error).message}`);
    return NextResponse.json(
      { ok: false, job: params.job, message: (e as Error).message },
      { status: 500 }
    );
  }
}

async function logRun(job: string, summary: string) {
  try {
    await prisma.syncLog.create({ data: { kind: `cron:${job}`, summary: summary.slice(0, 500) } });
  } catch (e) {
    console.error(`cron/${job}: could not write syncLog`, e);
  }
}
