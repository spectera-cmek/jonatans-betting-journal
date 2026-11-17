// Återställningslänkar för lösenord — utan e-post.
//
// Konton har bara ett användarnamn, så det finns ingen adress att mejla en
// länk till. I stället skapar den som driftar appen en länk med
// `npm run user:reset-link -- <användarnamn>` och skickar den själv.
//
// Skriptet sparar en slumpad engångskod på användaren — bara som SHA-256-hash,
// med utgångstid — och skriver ut länken med koden i klartext. Servern slår upp
// hashen, och nollställer den när lösenordet är bytt: länken går att använda en
// gång. Inget hemligt behöver finnas på datorn som skapar länken (produktionens
// AUTH_SECRET går inte att hämta lokalt), bara åtkomst till databasen.

import { createHash, randomBytes } from "crypto";

/** Hur länge en länk gäller om inget annat anges. */
export const RESET_TTL_SEC = 24 * 60 * 60;

/** SHA-256 av koden. Koden är 256 slumpbitar, så en snabb hash räcker. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** En ny kod och det som ska sparas på användaren. */
export function newResetToken(
  ttlSec: number = RESET_TTL_SEC,
  now: number = Date.now()
): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashResetToken(token), expiresAt: new Date(now + ttlSec * 1000) };
}

/** Rimlig form på en kod ur URL:en — allt annat avvisas innan databasen frågas. */
export function looksLikeResetToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token);
}

export type ResetCheck = { ok: true } | { ok: false; reason: "invalid" | "expired" };

/** Sparad utgångstid mot nu. Hashen har redan matchat i uppslaget. */
export function checkResetExpiry(expiresAt: Date | null, now: number = Date.now()): ResetCheck {
  if (!expiresAt) return { ok: false, reason: "invalid" };
  return expiresAt.getTime() < now ? { ok: false, reason: "expired" } : { ok: true };
}
