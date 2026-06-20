// Personal discipline rules derived from the 2026-06-11 loss analysis of the
// full history (8 588 bets, sep 2023–jun 2026): where money has leaked and
// where the real edge is. Numbers below are from that analysis — update them
// when the analysis is redone.
//
// Pure & dependency-free (besides the market normalizer) so it is trivially
// unit-testable and reusable from both the add-bet modal and scripts.

import { normalizeMarket } from "./categorize";

export interface DisciplineInput {
  sport?: string | null; // display name, e.g. "Basketball"
  selection?: string | null; // free text, e.g. "Bridges över 13.5 skott"
  market?: string | null; // raw code (h2h/totals/spreads/other) or category
  odds?: number | null;
  stakeUnits?: number | null;
  betType?: string | null; // single | accumulator
}

export interface DisciplineNote {
  tone: "pos" | "neg";
  text: string;
}

export interface DisciplineVerdict {
  level: "edge" | "warn" | "mixed" | "none";
  notes: DisciplineNote[];
}

// Categories that historically print money at sane odds.
const EDGE_CATEGORIES: Record<string, string> = {
  Skott: "Skott: +5,9 % ROI över 1 261 bets — din starkaste marknad",
  "Skott på mål": "Skott på mål: del av din starkaste marknad (Skott, +5,9 % ROI)",
  Returer: "Returer: +14,6 % ROI historiskt",
  Hörnor: "Hörnor: +8,4 % ROI historiskt",
  Halvlek: "Halvlek: +1 879 kr historiskt",
};

// Basketball props that have leaked (Returer excluded — it's an edge).
const BASKET_PROP_LEAKS = new Set(["Spelarpoäng", "Assists", "Trepoängare"]);

/**
 * Category for the bet being typed: the free-text selection usually carries
 * the market keywords ("skott", "hörnor", "kort"...), with the market field
 * as fallback. Returns "Övrigt" when nothing matches.
 */
export function betCategory(input: DisciplineInput): string {
  const fromSelection = normalizeMarket(input.selection);
  if (fromSelection !== "Övrigt") return fromSelection;
  return normalizeMarket(input.market);
}

/** Evaluate a bet (typically mid-entry) against the personal leak/edge rules. */
export function evaluateBet(input: DisciplineInput): DisciplineVerdict {
  const notes: DisciplineNote[] = [];
  const odds = input.odds ?? null;
  const stake = input.stakeUnits ?? null;
  const sport = (input.sport ?? "").toLowerCase();
  const category = betCategory(input);
  const isEdgeCategory = category in EDGE_CATEGORIES;

  // --- Leaks ---
  if ((input.betType ?? "").toLowerCase() === "accumulator") {
    notes.push({ tone: "neg", text: "Ackumulatorer: −14 860 kr historiskt (−8,4 % ROI, 28 % träff)" });
  }
  if (odds != null && odds >= 5) {
    notes.push({ tone: "neg", text: "Odds 5+: −20,9 % ROI historiskt — största läckan" });
  } else if (odds != null && odds >= 3) {
    notes.push({ tone: "neg", text: "Odds ≥ 3 har läckt totalt −27 647 kr historiskt" });
  }
  if (odds != null && odds >= 5 && stake != null && stake > 0 && stake <= 0.5) {
    notes.push({ tone: "neg", text: "Småinsats på högt odds = longshot-lotteriet: −8 791 kr historiskt" });
  }
  if (sport === "basketball" && BASKET_PROP_LEAKS.has(category)) {
    notes.push({ tone: "neg", text: `Basketprops (${category}): ≈ −13 100 kr historiskt` });
  } else if (sport === "basketball" && !isEdgeCategory) {
    notes.push({ tone: "neg", text: "Basket som sport: −12 030 kr historiskt" });
  }
  if (sport === "tennis") {
    notes.push({ tone: "neg", text: "Tennis: −15 % ROI historiskt" });
  }
  if (category === "Kort & fouls") {
    notes.push({ tone: "neg", text: "Kort & fouls: −6 712 kr historiskt (−17 % ROI)" });
  }
  if (category === "Handikapp" || (input.market ?? "").toLowerCase() === "spreads") {
    notes.push({ tone: "neg", text: "Handikapp: −7 960 kr historiskt" });
  }

  // --- Edges ---
  const inEdgeOdds = odds != null && odds >= 1.5 && odds < 3;
  if (isEdgeCategory && inEdgeOdds) {
    notes.push({ tone: "pos", text: EDGE_CATEGORIES[category] });
  }
  if (odds != null && odds >= 2 && odds < 3) {
    notes.push({ tone: "pos", text: "Odds 2,00–2,99: +8 582 kr historiskt (+2,7 % ROI)" });
  }
  if (stake != null && stake > 2) {
    notes.push({ tone: "pos", text: "Conviction bets > 2u: +5,5 % ROI historiskt" });
  }

  const hasWarn = notes.some((n) => n.tone === "neg");
  const hasEdge = notes.some((n) => n.tone === "pos");
  const level = hasWarn && hasEdge ? "mixed" : hasWarn ? "warn" : hasEdge ? "edge" : "none";
  return { level, notes };
}
