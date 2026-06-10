// Unibet "Transaktionshistorik" CSV importer.
//
// Unlike the bet365 statement, this export is a pure *transaction ledger*: one row
// per money movement, with no team names, markets, selections or odds. Bet-related
// rows carry Activity="Odds" and group by "Sports Coupon ID" (one coupon = one bet).
// Cash movements (Activity="Kassa": Swish deposits/withdrawals) are NOT bets and are
// ignored — the tracker derives bankroll from bet P/L + starting bankroll.
//
// For each coupon we reconstruct:
//   stake   = sum of |Insats| (stake) rows
//   net     = sum of ALL cash amounts on the coupon (Insats + Retur + Korrektion + …)
//   payout  = stake + net
//   profit  = net                          (authoritative — stored as profitUnits)
//
// Profit/ROI/bankroll therefore come out exactly right. The only casualties of the
// sparse source are odds (recoverable for wins as payout/stake, unknown for losses)
// and event/market/sport (not present at all). importRef = coupon id → idempotent.

import type { PrismaClient } from "@prisma/client";

export const UNIT_KR = 100; // 1 unit = 100 kr (matches Setting.unitValue)
const LOSS_PLACEHOLDER_ODDS = 1.01; // odds unknown for losing coupons (no return row)

export type Outcome = "win" | "loss" | "push" | "void" | "half_win" | "half_loss" | "pending";

// Description (Beskrivning) values seen in the Unibet export.
const D_STAKE = "Insats"; // stake placed (negative cash)
// Everything else with Activity=Odds is a settlement-side movement:
//   Retur (return), Korrektion (correction/reversal), Spelet nekades (bet voided/refunded)

export interface CouponRow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  couponId: string;
  description: string;
  amount: number; // Cash Amount (signed)
}

export interface Coupon {
  couponId: string;
  placedAt: Date | null; // timestamp of the (earliest) Insats row
  stakeKr: number;
  payoutKr: number;
  profitKr: number;
  hasStake: boolean;
  hasSettlement: boolean;
}

/** Split one CSV line, trimming a trailing empty cell. No quoted fields appear in this export. */
function splitLine(line: string): string[] {
  return line.replace(/\r$/, "").split(",");
}

/** Parse the raw CSV text into bet-related coupon rows (Activity="Odds" only). */
export function parseCouponRows(csv: string): CouponRow[] {
  const lines = csv.replace(/^﻿/, "").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("Date");
  const iTime = idx("Time");
  const iCoupon = idx("Sports Coupon ID");
  const iActivity = idx("Activity");
  const iDesc = idx("Description");
  const iCash = idx("Cash Amount");

  const out: CouponRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i]);
    if (c[iActivity] !== "Odds") continue; // skip Kassa (deposits/withdrawals)
    const couponId = c[iCoupon]?.trim();
    if (!couponId) continue;
    const amount = parseFloat(c[iCash]);
    if (Number.isNaN(amount)) continue;
    out.push({
      date: c[iDate]?.trim() ?? "",
      time: c[iTime]?.trim() ?? "",
      couponId,
      description: c[iDesc]?.trim() ?? "",
      amount,
    });
  }
  return out;
}

/** Group coupon rows into one settled (or pending) bet per Sports Coupon ID. */
export function buildCoupons(rows: CouponRow[]): Coupon[] {
  const byId = new Map<string, CouponRow[]>();
  for (const r of rows) {
    const arr = byId.get(r.couponId);
    if (arr) arr.push(r);
    else byId.set(r.couponId, [r]);
  }

  const coupons: Coupon[] = [];
  for (const [couponId, group] of byId) {
    let stakeKr = 0;
    let net = 0;
    let hasStake = false;
    let hasSettlement = false;
    let placedAt: Date | null = null;

    for (const r of group) {
      net += r.amount;
      if (r.description === D_STAKE) {
        hasStake = true;
        stakeKr += -r.amount; // Insats is negative
        const t = new Date(`${r.date}T${r.time || "00:00"}:00`);
        if (!Number.isNaN(t.getTime()) && (!placedAt || t < placedAt)) placedAt = t;
      } else {
        hasSettlement = true;
      }
    }

    coupons.push({
      couponId,
      placedAt,
      stakeKr: round2(stakeKr),
      payoutKr: round2(stakeKr + net),
      profitKr: round2(net),
      hasStake,
      hasSettlement,
    });
  }

  // Oldest first so DB insertion order is chronological.
  coupons.sort((a, b) => (a.placedAt?.getTime() ?? 0) - (b.placedAt?.getTime() ?? 0));
  return coupons;
}

