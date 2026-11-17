import { beforeAll, describe, expect, it } from "vitest";
import { createResetToken, resetTokenUserId, verifyResetToken } from "../lib/passwordReset";
import { createHmac } from "crypto";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-reset-links";
});

const NOW = Date.parse("2026-11-17T12:00:00Z");
const HASH = "$2a$10$abcdefghijklmnopqrstuuJ5oP1f7mFQ2pQ3b5m0u3oW8rYkR1y2e";

describe("återställningslänk", () => {
  it("gäller för rätt användare och rätt lösenord", () => {
    const token = createResetToken("user-1", HASH, 3600, NOW);
    expect(resetTokenUserId(token)).toBe("user-1");
    expect(verifyResetToken(token, HASH, NOW + 60_000)).toEqual({ ok: true });
  });

  it("slutar gälla när lösenordet har bytts", () => {
    const token = createResetToken("user-1", HASH, 3600, NOW);
    expect(verifyResetToken(token, HASH.replace("abc", "xyz"), NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("går ut", () => {
    const token = createResetToken("user-1", HASH, 3600, NOW);
    expect(verifyResetToken(token, HASH, NOW + 3601_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("kan inte flyttas till en annan användare", () => {
    const token = createResetToken("user-1", HASH, 3600, NOW);
    const [, exp, sig] = token.split(".");
    const forged = `${Buffer.from("user-2").toString("base64url")}.${exp}.${sig}`;
    expect(verifyResetToken(forged, HASH, NOW).ok).toBe(false);
  });

  it("godtar inte en sessionstoken", () => {
    // Samma form som lib/auth:s sessionstoken: payload signerad utan prefix och hash.
    const payload = `${Buffer.from("user-1").toString("base64url")}.${Math.floor(NOW / 1000) + 3600}`;
    const session = `${payload}.${createHmac("sha256", process.env.AUTH_SECRET!).update(payload).digest("base64url")}`;
    expect(verifyResetToken(session, HASH, NOW).ok).toBe(false);
  });

  it("avvisar skräp", () => {
    expect(resetTokenUserId("inte-en-token")).toBeNull();
    expect(verifyResetToken("a.b", HASH).ok).toBe(false);
  });
});
