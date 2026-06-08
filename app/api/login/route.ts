import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/login — check the password, then set the session cookie (= AUTH_SECRET).
export async function POST(req: Request) {
  const secret = process.env.AUTH_SECRET;
  const expected = process.env.APP_PASSWORD;
  if (!secret || !expected) {
    return NextResponse.json(
      { ok: false, error: "Inloggning är inte konfigurerad på servern (AUTH_SECRET / APP_PASSWORD saknas)." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof body.password !== "string" || body.password !== expected) {
    return NextResponse.json({ ok: false, error: "Fel lösenord." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}

// DELETE /api/login — log out (clear the cookie).
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
