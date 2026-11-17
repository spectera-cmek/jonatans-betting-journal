import { describe, expect, it } from "vitest";
import { checkResetExpiry, hashResetToken, looksLikeResetToken, newResetToken } from "../lib/passwordReset";

const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("återställningslänk", () => {
  it("sparar bara hashen, och hashen hittar tillbaka till koden", () => {
    const { token, hash, expiresAt } = newResetToken(3600, NOW);
    expect(hash).not.toContain(token);
    expect(hashResetToken(token)).toBe(hash);
    expect(expiresAt.getTime()).toBe(NOW + 3600_000);
  });

  it("ger en ny kod varje gång", () => {
    expect(newResetToken().token).not.toBe(newResetToken().token);
  });

  it("koden ser ut som en kod — URL:ens skräp når aldrig databasen", () => {
    expect(looksLikeResetToken(newResetToken().token)).toBe(true);
    expect(looksLikeResetToken("")).toBe(false);
    expect(looksLikeResetToken("abc.def.ghi")).toBe(false);
    expect(looksLikeResetToken(42)).toBe(false);
  });

  it("går ut", () => {
    const { expiresAt } = newResetToken(3600, NOW);
    expect(checkResetExpiry(expiresAt, NOW + 60_000)).toEqual({ ok: true });
    expect(checkResetExpiry(expiresAt, NOW + 3601_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("utan sparad kod finns inget att använda", () => {
    expect(checkResetExpiry(null, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});
