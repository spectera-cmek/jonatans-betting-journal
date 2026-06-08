import { NextResponse, type NextRequest } from "next/server";

// Edge-runtime middleware: keep it dead simple (sync, no crypto, no top-level globals)
// so it can't fail to initialise/invoke on Vercel's Edge runtime. Auth model: the session
// cookie's value IS the AUTH_SECRET (a long random string) — holding it == being signed in.
// The Node-runtime /api/login route sets it after checking APP_PASSWORD.

const SESSION_COOKIE = "bj_session";

// Constant-time-ish compare (avoid leaking via early mismatch).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Protect everything except: the login page/route, Next internals, and public
// PWA assets (manifest + icons must load before you're signed in).
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|robots.txt).*)",
  ],
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/login" || pathname === "/api/login") {
    return NextResponse.next();
  }

  const secret = process.env.AUTH_SECRET;
  const password = process.env.APP_PASSWORD;

  // Auth not configured (e.g. local dev without secrets) → don't lock anyone out.
  if (!secret || !password) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token && safeEqual(token, secret)) {
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
