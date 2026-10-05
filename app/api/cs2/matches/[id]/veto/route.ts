import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { idParam, noCs2Db } from "@/lib/cs2/api";
import { MANUAL_STEP, buildManualVeto, type ManualVetoInput } from "@/lib/cs2/manualVeto";
import type { SeriesFormat } from "@/lib/cs2/types";

export const dynamic = "force-dynamic";

// PUT /api/cs2/matches/:id/veto { maps: [{ mapName, pickedBy }] } — kartorna
// inmatade för hand, i spelordning (sista = decider). Ersätter ett tidigare
// manuellt veto. HLTV:s eget veto går före: finns det redan nekas ändringen.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt match-id" }, { status: 400 });
  const m = await cs2Prisma.cs2Match.findUnique({ where: { id }, include: { vetoes: { select: { step: true } } } });
  if (!m || m.team1Id == null || m.team2Id == null) return NextResponse.json({ error: "Matchen finns inte eller lagen är inte klara" }, { status: 404 });
  if (m.vetoes.some((v) => v.step <= MANUAL_STEP)) {
    return NextResponse.json({ error: "HLTV:s veto är redan inläst — det används i stället." }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { maps?: ManualVetoInput[] };
  const format = (["bo1", "bo3", "bo5"].includes(m.format) ? m.format : "bo3") as SeriesFormat;
  const built = buildManualVeto(format, Array.isArray(body.maps) ? body.maps : [], [m.team1Id, m.team2Id]);
  if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 });
  const names = new Map([
    [m.team1Id, m.team1Name],
    [m.team2Id, m.team2Name],
  ]);
  await cs2Prisma.$transaction([
    cs2Prisma.cs2Veto.deleteMany({ where: { matchId: id } }),
    cs2Prisma.cs2Veto.createMany({
      data: built.rows.map((r) => ({ matchId: id, step: r.step, teamId: r.teamId, teamName: r.teamId ? names.get(r.teamId) ?? null : null, action: r.action, mapName: r.mapName })),
    }),
  ]);
  return NextResponse.json({ ok: true });
}

// DELETE /api/cs2/matches/:id/veto — tar bort ett manuellt veto (HLTV:s rörs inte).
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt match-id" }, { status: 400 });
  const { count } = await cs2Prisma.cs2Veto.deleteMany({ where: { matchId: id, step: { gt: MANUAL_STEP } } });
  return NextResponse.json({ ok: true, deleted: count });
}
