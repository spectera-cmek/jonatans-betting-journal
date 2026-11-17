import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiUnauthorized, getSessionUserId } from "@/lib/auth";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/account/password — byt lösenord när du är inloggad.
export async function POST(req: Request) {
  const userId = getSessionUserId();
  if (!userId) return apiUnauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    currentPassword?: unknown;
    password?: unknown;
    passwordConfirm?: unknown;
  };
  if (
    typeof body.currentPassword !== "string" ||
    typeof body.password !== "string" ||
    typeof body.passwordConfirm !== "string"
  ) {
    return NextResponse.json({ ok: false, error: "Ogiltig förfrågan." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return apiUnauthorized();

  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
    return NextResponse.json({ ok: false, error: "Nuvarande lösenord stämmer inte." }, { status: 400 });
  }
  const passwordErr = validatePassword(body.password);
  if (passwordErr) return NextResponse.json({ ok: false, error: passwordErr }, { status: 400 });
  if (body.password !== body.passwordConfirm) {
    return NextResponse.json({ ok: false, error: "Lösenorden matchar inte." }, { status: 400 });
  }
  if (body.password === body.currentPassword) {
    return NextResponse.json({ ok: false, error: "Det nya lösenordet är samma som det gamla." }, { status: 400 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password) } });
  return NextResponse.json({ ok: true });
}
