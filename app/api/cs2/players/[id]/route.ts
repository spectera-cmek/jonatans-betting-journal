import { NextResponse } from "next/server";
import { getSessionUserId, apiUnauthorized } from "@/lib/auth";
import { cs2Prisma, hasCs2Db } from "@/lib/cs2Db";
import { loadPlayer } from "@/lib/cs2/queries";
import { ROLE_LABEL } from "@/lib/cs2/roles";
import { CS2_NO_STORE, idParam, noCs2Db, windowFrom } from "@/lib/cs2/api";

export const dynamic = "force-dynamic";

// GET /api/cs2/players/:id — siffror per karta och sida, demofakta, senaste kartor.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt spelar-id" }, { status: 400 });
  const data = await loadPlayer(cs2Prisma, id, windowFrom(new URL(req.url)));
  if (!data) return NextResponse.json({ error: "Spelaren finns inte" }, { status: 404 });
  return NextResponse.json({ dbConfigured: true, ...data }, CS2_NO_STORE);
}

// PATCH /api/cs2/players/:id { role: "awper" | … | null } — rätta den härledda rollen.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!getSessionUserId()) return apiUnauthorized();
  if (!hasCs2Db()) return noCs2Db();
  const id = idParam(params.id);
  if (id == null) return NextResponse.json({ error: "Ogiltigt spelar-id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { role?: unknown };
  const role = body.role == null || body.role === "" ? null : String(body.role);
  if (role !== null && !(role in ROLE_LABEL)) return NextResponse.json({ error: "Okänd roll" }, { status: 400 });
  const p = await cs2Prisma.cs2Player.update({ where: { id }, data: { roleManual: role } }).catch(() => null);
  if (!p) return NextResponse.json({ error: "Spelaren finns inte" }, { status: 404 });
  return NextResponse.json({ ok: true, role: p.roleManual ?? p.roleDerived });
}
