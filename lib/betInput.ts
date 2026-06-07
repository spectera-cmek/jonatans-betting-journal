// Validate + normalize raw bet input (from the API) into Prisma-ready data.
// Shared by POST (create) and PATCH (update).

import { profitUnits, type Outcome } from "./betting";

const OUTCOMES: Outcome[] = [
  "pending",
  "win",
  "loss",
  "push",
  "half_win",
  "half_loss",
  "void",
];
const MARKETS = ["h2h", "totals", "spreads", "other"];
const SIDES = ["home", "away", "draw", "over", "under"];

export interface BetInput {
  eventAt?: string | null;
  sportKey?: string | null;
  sport?: string | null;
  league?: string | null;
  event?: string;
  homeTeam?: string | null;
  awayTeam?: string | null;
  market?: string;
  selection?: string;
  selectionSide?: string | null;
  line?: number | string | null;
  betType?: string;
  odds?: number | string;
  closingOdds?: number | string | null;
  stakeUnits?: number | string;
  outcome?: string;
  externalRef?: string | null;
  bookmaker?: string | null;
  tipster?: string | null;
  notes?: string | null;
  legs?: unknown;
}

export class ValidationError extends Error {}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Build a Prisma data object for create/update. When `partial` is true, only
 * provided fields are included (PATCH semantics). Recomputes profitUnits when
 * outcome/odds/stake are known.
 */
export function buildBetData(
  input: BetInput,
  opts: { partial?: boolean; existing?: { odds: number; stakeUnits: number; outcome: string } } = {}
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const { partial, existing } = opts;

  if (!partial || input.event !== undefined) {
    const event = str(input.event);
    if (!event) throw new ValidationError("event is required");
    data.event = event;
  }

  if (!partial || input.odds !== undefined) {
    const odds = num(input.odds);
    if (odds === null || odds < 1.01)
      throw new ValidationError("odds must be a decimal >= 1.01");
    data.odds = odds;
  }

  if (!partial || input.stakeUnits !== undefined) {
    const stake = num(input.stakeUnits);
    if (stake === null || stake <= 0)
      throw new ValidationError("stakeUnits must be > 0");
    data.stakeUnits = stake;
  }

  if (!partial || input.market !== undefined) {
    const market = (str(input.market) || "h2h").toLowerCase();
    if (!MARKETS.includes(market))
      throw new ValidationError(`market must be one of ${MARKETS.join(", ")}`);
    data.market = market;
  }

  if (!partial || input.selection !== undefined) {
    data.selection = str(input.selection) || "";
  }

  if (input.selectionSide !== undefined) {
    const side = str(input.selectionSide)?.toLowerCase() ?? null;
    if (side && !SIDES.includes(side))
      throw new ValidationError(`selectionSide must be one of ${SIDES.join(", ")}`);
    data.selectionSide = side;
  }

  if (!partial || input.outcome !== undefined) {
    const outcome = (str(input.outcome) || "pending").toLowerCase();
    if (!OUTCOMES.includes(outcome as Outcome))
      throw new ValidationError(`outcome must be one of ${OUTCOMES.join(", ")}`);
    data.outcome = outcome;
  }

  if (input.eventAt !== undefined) {
    const s = str(input.eventAt);
    if (s) {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new ValidationError("eventAt is not a valid date");
      data.eventAt = d;
    } else {
      data.eventAt = null;
    }
  }

  if (input.line !== undefined) data.line = num(input.line);
  if (input.closingOdds !== undefined) data.closingOdds = num(input.closingOdds);
  if (input.sportKey !== undefined) data.sportKey = str(input.sportKey);
  if (input.sport !== undefined) data.sport = str(input.sport);
  if (input.league !== undefined) data.league = str(input.league);
  if (input.homeTeam !== undefined) data.homeTeam = str(input.homeTeam);
  if (input.awayTeam !== undefined) data.awayTeam = str(input.awayTeam);
  if (input.betType !== undefined) data.betType = str(input.betType) || "single";
  if (input.externalRef !== undefined) data.externalRef = str(input.externalRef);
  if (input.bookmaker !== undefined) data.bookmaker = str(input.bookmaker);
  if (input.tipster !== undefined) data.tipster = str(input.tipster);
  if (input.notes !== undefined) data.notes = str(input.notes);
  if (input.legs !== undefined)
    data.legs = input.legs ? JSON.stringify(input.legs) : null;

  // Recompute profit when we have enough info.
  const finalOutcome = (data.outcome ?? existing?.outcome) as Outcome | undefined;
  const finalOdds = (data.odds ?? existing?.odds) as number | undefined;
  const finalStake = (data.stakeUnits ?? existing?.stakeUnits) as number | undefined;

  if (finalOutcome !== undefined && finalOdds !== undefined && finalStake !== undefined) {
    if (finalOutcome === "pending") {
      data.profitUnits = null;
      data.gradedAt = null;
    } else {
      data.profitUnits = profitUnits(finalOutcome, finalOdds, finalStake);
      if (data.gradedAt === undefined) data.gradedAt = new Date();
    }
  }

  return data;
}
