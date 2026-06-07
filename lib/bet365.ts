// Shared Bet365 account-statement parser + importer.
//
// The statement PDF is a fixed-column table. We extract token (x,y) coordinates
// with pdfjs-dist and reconstruct rows/columns. A new betslip starts on a row
// carrying a bet-type keyword (Singlar/Dubblar/…); each leg carries an outcome
// word (Vinnande/Förlorande/Pågående/…). Stake & payout appear once per slip.
// Profit is taken from the ACTUAL payout column (after tax), never recomputed.
//
// Used by scripts/importBet365.mts (CLI) and app/api/import/bet365 (UI button).
// The pdfjs import is deferred so this module is cheap to import where only the
// DB-side importSlips() is needed.

import type { PrismaClient } from "@prisma/client";
import { categorizeBet } from "./categorize";

export const UNIT_KR = 100; // 1 unit = 100 kr (matches Setting.unitValue)
const MAX_ODDS = 1000; // cap stored odds so a few giant same-game accas don't wreck avgOdds

// Optional control totals to validate parsing against your statement header.
// Set these to the "Total stake" / "Total payout" figures printed on your own
// bet365 account statement to get a parse-accuracy diff in the CLI. Left at 0
// (disabled) so no personal figures ship with the repo.
export const CONTROL_STAKE = 0;
export const CONTROL_PAYOUT = 0;

const BET_TYPES = new Set([
  "Singlar",
  "Dubblar",
  "Tripplar",
  "Fyrlingar",
  "Femlingar",
  "Sexlingar",
  "Sjulingar",
  "Åttlingar",
]);
const OUTCOME_RE = /^(Vinnande|Förlorande|Pågående|Annullerat|Halv|Void|Återbetald|Delvis)/;

// Column x-bands (left edge of each cell, from probe).
const COL = {
  date: (x: number) => x < 60,
  ref: (x: number) => x >= 95 && x < 130,
  type: (x: number) => x >= 175 && x < 220,
  selection: (x: number) => x >= 220 && x < 312,
  event: (x: number) => x >= 312 && x < 400,
  outcome: (x: number) => x >= 400 && x < 448,
  stake: (x: number) => x >= 448 && x < 500,
  payout: (x: number) => x >= 500 && x < 565,
};

interface Cell { x: number; str: string }
interface Row { y: number; cells: Cell[] }

export interface Leg {
  selection: string;
  event: string;
  market: string | null;
  odds: number | null;
  outcome: string;
}
export interface Slip {
  date: string;
  ref: string;
  type: string;
  stakeKr: number;
  payoutKr: number;
  legs: Leg[];
}

export type Outcome = "win" | "loss" | "push" | "void" | "half_win" | "half_loss" | "pending";

const accaOdds = (legOdds: number[]): number => legOdds.reduce((a, o) => a * o, 1);

// Page furniture that repeats at page breaks (a slip's legs can span a page).
function isFurniture(text: string): boolean {
  return (
    /Sida\s+\d+\s*\/\s*\d+/.test(text) ||
    /Datum och tid/.test(text) ||
    /Spelbekräftelse/.test(text) ||
    /Typ av spel/.test(text) ||
    /Spel placerade/.test(text) ||
    /Vänligen notera/.test(text) ||
    /Slut på utdrag/.test(text)
  );
}

