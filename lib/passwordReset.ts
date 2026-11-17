// Återställningslänkar för lösenord — utan e-post och utan ny tabell.
//
// Konton har bara ett användarnamn, så det finns ingen adress att mejla en
// länk till. I stället skapar den som driftar appen en länk med
// `npm run user:reset-link -- <användarnamn>` och skickar den själv.
//
// Token: `base64url(userId).expiryEpochSec.base64url(hmac)`, signerad med
// AUTH_SECRET — samma form som sessionscookien, men signaturen täcker också
// användarens nuvarande lösenordshash. När lösenordet byts ändras hashen och
// länken slutar gälla av sig själv: den går att använda en gång, utan att
// något behöver sparas om den.

import { createHmac, timingSafeEqual } from "crypto";

/** Hur länge en länk gäller om inget annat anges. */
export const RESET_TTL_SEC = 24 * 60 * 60;

// Konstanttidsjämförelse, som lib/auth:s safeEqual (den filen drar in databasen
// och Next, så den här modulen hålls fristående och testbar).
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "safe-equal").update(a).digest();
  const hb = createHmac("sha256", "safe-equal").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

function sign(payload: string, passwordHash: string): string {
  // Eget prefix, så en sessionstoken aldrig kan tolkas som en återställningstoken.
  return createHmac("sha256", secret()).update(`reset:${payload}:${passwordHash}`).digest("base64url");
}

export function createResetToken(
  userId: string,
  passwordHash: string,
  ttlSec: number = RESET_TTL_SEC,
  now: number = Date.now()
): string {
  const exp = Math.floor(now / 1000) + ttlSec;
  const payload = `${Buffer.from(userId, "utf8").toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload, passwordHash)}`;
}

/** Läs ut vem token gäller utan att lita på den — signaturen kräver hashen ur databasen. */
export function resetTokenUserId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const userId = Buffer.from(parts[0], "base64url").toString("utf8");
  return userId || null;
}

export type ResetCheck = { ok: true } | { ok: false; reason: "invalid" | "expired" };

/** Äkta, ej utgången, och skapad mot lösenordet som gäller nu. */
export function verifyResetToken(token: string, passwordHash: string, now: number = Date.now()): ResetCheck {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [userB64, expStr, sig] = parts;
  if (!safeEqual(sig, sign(`${userB64}.${expStr}`, passwordHash))) return { ok: false, reason: "invalid" };
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < now) return { ok: false, reason: "expired" };
  return { ok: true };
}
