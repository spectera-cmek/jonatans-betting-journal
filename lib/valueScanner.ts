// Cross-book odds comparison for standard H2H/1X2 markets.
//
// A book's own prices are first de-vigged proportionally. The median of those
// fair probabilities is a robust consensus; we then compare the best available
// price against it. This is a signal for price-shopping, not a claim that the
// consensus is the true probability.

import type { OddsEvent, OddsMarket } from "./oddsApi";

export interface ValuePlay {
  eventId: string;
  sportTitle: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  selection: string;
  bestOdds: number;
  bookmaker: string;
  bookmakerKey: string;
  fairOdds: number;
  fairProbability: number;
  edge: number;
  consensusBookmakers: number;
}

export interface ValueScanResult {
  rows: ValuePlay[];
  scannedEvents: number;
}

type PricedOutcome = {
  name: string;
  price: number;
};

type BookQuote = {
  bookmaker: string;
  bookmakerKey: string;
  outcomes: PricedOutcome[];
};

const validPrice = (price: number) => Number.isFinite(price) && price > 1;

function marketSignature(outcomes: PricedOutcome[]) {
  return outcomes
    .map((outcome) => outcome.name.trim().toLocaleLowerCase())
    .sort()
    .join("|");
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quotesForEvent(event: OddsEvent): BookQuote[] {
  const quotes: BookQuote[] = [];
  for (const bookmaker of event.bookmakers || []) {
    const market = (bookmaker.markets || []).find((item: OddsMarket) => item.key === "h2h");
    if (!market) continue;
    const outcomes = market.outcomes
      .filter((outcome) => validPrice(outcome.price) && outcome.name.trim() !== "")
      .map((outcome) => ({ name: outcome.name, price: outcome.price }));
    if (outcomes.length < 2) continue;
    quotes.push({ bookmaker: bookmaker.title, bookmakerKey: bookmaker.key, outcomes });
  }
  return quotes;
}

/**
 * Find the best available H2H price for every selection and rank it against
 * the de-vigged cross-book consensus. Require several independent books so a
 * single stray quote never becomes a supposed edge.
 */
export function scanValuePlays(events: OddsEvent[], minBookmakers = 3): ValueScanResult {
  const rows: ValuePlay[] = [];

  for (const event of events) {
    const grouped = new Map<string, BookQuote[]>();
    for (const quote of quotesForEvent(event)) {
      const signature = marketSignature(quote.outcomes);
      const group = grouped.get(signature);
      if (group) group.push(quote);
      else grouped.set(signature, [quote]);
    }

    // A draw/no-draw mismatch is a different market. Use the most widely
    // quoted complete market only, rather than mixing the two price sets.
    const compatible = [...grouped.values()].sort((a, b) => b.length - a.length)[0];
    if (!compatible || compatible.length < minBookmakers) continue;

    const selectionNames = compatible[0].outcomes.map((outcome) => outcome.name);
    for (const selection of selectionNames) {
      const consensus = compatible.map((quote) => {
        const impliedTotal = quote.outcomes.reduce((sum, outcome) => sum + 1 / outcome.price, 0);
        const price = quote.outcomes.find((outcome) => outcome.name === selection)?.price;
        return price ? 1 / price / impliedTotal : NaN;
      }).filter(Number.isFinite);
      if (consensus.length < minBookmakers) continue;

      const fairProbability = median(consensus);
      if (!(fairProbability > 0) || fairProbability >= 1) continue;
      const best = compatible
        .map((quote) => ({
          bookmaker: quote.bookmaker,
          bookmakerKey: quote.bookmakerKey,
          price: quote.outcomes.find((outcome) => outcome.name === selection)?.price ?? 0,
        }))
        .filter((quote) => validPrice(quote.price))
        .sort((a, b) => b.price - a.price)[0];
      if (!best) continue;

      rows.push({
        eventId: event.id,
        sportTitle: event.sport_title,
        commenceTime: event.commence_time,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        selection,
        bestOdds: best.price,
        bookmaker: best.bookmaker,
        bookmakerKey: best.bookmakerKey,
        fairOdds: 1 / fairProbability,
        fairProbability,
        edge: best.price * fairProbability - 1,
        consensusBookmakers: compatible.length,
      });
    }
  }

  return {
    rows: rows.sort((a, b) => b.edge - a.edge),
    scannedEvents: events.length,
  };
}
