import { NextResponse } from "next/server";
import { getSessionUser, getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { loadMatchupContext } from "@/lib/cs2/matchup";
import { saveLines } from "@/lib/cs2/lineStore";
import { validateLine } from "@/lib/cs2/lineInput";
import { noCs2Db } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// POST /api/cs2/lines — spara en eller flera bokmakarlinjer för en match.
// Body: en linje, eller { lines: [...] } (skärmdumpsimport). Varje linje
// prissätts direkt och modellens pris sparas som Cs2Projection, så att
// modellen kan utvärderas när kartan spelats.
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const raw = Array.isArray(body.lines) ? (body.lines as Record<string, unknown>[]) : [body];
  const valid = [];
  for (const r of raw) {
    const v = validateLine(r);
    if (typeof v === "string") return NextResponse.json({ error: v }, { status: 400 });
    valid.push(v);
  }
  if (valid.length === 0) return NextResponse.json({ error: "Inga linjer" }, { status: 400 });
  const matchId = valid[0].matchId;
  if (valid.some((v) => v.matchId !== matchId)) return NextResponse.json({ error: "Alla linjer måste gälla samma match" }, { status: 400 });

  const ctx = await loadMatchupContext(cs2Prisma, matchId);
  if (!ctx) return NextResponse.json({ error: "Matchen saknar lag eller data" }, { status: 404 });

  const out = await saveLines(cs2Prisma, ctx, valid, user.username);
  return NextResponse.json({ ok: true, lines: out });
}

// DELETE /api/cs2/lines?id=12 — ta bort en linje (projektionen står kvar).
export async function DELETE(req: Request) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Ogiltigt id" }, { status: 400 });
  await cs2Prisma.cs2Line.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
