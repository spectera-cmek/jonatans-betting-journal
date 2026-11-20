import { describe, it, expect } from "vitest";
import { writeChangedLines } from "../lib/cs2/lineStore";
import type { ValidLine } from "../lib/cs2/lineInput";

// En falsk databas där transaktioner körs samtidigt och låset beter sig som
// pg_advisory_xact_lock: det tas i $executeRaw och släpps när transaktionen är klar.
function fakeDb() {
  const rows: Array<ValidLine & { id: number }> = [];
  let held: Promise<void> | null = null;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const db = {
    rows,
    async $transaction<R>(fn: (tx: any) => Promise<R>): Promise<R> {
      let release = () => {};
      const tx = {
        async $executeRaw() {
          while (held) await held;
          held = new Promise<void>((r) => (release = () => { held = null; r(); }));
          return 0;
        },
        cs2Line: {
          async findMany() {
            await tick();
            return rows.map((r) => ({ ...r }));
          },
        },
      };
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  };
  return db;
}

const line = (overOdds: number): ValidLine => ({
  matchId: 1, market: "kills", scope: "map1", playerId: 7, player2Id: null, teamId: null,
  line: 15.5, overOdds, underOdds: 1.9, includesOt: true, bookmaker: "Unibet", source: "kambi",
});

describe("lås när Unibet-linjer sparas", () => {
  it("två hämtningar samtidigt sparar samma odds en gång", async () => {
    const db = fakeDb();
    const save = async (_tx: unknown, toSave: ValidLine[]) => {
      await new Promise((r) => setTimeout(r, 5));
      for (const v of toSave) db.rows.push({ ...v, id: db.rows.length + 1 });
    };
    const [a, b] = await Promise.all([writeChangedLines(db, 1, [line(1.85)], save), writeChangedLines(db, 1, [line(1.85)], save)]);
    expect(db.rows).toHaveLength(1);
    expect(a + b).toBe(1);
  });

  it("ändrade odds sparas som ny version", async () => {
    const db = fakeDb();
    const save = async (_tx: unknown, toSave: ValidLine[]) => {
      for (const v of toSave) db.rows.push({ ...v, id: db.rows.length + 1 });
    };
    await writeChangedLines(db, 1, [line(1.85)], save);
    expect(await writeChangedLines(db, 1, [line(1.95)], save)).toBe(1);
    expect(db.rows.map((r) => r.overOdds)).toEqual([1.85, 1.95]);
  });
});
