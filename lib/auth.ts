// Single-user session auth. The session cookie's value is the AUTH_SECRET itself
// (a long random string) — possessing it == being authenticated. No crypto, so it
// stays trivially fast. Runs in the Node runtime (server components + route
// handlers); we deliberately do NOT use Edge middleware, which kept failing to
// invoke on Vercel. Rotate AUTH_SECRET to invalidate all existing sessions.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "bj_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Constant-time-ish compare (avoid leaking via early mismatch).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// True if the current request carries a valid session cookie. When auth isn't
// configured (no AUTH_SECRET / APP_PASSWORD — e.g. local dev) it returns true so
// nobody gets locked out. Call only inside a request scope (server component or
// route handler), since it reads cookies().
export function isAuthed(): boolean {
  const secret = process.env.AUTH_SECRET;
  const password = process.env.APP_PASSWORD;
  if (!secret || !password) return true;
  const token = cookies().get(SESSION_COOKIE)?.value;
  return !!token && safeEqual(token, secret);
}

// Standard 401 for protected API routes.
export function apiUnauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
