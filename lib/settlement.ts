import type { Bet, BetSettlement, PrismaClient } from "@prisma/client";
import { profitUnits, type Outcome } from "./betting";
import type { BetSettlementDTO } from "./types";

export const SETTLE_OUTCOMES = [
  "win",
  "loss",
  "push",
  "void",
  "half_win",
  "half_loss",
] as const satisfies readonly Outcome[];

export type SettlementSource =
  | "manual"
  | "agent"
  | "espn"
  | "odds_api"
  | "bet365"
  | "unibet"
  | "undo";

export class SettlementError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "invalid_outcome"
      | "already_settled"
      | "conflict"
      | "nothing_to_undo",
    readonly status: number
  ) {
    super(message);
  }
}

export interface SettleBetInput {
  betId: string;
  userId?: string;
  outcome: Outcome;
  source: SettlementSource;
  reason?: string | null;
  /** Authoritative bookmaker payout expressed as P/L units. */
  explicitProfitUnits?: number | null;
  gradedAt?: Date;
  /** Required for an explicit correction/import update of an already-settled bet. */
  allowCorrection?: boolean;
}

export interface SettlementResult {
  bet: Bet;
  settlement: BetSettlement | null;
  changed: boolean;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function validOutcome(outcome: string): outcome is (typeof SETTLE_OUTCOMES)[number] {
  return SETTLE_OUTCOMES.includes(outcome as (typeof SETTLE_OUTCOMES)[number]);
}

/**
 * The one write path for settlement. It records before/after values in the same
 * transaction and uses an outcome compare in the UPDATE to prevent two clients
 * from silently grading the same bet at once.
 */
export async function settleBet(
  prisma: PrismaClient,
  input: SettleBetInput
): Promise<SettlementResult> {
  if (!validOutcome(input.outcome)) {
    throw new SettlementError("Ogiltigt utfall.", "invalid_outcome", 400);
  }
  if (
    input.explicitProfitUnits !== undefined &&
    input.explicitProfitUnits !== null &&
    !Number.isFinite(input.explicitProfitUnits)
  ) {
    throw new SettlementError("Ogiltig explicit P/L.", "invalid_outcome", 400);
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.bet.findFirst({
      where: {
        id: input.betId,
        ...(input.userId ? { userId: input.userId } : {}),
      },
    });
    if (!existing) {
      throw new SettlementError("Bet hittades inte.", "not_found", 404);
    }

    const nextProfit =
      input.explicitProfitUnits !== undefined && input.explicitProfitUnits !== null
        ? round4(input.explicitProfitUnits)
        : round4(profitUnits(input.outcome, existing.odds, existing.stakeUnits));

    if (
      existing.outcome === input.outcome &&
      existing.profitUnits !== null &&
      Math.abs(existing.profitUnits - nextProfit) < 0.00005
    ) {
      return { bet: existing, settlement: null, changed: false };
    }

    if (existing.outcome !== "pending" && !input.allowCorrection) {
      throw new SettlementError(
        `Betet är redan rättat som ${existing.outcome}. Använd korrigera eller ångra.`,
        "already_settled",
        409
      );
    }

    const gradedAt = input.gradedAt ?? new Date();
    const updated = await tx.bet.updateMany({
      where: { id: existing.id, outcome: existing.outcome },
      data: {
        outcome: input.outcome,
        profitUnits: nextProfit,
        gradedAt,
      },
    });
    if (updated.count !== 1) {
      throw new SettlementError(
        "Betet ändrades av en annan rättning. Ladda om och försök igen.",
        "conflict",
        409
      );
    }

    const settlement = await tx.betSettlement.create({
      data: {
        betId: existing.id,
        fromOutcome: existing.outcome,
        toOutcome: input.outcome,
        fromProfitUnits: existing.profitUnits,
        toProfitUnits: nextProfit,
        fromGradedAt: existing.gradedAt,
        toGradedAt: gradedAt,
        source: input.source,
        reason: input.reason?.trim() || null,
      },
    });
    const bet = await tx.bet.findUniqueOrThrow({ where: { id: existing.id } });
    return { bet, settlement, changed: true };
  });
}

export async function undoLastSettlement(
  prisma: PrismaClient,
  input: { betId: string; userId?: string }
): Promise<SettlementResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.bet.findFirst({
      where: {
        id: input.betId,
        ...(input.userId ? { userId: input.userId } : {}),
      },
    });
    if (!existing) {
      throw new SettlementError("Bet hittades inte.", "not_found", 404);
    }
    const settlement = await tx.betSettlement.findFirst({
      where: { betId: existing.id, revertedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!settlement) {
      throw new SettlementError(
        "Det finns ingen rättning att ångra.",
        "nothing_to_undo",
        409
      );
    }
    if (
      existing.outcome !== settlement.toOutcome ||
      (existing.profitUnits ?? null) !== (settlement.toProfitUnits ?? null)
    ) {
      throw new SettlementError(
        "Betet har ändrats efter rättningen och kan inte ångras säkert.",
        "conflict",
        409
      );
    }

    const updated = await tx.bet.updateMany({
      where: { id: existing.id, outcome: settlement.toOutcome },
      data: {
        outcome: settlement.fromOutcome,
        profitUnits: settlement.fromProfitUnits,
        gradedAt: settlement.fromGradedAt,
      },
    });
    if (updated.count !== 1) {
      throw new SettlementError(
        "Betet ändrades av en annan rättning. Ladda om och försök igen.",
        "conflict",
        409
      );
    }
    await tx.betSettlement.update({
      where: { id: settlement.id },
      data: { revertedAt: new Date() },
    });
    const bet = await tx.bet.findUniqueOrThrow({ where: { id: existing.id } });
    return { bet, settlement, changed: true };
  });
}

export function serializeSettlement(row: BetSettlement): BetSettlementDTO {
  return {
    id: row.id,
    betId: row.betId,
    fromOutcome: row.fromOutcome as Outcome,
    toOutcome: row.toOutcome as Outcome,
    fromProfitUnits: row.fromProfitUnits,
    toProfitUnits: row.toProfitUnits,
    fromGradedAt: row.fromGradedAt?.toISOString() ?? null,
    toGradedAt: row.toGradedAt?.toISOString() ?? null,
    source: row.source,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    revertedAt: row.revertedAt?.toISOString() ?? null,
  };
}
