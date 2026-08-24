import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { settleBet, undoLastSettlement, SettlementError } from "../lib/settlement";

// An in-memory stand-in for the two tables settleBet touches. It is deliberately
// faithful about one thing: updateMany matches on `outcome` as well as `id`, which
// is how the real code implements its compare-and-set against concurrent grading.
interface FakeBet {
  id: string;
  userId: string;
  odds: number;
  stakeUnits: number;
  outcome: string;
  profitUnits: number | null;
  gradedAt: Date | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeDb(bets: FakeBet[]) {
  const betRows = bets.map((b) => ({ ...b }));
  const settlements: Record<string, any>[] = [];
  let seq = 0;
  // Set by a test to simulate another writer landing between the read and the
  // write inside the transaction. Fires once.
  let beforeUpdate: (() => void) | undefined;

  const tx = {
    bet: {
      findFirst: async ({ where }: any) => {
        // Real Prisma hands back a detached row; returning the live object would
        // let updateMany mutate what the audit write still needs to read.
        const row = betRows.find(
          (b) => b.id === where.id && (where.userId === undefined || b.userId === where.userId)
        );
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: any) => {
        if (beforeUpdate) {
          const fn = beforeUpdate;
          beforeUpdate = undefined;
          fn();
        }
        const row = betRows.find((b) => b.id === where.id && b.outcome === where.outcome);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const row = betRows.find((b) => b.id === where.id);
        if (!row) throw new Error("bet not found");
        return { ...row };
      },
    },
    betSettlement: {
      create: async ({ data }: any) => {
        seq += 1;
        const row = {
          id: `s${seq}`,
          createdAt: new Date(1_700_000_000_000 + seq),
          revertedAt: null,
          ...data,
        };
        settlements.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => {
        const matches = settlements.filter(
          (s) => s.betId === where.betId && (where.revertedAt !== null || s.revertedAt === null)
        );
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches[0] ?? null;
      },
      update: async ({ where, data }: any) => {
        const row = settlements.find((s) => s.id === where.id);
        Object.assign(row as object, data);
        return row;
      },
    },
  };

  const db = { $transaction: async (fn: any) => fn(tx), ...tx };
  return {
    db: db as unknown as PrismaClient,
    betRows,
    settlements,
    raceWith(fn: () => void) {
      beforeUpdate = fn;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const pending = (over: Partial<FakeBet> = {}): FakeBet => ({
  id: "b1",
  userId: "u1",
  odds: 2.5,
  stakeUnits: 2,
  outcome: "pending",
  profitUnits: null,
  gradedAt: null,
  ...over,
});

async function expectError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e) => e as SettlementError
  );
  expect(err).toBeInstanceOf(SettlementError);
  expect(err?.code).toBe(code);
  expect(err?.status).toBe(status);
}

describe("settleBet — guards", () => {
  it("rejects an outcome that is not settleable", async () => {
    const { db } = makeDb([pending()]);
    await expectError(
      settleBet(db, { betId: "b1", outcome: "pending" as never, source: "manual" }),
      "invalid_outcome",
      400
    );
  });

  it("rejects a non-finite explicit profit", async () => {
    const { db } = makeDb([pending()]);
    await expectError(
      settleBet(db, { betId: "b1", outcome: "win", source: "bet365", explicitProfitUnits: NaN }),
      "invalid_outcome",
      400
    );
  });

  it("404s on an unknown bet", async () => {
    const { db } = makeDb([pending()]);
    await expectError(
      settleBet(db, { betId: "nope", outcome: "win", source: "manual" }),
      "not_found",
      404
    );
  });

  it("will not let one user settle a bet belonging to another", async () => {
    const { db, betRows } = makeDb([pending({ userId: "u1" })]);
    await expectError(
      settleBet(db, { betId: "b1", userId: "u2", outcome: "win", source: "manual" }),
      "not_found",
      404
    );
    expect(betRows[0].outcome).toBe("pending");
  });
});

describe("settleBet — grading a pending bet", () => {
  it("writes the computed profit and an audit row", async () => {
    const { db, betRows, settlements } = makeDb([pending()]);
    const res = await settleBet(db, { betId: "b1", outcome: "win", source: "manual" });

    expect(res.changed).toBe(true);
    expect(betRows[0].outcome).toBe("win");
    expect(betRows[0].profitUnits).toBe(3); // 2u at 2.50
    expect(betRows[0].gradedAt).toBeInstanceOf(Date);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      fromOutcome: "pending",
      toOutcome: "win",
      fromProfitUnits: null,
      toProfitUnits: 3,
      source: "manual",
    });
  });

  it("prefers an explicit payout over the formula", async () => {
    // bet365 pays out after tax, so the real payout is the authoritative number.
    const { db, betRows } = makeDb([pending()]);
    await settleBet(db, {
      betId: "b1",
      outcome: "win",
      source: "bet365",
      explicitProfitUnits: 2.8137,
    });
    expect(betRows[0].profitUnits).toBe(2.8137);
  });

  it("rounds the stored profit to four decimals", async () => {
    const { db, betRows } = makeDb([pending({ odds: 1.3333, stakeUnits: 1 })]);
    await settleBet(db, { betId: "b1", outcome: "win", source: "manual" });
    expect(betRows[0].profitUnits).toBe(0.3333);
  });

  it("trims a blank reason to null", async () => {
    const { db, settlements } = makeDb([pending()]);
    await settleBet(db, { betId: "b1", outcome: "loss", source: "manual", reason: "   " });
    expect(settlements[0].reason).toBeNull();
  });
});

