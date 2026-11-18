import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { summarizeFreshness, syncKind } from "@/lib/localJobs";

export const dynamic = "force-dynamic";

const JOB = /^(nba|cs2|shots):[a-z-]+$/;

// GET /api/freshness?job=cs2:update — när ett lokalt schemalagt jobb senast
// lyckades, ur SyncLog-raderna som scripts/runJob.ts skriver.
export async function GET(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  const job = new URL(req.url).searchParams.get("job") ?? "";
  if (!JOB.test(job)) return NextResponse.json({ ok: false, message: "Okänt jobb" }, { status: 400 });
  const rows = await prisma.syncLog.findMany({
    where: { kind: syncKind(job) },
    orderBy: { ranAt: "desc" },
    take: 20,
    select: { ranAt: true, summary: true },
  });
  return NextResponse.json(summarizeFreshness(rows, new Date()), { headers: { "Cache-Control": "no-store" } });
}
