// Tiny stateless session auth for a single-user app.
//
// The session cookie is an HMAC-signed token `"<exp>.<sig>"` where `exp` is the unix
// expiry (seconds) and `sig = HMAC-SHA256(secret, exp)`. No database, no library — just
// Web Crypto, which exists both in the Edge middleware and the Node API route.

export const SESSION_COOKIE = "bj_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

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

/** Constant-time-ish string compare (avoids leaking via early mismatch). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, maxAgeSec = SESSION_MAX_AGE): Promise<string> {
  const exp = String(Math.floor(Date.now() / 1000) + maxAgeSec);
  const sig = await hmac(secret, exp);
  return `${exp}.${sig}`;
}

export async function verifySessionToken(token: string | undefined, secret: string): Promise<boolean> {
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