describe("settleBet — re-settling", () => {
  it("is a no-op when the outcome and profit already match", async () => {
    const { db, settlements } = makeDb([
      pending({ outcome: "win", profitUnits: 3, gradedAt: new Date() }),
    ]);
    const res = await settleBet(db, { betId: "b1", outcome: "win", source: "manual" });

    expect(res.changed).toBe(false);
    expect(res.settlement).toBeNull();
    expect(settlements).toHaveLength(0); // repeated syncs must not spam the audit log
  });

  it("blocks a change to an already-settled bet without allowCorrection", async () => {
    const { db, betRows } = makeDb([pending({ outcome: "win", profitUnits: 3 })]);
    await expectError(
      settleBet(db, { betId: "b1", outcome: "loss", source: "manual" }),
      "already_settled",
      409
    );
    expect(betRows[0].outcome).toBe("win");
  });

  it("allows the same change when allowCorrection is set", async () => {
    const { db, betRows, settlements } = makeDb([pending({ outcome: "win", profitUnits: 3 })]);
    const res = await settleBet(db, {
      betId: "b1",
      outcome: "loss",
      source: "manual",
      allowCorrection: true,
    });

    expect(res.changed).toBe(true);
    expect(betRows[0].profitUnits).toBe(-2);
    expect(settlements[0]).toMatchObject({ fromOutcome: "win", toOutcome: "loss" });
  });

  it("409s when another writer grades the same bet first", async () => {
    // The row is read as pending, then changes underneath the transaction, so
    // the outcome-matched updateMany affects zero rows and nothing is written.
    const { db, betRows, settlements, raceWith } = makeDb([pending()]);
    raceWith(() => {
      betRows[0].outcome = "loss";
      betRows[0].profitUnits = -2;
    });

    await expectError(
      settleBet(db, { betId: "b1", outcome: "win", source: "manual" }),
      "conflict",
      409
    );
    expect(betRows[0].outcome).toBe("loss"); // the other writer's result survives
    expect(settlements).toHaveLength(0);
  });
});

describe("undoLastSettlement", () => {
  it("restores the previous outcome and profit, and marks the row reverted", async () => {
    const { db, betRows, settlements } = makeDb([pending()]);
    await settleBet(db, { betId: "b1", outcome: "win", source: "manual" });
    const res = await undoLastSettlement(db, { betId: "b1" });

    expect(res.changed).toBe(true);
    expect(betRows[0].outcome).toBe("pending");
    expect(betRows[0].profitUnits).toBeNull();
    expect(betRows[0].gradedAt).toBeNull();
    expect(settlements[0].revertedAt).toBeInstanceOf(Date);
  });

  it("409s when there is nothing to undo", async () => {
    const { db } = makeDb([pending()]);
    await expectError(undoLastSettlement(db, { betId: "b1" }), "nothing_to_undo", 409);
  });

  it("refuses to undo when the bet moved on after the settlement", async () => {
    const { db, betRows } = makeDb([pending()]);
    await settleBet(db, { betId: "b1", outcome: "win", source: "manual" });
    betRows[0].outcome = "loss"; // edited by hand afterwards
    await expectError(undoLastSettlement(db, { betId: "b1" }), "conflict", 409);
  });

  it("404s on an unknown bet", async () => {
    const { db } = makeDb([pending()]);
    await expectError(undoLastSettlement(db, { betId: "nope" }), "not_found", 404);
  });
});
