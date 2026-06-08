import { NextResponse, type NextRequest } from "next/server";

// NOTE: the session-cookie verification is inlined here instead of imported from
// @/lib/auth. Middleware runs in the Edge runtime, and Vercel's Edge bundler can fail
// to bundle middleware's module imports ("referencing unsupported modules: @/lib/auth").
// Keeping this self-contained avoids that. lib/auth.ts holds the matching *sign* side
// used by the Node-runtime /api/login route — keep the cookie name + HMAC in sync.

const SESSION_COOKIE = "bj_session";
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64url(new Uint8Array(sig));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySessionToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false;
  const expected = await hmac(secret, exp);
  return safeEqual(sig, expected);
}

// Protect everything except: the login page/route, Next internals, and public
// PWA assets (manifest + icons must load before you're signed in).
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|robots.txt).*)",
  ],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/login" || pathname === "/api/login") {
    return NextResponse.next();
  }

  const secret = process.env.AUTH_SECRET;
  const password = process.env.APP_PASSWORD;

  // Auth not configured (e.g. local dev without secrets) → don't lock anyone out.
  // In production on Vercel, set AUTH_SECRET + APP_PASSWORD so this gate is active.
  if (!secret || !password) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, secret)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}
