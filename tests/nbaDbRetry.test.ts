import { describe, it, expect } from "vitest";
import { isTransientDb, withDbRetry } from "../lib/nbaDbRetry";

describe("databasfel", () => {
  const db = { disconnects: 0, async $disconnect() { this.disconnects++; } };

  it("försöker igen när Neon stänger anslutningen (P1017), med ny anslutning", async () => {
    let n = 0;
    const r = await withDbRetry(db, async () => {
      if (++n < 3) throw Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
      return "ok";
    }, { waits: [0, 0, 0] });
    expect(r).toBe("ok");
    expect(n).toBe(3);
    expect(db.disconnects).toBe(2);
  });

  it("andra fel kastas direkt, och efter sista försöket ges upp", async () => {
    let n = 0;
    await expect(withDbRetry(db, async () => { n++; throw Object.assign(new Error("Unique constraint"), { code: "P2002" }); }, { waits: [0] })).rejects.toThrow("Unique");
    expect(n).toBe(1);
    await expect(withDbRetry(db, async () => { throw Object.assign(new Error("closed"), { code: "P1017" }); }, { waits: [0] })).rejects.toThrow("closed");
    expect(isTransientDb(new Error("Can't reach database server"))).toBe(true);
  });
});