export function couponOutcome(c: Coupon): Outcome {
  // A coupon with a stake but no settlement row in the export = stake fully lost.
  // (The account was emptied at export time, so nothing is left genuinely pending.)
  if (Math.abs(c.profitKr) < 0.005) return "void";
  if (c.profitKr > 0) return "win";
  // profit < 0: full loss, or partial loss (cashout returned part of the stake).
  return c.payoutKr > 0.005 ? "half_loss" : "loss";
}

/** Effective combined odds: payout/stake for winning coupons; unknown (placeholder) otherwise. */
export function couponOdds(c: Coupon): number {
  const o = couponOutcome(c);
  if ((o === "win" || o === "half_win") && c.stakeKr > 0) {
    return round2(c.payoutKr / c.stakeKr);
  }
  return LOSS_PLACEHOLDER_ODDS;
}

export interface CouponRecord {
  ref: string;
  outcome: Outcome;
  profitUnits: number;
  data: Record<string, unknown>;
}

export function couponToRecord(c: Coupon): CouponRecord {
  const outcome = couponOutcome(c);
  const profitUnits = Number((c.profitKr / UNIT_KR).toFixed(4));
  const placedAt = c.placedAt ?? new Date();
  return {
    ref: c.couponId,
    outcome,
    profitUnits,
    data: {
      placedAt,
      eventAt: c.placedAt,
      event: `Unibet kupong ${c.couponId}`,
      selection: "—", // not present in the transaction export
      market: "other",
      betType: "single", // singles vs accumulators are indistinguishable in the ledger
      odds: couponOdds(c),
      stakeUnits: Number((c.stakeKr / UNIT_KR).toFixed(4)),
      outcome,
      profitUnits,
      bookmaker: "Unibet",
      importRef: c.couponId,
      notes: `Importerad från Unibet transaktionshistorik (kupong ${c.couponId})`,
      gradedAt: placedAt,
    },
  };
}

export interface ImportSummary {
  parsedCoupons: number;
  skippedNoStake: number;
  added: number;
  updated: number;
  unchanged: number;
  netUnits: number;
}

function approxEq(a: number | null | undefined, b: number | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) < 0.005;
}

/**
 * Incremental import into the given user's bet log: match existing rows on importRef
 * (coupon id). Adds new coupons, updates outcome/profit on changed ones, never wipes
 * or touches non-Unibet bets.
 */
export async function importCoupons(
  prisma: PrismaClient,
  coupons: Coupon[],
  userId: string
): Promise<ImportSummary> {
  const usable = coupons.filter((c) => c.hasStake && c.stakeKr > 0);
  const skippedNoStake = coupons.length - usable.length;
  const records = usable.map(couponToRecord);
  const netUnits = records.reduce((a, r) => a + r.profitUnits, 0);

  const existing = await prisma.bet.findMany({
    where: { userId, importRef: { in: records.map((r) => r.ref) } },
    select: { id: true, importRef: true, outcome: true, profitUnits: true },
  });
  const byRef = new Map(existing.map((e) => [e.importRef as string, e]));

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const r of records) {
    const ex = byRef.get(r.ref);
    if (!ex) {
      await prisma.bet.create({ data: { ...r.data, userId } as never });
      added += 1;
    } else if (ex.outcome !== r.outcome || !approxEq(ex.profitUnits, r.profitUnits)) {
      await prisma.bet.update({
        where: { id: ex.id },
        data: {
          outcome: r.outcome,
          profitUnits: r.profitUnits,
          odds: r.data.odds as number,
          stakeUnits: r.data.stakeUnits as number,
          gradedAt: r.data.gradedAt as Date,
        },
      });
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  return { parsedCoupons: coupons.length, skippedNoStake, added, updated, unchanged, netUnits };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
