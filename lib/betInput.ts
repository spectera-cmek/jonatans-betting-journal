// Validate + normalize raw bet input (from the API) into Prisma-ready data.
// Shared by POST (create) and PATCH (update).

import { profitUnits, type Outcome } from "./betting";
import { categorizeDetail, type LegLike } from "./categorize";
import {
  EVENT_KINDS,
  MARKET_SCOPES,
  TOURNAMENT_STAGES,
  inferEventKind,
  normalizeGradingMarket,
  normalizeLeague,
  normalizeMarketCategory,
  normalizeTournamentStage,
} from "./betTaxonomy";
import { normalizeBookmaker } from "./constants";
import { inferSportKey, parseHomeAway } from "./eventLink";

const OUTCOMES: Outcome[] = [
  "pending",
  "win",
  "loss",
  "push",
  "half_win",
  "half_loss",
  "void",
];
const SIDES = ["home", "away", "draw", "over", "under"];
const SCOPES = [...MARKET_SCOPES];

export interface BetInput {
  eventAt?: string | null;
  sportKey?: string | null;
  sport?: string | null;
  league?: string | null;
  event?: string;
  homeTeam?: string | null;
  awayTeam?: string | null;
  market?: string;
  marketCategory?: string | null;
  marketScope?: string | null;
  eventKind?: string | null;
  tournamentStage?: string | null;
  resultProvider?: string | null;
  resultEventRef?: string | null;
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
    const rawMarket = str(input.market);
    const market = rawMarket
      ? normalizeGradingMarket(rawMarket, input.marketCategory, input.selectionSide)
      : "h2h";
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

  // Detaljerad marknad: marketCategory är fritext (curated i UI), marketScope
  // är en av player|team|match. Okända kategorier samlas under Övrigt så
  // filtrering och analys förblir konsekvent.
  if (input.marketCategory !== undefined) {
    const category = str(input.marketCategory);
    data.marketCategory = category ? normalizeMarketCategory(category) : null;
  }
  if (input.marketScope !== undefined) {
    const scope = str(input.marketScope)?.toLowerCase() ?? null;
    if (scope && !SCOPES.includes(scope as (typeof SCOPES)[number]))
      throw new ValidationError(`marketScope must be one of ${SCOPES.join(", ")}`);
    data.marketScope = scope;
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
  if (input.league !== undefined) data.league = normalizeLeague(str(input.league));
  if (input.homeTeam !== undefined) data.homeTeam = str(input.homeTeam);
  if (input.awayTeam !== undefined) data.awayTeam = str(input.awayTeam);
  if (input.betType !== undefined) data.betType = str(input.betType) || "single";
  if (input.externalRef !== undefined) data.externalRef = str(input.externalRef);
  if (input.resultProvider !== undefined) data.resultProvider = str(input.resultProvider)?.toLowerCase() ?? null;
  if (input.resultEventRef !== undefined) data.resultEventRef = str(input.resultEventRef);
  if (input.bookmaker !== undefined) data.bookmaker = normalizeBookmaker(str(input.bookmaker));
  if (input.tipster !== undefined) data.tipster = str(input.tipster);
  if (input.notes !== undefined) data.notes = str(input.notes);
  if (input.legs !== undefined)
    data.legs = input.legs ? JSON.stringify(input.legs) : null;

  if (input.eventKind !== undefined) {
    const eventKind = str(input.eventKind)?.toLowerCase() ?? null;
    if (eventKind && !EVENT_KINDS.includes(eventKind as (typeof EVENT_KINDS)[number]))
      throw new ValidationError(`eventKind must be one of ${EVENT_KINDS.join(", ")}`);
    data.eventKind = eventKind;
  }
  if (input.tournamentStage !== undefined) {
    const rawStage = str(input.tournamentStage);
    const stage = normalizeTournamentStage(rawStage);
    if (rawStage && !stage)
      throw new ValidationError(`tournamentStage must be one of ${TOURNAMENT_STAGES.join(", ")}`);
    data.tournamentStage = stage;
  }

  // On create, auto-derive the detailed market/scope from the selection text
  // (and any imported legs) when the caller didn't supply them — so quick entry
  // and API imports still get tagged. The user can always override later.
  if (!partial) {
    const needCat = data.marketCategory === undefined || data.marketCategory === null;
    const needScope = data.marketScope === undefined || data.marketScope === null;
    const selection = (data.selection as string | undefined) ?? "";
    if ((needCat || needScope) && (selection || data.event)) {
      const legsArr = Array.isArray(input.legs) ? (input.legs as LegLike[]) : [];
      const det = categorizeDetail(
        selection,
        (data.event as string | undefined) ?? null,
        legsArr,
        (data.homeTeam as string | undefined) ?? null,
        (data.awayTeam as string | undefined) ?? null
      );
      if (needCat && det.marketCategory && det.marketCategory !== "Övrigt")
        data.marketCategory = det.marketCategory;
      if (needScope && det.marketScope) data.marketScope = det.marketScope;
    }

    if (!data.homeTeam && !data.awayTeam && data.event) {
      const teams = parseHomeAway(data.event as string);
      if (teams) {
        data.homeTeam = teams.home;
        data.awayTeam = teams.away;
      }
    }

    if (!data.sportKey) {
      const key = inferSportKey(
        (data.sport as string | undefined) ?? input.sport,
        (data.league as string | undefined) ?? input.league
      );
      if (key) data.sportKey = key;
    }

    if (data.eventKind === undefined) {
      data.eventKind = inferEventKind(
        data.event as string | undefined,
        data.selection as string | undefined,
        input.eventKind
      );
    }
  }

  // Recompute profit only when a profit input (outcome/odds/stake) actually
  // changed. A PATCH that touches e.g. notes must NOT overwrite an imported
  // authoritative profitUnits (real payout) with the formula value.
  const profitInputTouched =
    data.outcome !== undefined || data.odds !== undefined || data.stakeUnits !== undefined;
  const finalOutcome = (data.outcome ?? existing?.outcome) as Outcome | undefined;
  const finalOdds = (data.odds ?? existing?.odds) as number | undefined;
  const finalStake = (data.stakeUnits ?? existing?.stakeUnits) as number | undefined;

  if (profitInputTouched && finalOutcome !== undefined && finalOdds !== undefined && finalStake !== undefined) {
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
