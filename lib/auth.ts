// Multi-user session auth. The session cookie carries an HMAC-signed token
// (`base64url(userId).expiryEpochSec.base64url(signature)`) so the server can
// identify the user on every request without a DB hit. Signed with AUTH_SECRET —
// rotate it to invalidate all existing sessions. Runs in the Node runtime
// (server components + route handlers); we deliberately do NOT use Edge
// middleware, which kept failing to invoke on Vercel.

import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const SESSION_COOKIE = "bj_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// Constant-time string compare. Both sides are HMAC'd to a fixed length first,
// so neither content nor length leaks via timing.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "safe-equal").update(a).digest();
  const hb = createHmac("sha256", "safe-equal").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createSessionToken(userId: string, maxAgeSec: number = SESSION_MAX_AGE): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const exp = Math.floor(Date.now() / 1000) + maxAgeSec;
  const payload = `${Buffer.from(userId, "utf8").toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload, secret)}`;
}

// Returns the userId if the token is authentic and unexpired, else null.
// Old-format cookies (the pre-multi-user raw secret) fail the 3-part split.
export function verifySessionToken(token: string): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdB64, expStr, sig] = parts;
  if (!safeEqual(sig, sign(`${userIdB64}.${expStr}`, secret))) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const userId = Buffer.from(userIdB64, "base64url").toString("utf8");
  return userId || null;
}

// UserId from the current request's session cookie — no DB hit, so this is the
// per-request check for API routes. Call only inside a request scope.
export function getSessionUserId(): string | null {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}

// DB-backed variant for layout/UI: also confirms the user still exists.
export async function getSessionUser(): Promise<{ id: string; username: string } | null> {
  const userId = getSessionUserId();
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
}

export function sessionCookieOptions(maxAge: number = SESSION_MAX_AGE) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

// Standard 401 for protected API routes.
export function apiUnauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
