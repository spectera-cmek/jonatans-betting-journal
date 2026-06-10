import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions, safeEqual } from "@/lib/auth";
import { hashPassword, validatePassword, validateUsername } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/register — create an account (gated by INVITE_CODE), then log in.
export async function POST(req: Request) {
  const inviteCode = process.env.INVITE_CODE;
  if (!process.env.AUTH_SECRET || !inviteCode) {
    return NextResponse.json(
      { ok: false, error: "Registrering är inte konfigurerad på servern." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    username?: unknown;
    password?: unknown;
    passwordConfirm?: unknown;
    inviteCode?: unknown;
  };
  if (
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    typeof body.passwordConfirm !== "string" ||
    typeof body.inviteCode !== "string"
  ) {
    return NextResponse.json({ ok: false, error: "Ogiltig förfrågan." }, { status: 400 });
  }

  if (!safeEqual(body.inviteCode.trim(), inviteCode)) {
    return NextResponse.json({ ok: false, error: "Fel inbjudningskod." }, { status: 401 });
  }

  const username = body.username.trim().toLowerCase();
  const usernameErr = validateUsername(username);
  if (usernameErr) return NextResponse.json({ ok: false, error: usernameErr }, { status: 400 });

  const passwordErr = validatePassword(body.password);
  if (passwordErr) return NextResponse.json({ ok: false, error: passwordErr }, { status: 400 });

  if (body.password !== body.passwordConfirm) {
    return NextResponse.json({ ok: false, error: "Lösenorden matchar inte." }, { status: 400 });
  }

  let user;
  try {
    user = await prisma.user.create({
      data: { username, passwordHash: await hashPassword(body.password) },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ ok: false, error: "Användarnamnet är upptaget." }, { status: 409 });
    }
    throw e;
  }
  await prisma.setting.create({ data: { userId: user.id } });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
  return res;
}
