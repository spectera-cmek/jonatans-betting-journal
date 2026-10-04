import { NextResponse } from "next/server";
import { getSessionUser, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { canonicalMap } from "@/lib/cs2/maps";
import { SECTION_KEYS } from "@/lib/cs2/gameplan";
import { noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

const MAX_NOTE = 4000;

// PUT /api/cs2/notes { teamId, mapName, side, section, text } — docens fritext.
// Tom text tar bort anteckningen. Anteckningar delas av alla konton på instansen.
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const teamId = Number(body.teamId);
  const mapName = canonicalMap(String(body.mapName ?? ""));
  const side = body.side === "ct" ? "ct" : body.side === "t" ? "t" : null;
  const section = String(body.section ?? "");
  const text = String(body.text ?? "").slice(0, MAX_NOTE);
  if (!Number.isInteger(teamId) || !mapName || !side || !(SECTION_KEYS as readonly string[]).includes(section)) {
    return NextResponse.json({ error: "Ogiltig anteckning" }, { status: 400 });
  }
  const where = { teamId_mapName_side_section: { teamId, mapName, side, section } };
  if (!text.trim()) {
    await cs2Prisma.cs2GameplanNote.delete({ where }).catch(() => null);
    return NextResponse.json({ ok: true, deleted: true });
  }
  const note = await cs2Prisma.cs2GameplanNote.upsert({
    where,
    create: { teamId, mapName, side, section, text, updatedBy: user.username },
    update: { text, updatedBy: user.username },
  });
  return NextResponse.json({ ok: true, updatedAt: note.updatedAt.toISOString(), updatedBy: note.updatedBy });
}