function moneyKr(s: string): number | null {
  const m = s.match(/-?\d[\d.\s]*,\d{2}/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/[.\s]/g, "").replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function bandJoin(cells: Cell[], pred: (x: number) => boolean): string {
  return cells
    .filter((c) => pred(c.x))
    .map((c) => c.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOdds(selectionText: string): number | null {
  const matches = [...selectionText.matchAll(/ - (\d+(?:[.,]\d+)?)/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1][1].replace(",", ".");
  const n = parseFloat(last);
  return Number.isNaN(n) || n < 1.01 ? null : n;
}

function extractMarket(eventText: string): string | null {
  const open = eventText.indexOf("(");
  if (open === -1 || !eventText.trimEnd().endsWith(")")) return null;
  return eventText.slice(open + 1, eventText.trimEnd().length - 1).trim() || null;
}

function parseDate(s: string): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MM, SS] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function extractRows(data: Uint8Array): Promise<Row[]> {
  // Deferred import keeps pdfjs out of the bundle for callers that only import.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const out: Row[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map<number, Cell[]>();
    for (const it of content.items as Array<{ str: string; transform: number[] }>) {
      if (!it.str || !it.str.trim()) continue;
      const x = Math.round(it.transform[4]);
      const y = Math.round(it.transform[5]);
      let key = y;
      for (const k of byY.keys()) {
        if (Math.abs(k - y) <= 2) { key = k; break; }
      }
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key)!.push({ x, str: it.str });
    }
    const ys = [...byY.keys()].sort((a, b) => b - a);
    for (const y of ys) out.push({ y, cells: byY.get(y)!.sort((a, b) => a.x - b.x) });
  }
  return out;
}

function parseSlips(rows: Row[]): Slip[] {
  const slips: Slip[] = [];
  let cur: Slip | null = null;
  let curLeg: Leg | null = null;

  const finalizeLeg = () => {
    if (cur && curLeg) {
      curLeg.market = extractMarket(curLeg.event);
      curLeg.odds = parseOdds(curLeg.selection);
      cur.legs.push(curLeg);
      curLeg = null;
    }
  };

  for (const row of rows) {
    if (isFurniture(row.cells.map((c) => c.str).join(" "))) continue;
    const typeTok = row.cells.find((c) => COL.type(c.x) && BET_TYPES.has(c.str.trim()));
    const sel = bandJoin(row.cells, COL.selection);
    const evt = bandJoin(row.cells, COL.event);
    const outcomeTok = row.cells.find((c) => COL.outcome(c.x) && OUTCOME_RE.test(c.str.trim()));

    if (typeTok) {
      finalizeLeg();
      if (cur) slips.push(cur);
      const date = bandJoin(row.cells, COL.date);
      const ref = bandJoin(row.cells, COL.ref);
      const stakeCell = row.cells.filter((c) => COL.stake(c.x)).map((c) => c.str).join(" ");
      const payoutCell = row.cells.filter((c) => COL.payout(c.x)).map((c) => c.str).join(" ");
      cur = {
        date,
        ref,
        type: typeTok.str.trim(),
        stakeKr: moneyKr(stakeCell) ?? 0,
        payoutKr: moneyKr(payoutCell) ?? 0,
        legs: [],
      };
      curLeg = { selection: sel, event: evt, market: null, odds: null, outcome: outcomeTok?.str.trim() || "" };
      continue;
    }

    if (!cur) continue;

    if (outcomeTok) {
      finalizeLeg();
      curLeg = { selection: sel, event: evt, market: null, odds: null, outcome: outcomeTok.str.trim() };
    } else if (curLeg) {
      if (sel) curLeg.selection += " " + sel;
      if (evt) curLeg.event += " " + evt;
    }
  }
  finalizeLeg();
  if (cur) slips.push(cur);
  return slips;
}

/** Parse a Bet365 statement PDF (as bytes) into structured slips. */
export async function parseSlipsFromBuffer(data: Uint8Array): Promise<Slip[]> {
  return parseSlips(await extractRows(data));
}

export function slipOutcome(s: Slip): Outcome {
  if (s.legs.some((l) => /Pågående/.test(l.outcome))) return "pending";
  const profit = s.payoutKr - s.stakeKr;
  const hasHalf = s.legs.some((l) => /Halv/.test(l.outcome));
  const allCancelled = s.legs.length > 0 && s.legs.every((l) => /Annullerat|Återbetald/.test(l.outcome));
  if (allCancelled || Math.abs(profit) < 0.005) return "void";
  if (hasHalf) return profit > 0 ? "half_win" : "half_loss";
  if (profit > 0) return "win";
  if (s.payoutKr < 0.005) return "loss";
  return "half_loss";
}

export function combinedOdds(s: Slip): number | null {
  const odds = s.legs.map((l) => l.odds).filter((o): o is number => !!o);
  if (!odds.length) return null;
  if (s.type === "Singlar") return odds[0];
  return Number(accaOdds(odds).toFixed(2));
}

export function effectiveOdds(s: Slip): number {
  const c = combinedOdds(s);
  if (c) return Math.min(c, MAX_ODDS);
  if (s.payoutKr > s.stakeKr && s.stakeKr > 0)
    return Math.min(Number((s.payoutKr / s.stakeKr).toFixed(2)), MAX_ODDS);
  return 1.01;
}

/** Build the create-data + stable key for one slip. */
export interface SlipRecord {
  ref: string;
  outcome: Outcome;
  profitUnits: number | null;
  data: Record<string, unknown>;
}

export function slipToRecord(s: Slip): SlipRecord {
  const outcome = slipOutcome(s);
  const odds = effectiveOdds(s);
  const stakeUnits = s.stakeKr / UNIT_KR;
  const eventAt = parseDate(s.date);
  const settled = outcome !== "pending";
  const cleanEvent = s.legs[0]?.event?.replace(/\s*\(.*$/s, "").trim() || s.ref;
  const cat = categorizeBet(cleanEvent, s.legs);
  const profitUnits = settled ? Number(((s.payoutKr - s.stakeKr) / UNIT_KR).toFixed(4)) : null;
  return {
    ref: s.ref,
    outcome,
    profitUnits,
    data: {
      placedAt: eventAt ?? new Date(),
      eventAt,
      event: cleanEvent,
      sport: cat.sport,
      league: cat.league,
      market: cat.market,
      selection: s.legs.map((l) => l.selection).join(" + ").slice(0, 500),
      betType: s.type === "Singlar" ? "single" : "accumulator",
      odds,
      stakeUnits,
      outcome,
      profitUnits,
      bookmaker: "Bet365",
      importRef: s.ref,
      legs: JSON.stringify(s.legs),
      notes: s.ref,
      gradedAt: settled ? eventAt ?? new Date() : null,
    },
  };
}

export interface ImportSummary {
  parsedSlips: number;
  added: number;
  settled: number; // previously-pending slips now settled by this import
  updated: number; // rows whose outcome/profit changed (incl. settled)
  refBackfilled: number; // rows that only needed an importRef written
  unchanged: number;
  netUnits: number; // net P/L over all parsed slips (control value)
  wiped: boolean;
}

function approxEq(a: number | null | undefined, b: number | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) < 0.005;
}

/**
 * Import slips into the DB.
 *  - default (incremental): match existing bets on the Bet365 slip ref (importRef,
 *    falling back to the legacy `notes` ref). Updates settlement on previously-pending
 *    slips, adds new slips, and never touches manually-added bets or enrichment
 *    (sport/league/market) on existing rows.
 *  - wipe: delete everything and re-create from scratch (the old behaviour).
 */
export async function importSlips(
  prisma: PrismaClient,
  slips: Slip[],
  opts: { wipe?: boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<ImportSummary> {
  const records = slips.map(slipToRecord);
  const netUnits = records.reduce((a, r) => a + (r.profitUnits ?? 0), 0);

  if (opts.wipe) {
    await prisma.bet.deleteMany({});
    await prisma.setting.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, unitValue: UNIT_KR, currency: "kr", startingBankrollUnits: 100 },
    });
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < records.length; i += CHUNK) {
      const batch = records.slice(i, i + CHUNK).map((r) => r.data);
      const res = await prisma.bet.createMany({ data: batch as never });
      inserted += res.count;
      opts.onProgress?.(inserted, records.length);
    }
    return {
      parsedSlips: slips.length,
      added: inserted,
      settled: 0,
      updated: 0,
      refBackfilled: 0,
      unchanged: 0,
      netUnits,
      wiped: true,
    };
  }

  // Incremental: index existing bets by their slip ref.
  const existing = await prisma.bet.findMany({
    select: { id: true, importRef: true, notes: true, outcome: true, profitUnits: true },
  });
  const byRef = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    const key = e.importRef ?? e.notes; // notes carried the ref before importRef existed
    if (key) byRef.set(key, e);
  }

  let added = 0;
  let settled = 0;
  let updated = 0;
  let refBackfilled = 0;
  let unchanged = 0;
  let done = 0;

  for (const r of records) {
    const ex = r.ref ? byRef.get(r.ref) : undefined;
    if (!ex) {
      await prisma.bet.create({ data: r.data as never });
      added += 1;
    } else {
      const outcomeChanged = ex.outcome !== r.outcome;
      const profitChanged = !approxEq(ex.profitUnits, r.profitUnits);
      if (outcomeChanged || profitChanged) {
        await prisma.bet.update({
          where: { id: ex.id },
          data: {
            outcome: r.outcome,
            profitUnits: r.profitUnits,
            gradedAt: (r.data.gradedAt as Date | null) ?? null,
            importRef: r.ref,
          },
        });
        updated += 1;
        if (ex.outcome === "pending" && r.outcome !== "pending") settled += 1;
      } else if (ex.importRef !== r.ref) {
        await prisma.bet.update({ where: { id: ex.id }, data: { importRef: r.ref } });
        refBackfilled += 1;
      } else {
        unchanged += 1;
      }
    }
    opts.onProgress?.(++done, records.length);
  }

  return {
    parsedSlips: slips.length,
    added,
    settled,
    updated,
    refBackfilled,
    unchanged,
    netUnits,
    wiped: false,
  };
}
