import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { verifyPassword, verifyDummy } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/login — verify username + password, then set the signed session cookie.
export async function POST(req: Request) {
  if (!process.env.AUTH_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Inloggning är inte konfigurerad på servern (AUTH_SECRET saknas)." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ ok: false, error: "Fel användarnamn eller lösenord." }, { status: 401 });
  }

  const username = body.username.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { username } });

  // Always run a bcrypt compare, so an unknown username takes as long as a
  // wrong password (no account enumeration via timing).
  let ok = false;
  if (user) ok = await verifyPassword(body.password, user.passwordHash);
  else await verifyDummy(body.password);

  if (!user || !ok) {
    return NextResponse.json({ ok: false, error: "Fel användarnamn eller lösenord." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
  return res;
}

// DELETE /api/login — log out (clear the cookie).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
