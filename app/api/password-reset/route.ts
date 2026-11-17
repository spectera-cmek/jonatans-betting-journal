import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "@/lib/auth";
import { hashPassword, validatePassword } from "@/lib/password";
import { resetTokenUserId, verifyResetToken } from "@/lib/passwordReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVALID = "Länken är ogiltig eller redan använd. Be om en ny.";

// POST /api/password-reset — sätt nytt lösenord med en återställningslänk och logga in.
export async function POST(req: Request) {
  if (!process.env.AUTH_SECRET) {
    return NextResponse.json({ ok: false, error: "Inloggning är inte konfigurerad på servern." }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown;
    password?: unknown;
    passwordConfirm?: unknown;
  };
  if (typeof body.token !== "string" || typeof body.password !== "string" || typeof body.passwordConfirm !== "string") {
    return NextResponse.json({ ok: false, error: "Ogiltig förfrågan." }, { status: 400 });
  }

  const userId = resetTokenUserId(body.token);
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!user) return NextResponse.json({ ok: false, error: INVALID }, { status: 400 });

  const check = verifyResetToken(body.token, user.passwordHash);
  if (!check.ok) {
    const error = check.reason === "expired" ? "Länken har gått ut. Be om en ny." : INVALID;
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }

  const passwordErr = validatePassword(body.password);
  if (passwordErr) return NextResponse.json({ ok: false, error: passwordErr }, { status: 400 });
  if (body.password !== body.passwordConfirm) {
    return NextResponse.json({ ok: false, error: "Lösenorden matchar inte." }, { status: 400 });
  }

  // Ny hash = länken slutar gälla (signaturen täcker den gamla).
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password) } });

  const res = NextResponse.json({ ok: true, username: user.username });
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
  return res;
}
