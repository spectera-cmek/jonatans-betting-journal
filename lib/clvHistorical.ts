// Closing odds i efterhand, ur The Odds API:s historiska ögonblicksbilder.
//
// Den gamla vägen (lib/clvOddsApi.ts) hämtar live-priset i fönstret T-30…T+5
// minuter och kallar det closing. Den fungerar bara om något kör precis då —
// och det gjorde det aldrig: den schemalagda Windows-uppgiften saknade nyckel
// i 264 körningar och togs sedan bort. Noll closing hämtades på en månad.
//
// Historik-endpointen tar bort tidsberoendet helt. Man frågar efter matchlistan
// och oddsen som de såg ut två minuter före avspark, när som helst efteråt. Då
// räcker en cron om dygnet, och eftersläpningen kan hämtas ikapp.
//
// Priset är krediter: 1 för matchlistan, 10 per marknad för en matchs odds.
// Budgeten nedan håller en körning innanför månadskvoten.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db";
import { clvPct } from "./betting";
import {
  getHistoricalEventOdds,
  getHistoricalEvents,
  hasOddsApiKey,
  historicalDateParam,
  referencePriceFor,
  type HistoricalEvent,
  type OddsApiQuota,
} from "./oddsApi";
import { matchOddsEvent } from "./eventLink";
import { oddsApiOutcomeForBet } from "./clvOddsApi";
import { FEATURED_MARKETS, oddsApiClvEligibility } from "./clvEligibility";

/** Hur långt före avspark ögonblicksbilden tas. Snapshots ligger var 5:e minut. */
const SNAPSHOT_LEAD_MS = 2 * 60 * 1000;
/** Avspark måste ha passerat med marginal — annars finns ingen closing än. */
const SETTLE_GRACE_MS = 15 * 60 * 1000;
/**
 * Hur långt API:ets avspark får ligga från loggens innan matchningen förkastas.
 *
 * Rader med klockslag ska stämma på timmen; rader som står på midnatt vet bara
 * vilket dygn det gäller. Utan den snävare gränsen kan ett slutspel med matcher
 * varannan dag para ihop spelet med fel match i serien.
 */
const MAX_DRIFT_TIMED_MS = 12 * 60 * 60 * 1000;
const MAX_DRIFT_DATE_ONLY_MS = 36 * 60 * 60 * 1000;
/** Krediter: 1 för matchlistan, 10 per marknad för en matchs odds (en region). */
const CREDITS_PER_EVENT_LIST = 1;
const CREDITS_PER_MARKET = 10;

/**
 * Referensböcker, i tur och ordning. Pinnacle först — det är den skarpa
 * closing-linjen CLV egentligen mäts mot. Ingen reserv till "högsta pris bland
 * alla böcker": det är inte en closing-linje, det är brus.
 */
const REFERENCE_BOOKS = [
  "pinnacle",
  "betfair_ex_eu",
  "bet365",
  "unibet",
  "williamhill",
  "marathonbet",
  "onexbet",
];

export interface HistoricalClvOptions {
  /** Hur långt tillbaka spel hämtas (dagar, default 60). */
  sinceDays?: number;
  /** Max antal spel per körning. */
  limit?: number;
  /** Kredittak för körningen. */
  maxCredits?: number;
  /** Avbryt när kvoten sjunkit hit — sparar krediter till resten av månaden. */
  minRemaining?: number;
  /** Absolut sluttid (Date.now()-ms). Skyddar mot serverless-timeout. */
  deadlineMs?: number;
  dryRun?: boolean;
  betIds?: string[];
  prisma?: PrismaClient;
}

export interface HistoricalClvResult {
  scanned: number;
  eligible: number;
  linked: number;
  closingUpdated: number;
  failed: number;
  creditsSpent: number;
  remaining: number | null;
  stopped: string | null;
  details: string[];
}

type Candidate = {
  id: string;
  event: string;
  homeTeam: string | null;
  awayTeam: string | null;
  eventAt: Date | null;
  sport: string | null;
  league: string | null;
  sportKey: string | null;
  externalRef: string | null;
  market: string;
  marketCategory: string | null;
  marketScope: string | null;
  selection: string;
  selectionSide: string | null;
  line: number | null;
  bookmaker: string | null;
  notes: string | null;
  boosted: boolean;
  odds: number;
};

/** True när raden bara har ett datum — klockan står på midnatt UTC. */
export function isDateOnly(eventAt: Date): boolean {
  return eventAt.getTime() % (24 * 60 * 60 * 1000) === 0;
}

/** Ögonblicksbilden som används för ett spel: två minuter före avspark. */
export function snapshotFor(eventAt: Date): string {
  return historicalDateParam(new Date(eventAt.getTime() - SNAPSHOT_LEAD_MS));
}

/**
 * Matchlistan slås upp per sport och femminutersruta i stället för per exakt
 * avsparkstid: fixturerna ändras inte mellan två snapshots, och en söndag med
 * åtta matcher som startar 15:00 blir då ett anrop i stället för åtta.
 */
export function eventListSnapshot(eventAt: Date): string {
  const at = eventAt.getTime() - SNAPSHOT_LEAD_MS;
  return historicalDateParam(new Date(Math.floor(at / 300_000) * 300_000));
}

/** Spårar krediter och stoppar körningen innan kvoten tar slut. */
class CreditBudget {
  spent = 0;
  remaining: number | null = null;
  stopped: string | null = null;

  constructor(
    private readonly maxCredits: number,
    private readonly minRemaining: number,
    private readonly deadlineMs: number
  ) {}

  /** Har vi råd med nästa anrop — i krediter och i tid? */
  canAfford(cost: number): boolean {
    if (this.stopped) return false;
    if (Date.now() > this.deadlineMs) {
      this.stopped = "tidsgräns nådd — kör igen för nästa omgång";
      return false;
    }
    if (this.spent + cost > this.maxCredits) {
      this.stopped = `kredittak nått (${this.maxCredits})`;
      return false;
    }
    if (this.remaining != null && this.remaining - cost < this.minRemaining) {
      this.stopped = `kvoten nere på ${this.remaining} — sparar resten`;
      return false;
    }
    return true;
  }

  /** Bokför vad anropet faktiskt kostade, enligt svarshuvudet. */
  record(quota: OddsApiQuota, assumed: number): void {
    this.spent += quota.last ?? assumed;
    if (quota.remaining != null) this.remaining = quota.remaining;
  }
}

/**
 * Hämta closing i efterhand för spel som saknar den.
 *
 * Kör i tre steg per grupp: slå upp matchen i den historiska matchlistan, spara
 * länken, och hämta matchens odds vid samma tidpunkt.
 */
export async function captureHistoricalClv(
  opts: HistoricalClvOptions = {}
): Promise<HistoricalClvResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const details: string[] = [];
  const empty = {
    scanned: 0,
    eligible: 0,
    linked: 0,
    closingUpdated: 0,
    failed: 0,
    creditsSpent: 0,
    remaining: null,
    stopped: null,
  };

  if (!hasOddsApiKey()) {
    return {
      ...empty,
      stopped: "ODDS_API_KEY saknas",
      details: ["ODDS_API_KEY saknas i miljön — ingen closing kan hämtas."],
    };
  }

  const sinceDays = opts.sinceDays ?? 60;
  const limit = opts.limit ?? 60;
  const budget = new CreditBudget(
    opts.maxCredits ?? 2000,
    opts.minRemaining ?? 500,
    opts.deadlineMs ?? Date.now() + 10 * 60 * 1000
  );
  const dryRun = !!opts.dryRun;

  const now = Date.now();
  const from = new Date(now - sinceDays * 24 * 60 * 60 * 1000);
  const until = new Date(now - SETTLE_GRACE_MS);

  const candidates = (await prisma.bet.findMany({
    where: {
      closingOdds: null,
      betType: "single",
      eventKind: "match",
      market: { in: [...FEATURED_MARKETS] },
      eventAt: { gte: from, lte: until },
      OR: [{ marketScope: null }, { marketScope: { not: "player" } }],
      ...(opts.betIds?.length ? { id: { in: opts.betIds } } : {}),
    },
    orderBy: { eventAt: "desc" },
    // Över­hämta: behörighetsprövningen sållar hårt, och utan marginal
    // returnerar en körning bara en handfull spel.
    take: Math.max(limit * 6, 120),
    select: {
      id: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
      eventAt: true,
      sport: true,
      league: true,
      sportKey: true,
      externalRef: true,
      market: true,
      marketCategory: true,
      marketScope: true,
      selection: true,
      selectionSide: true,
      line: true,
      bookmaker: true,
      notes: true,
      boosted: true,
      odds: true,
    },
  })) as Candidate[];

  const scanned = candidates.length;
  const rejected = new Map<string, number>();
  const eligible: { bet: Candidate; market: string; sportKey: string }[] = [];

  for (const bet of candidates) {
    const verdict = oddsApiClvEligibility(bet);
    if (!verdict.ok) {
      rejected.set(verdict.reason, (rejected.get(verdict.reason) ?? 0) + 1);
      continue;
    }
    if (eligible.length >= limit) break;
    eligible.push({ bet, market: verdict.market, sportKey: verdict.sportKey });
  }

  details.push(`${scanned} kandidater, ${eligible.length} hämtbara`);
  for (const [reason, count] of [...rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    details.push(`  ${count}× hoppade: ${reason}`);
  }

  if (eligible.length === 0) {
    return { ...empty, scanned, details };
  }

  // --- Steg 1: hitta matchen i den historiska matchlistan -------------------
  const eventLists = new Map<string, HistoricalEvent[]>();
  let linked = 0;
  let failed = 0;
  const resolved: {
    bet: Candidate;
    market: string;
    sportKey: string;
    eventId: string;
    commenceTime: string;
  }[] = [];

  /** Matchlistan vid en tidpunkt, delad mellan spel och cachad. */
  const listAt = async (sportKey: string, at: Date) => {
    const stamp = eventListSnapshot(at);
    const listKey = `${sportKey}|${stamp}`;
    const cached = eventLists.get(listKey);
    if (cached) return cached;
    if (!budget.canAfford(CREDITS_PER_EVENT_LIST)) return null;
    const res = await getHistoricalEvents(sportKey, stamp);
    budget.record(res.quota, CREDITS_PER_EVENT_LIST);
    const events = res.data.data ?? [];
    eventLists.set(listKey, events);
    return events;
  };

  for (const row of eligible) {
    const { bet, sportKey } = row;

    let events: HistoricalEvent[] | null = null;
    let match: HistoricalEvent | null = null;
    try {
      events = await listAt(sportKey, bet.eventAt!);
      if (!events) break; // budgeten slut
      match = matchOddsEvent(bet, events);

      // Rader med bara ett datum står på midnatt, så ögonblicksbilden kan hamna
      // efter en match som redan spelats — och då är fixturen borta ur listan.
      // Ett försök ett halvdygn tidigare hittar den.
      if (!match) {
        const earlier = await listAt(sportKey, new Date(bet.eventAt!.getTime() - 12 * 60 * 60 * 1000));
        if (earlier) {
          events = earlier;
          match = matchOddsEvent(bet, earlier);
        }
      }
    } catch (e) {
      budget.record(
        { remaining: budget.remaining, used: null, last: CREDITS_PER_EVENT_LIST },
        CREDITS_PER_EVENT_LIST
      );
      details.push(`${bet.event}: matchlista ${sportKey} — ${(e as Error).message}`);
      failed += 1;
      continue;
    }

    if (!match) {
      details.push(`${bet.event}: ingen match i ${sportKey} (${events?.length ?? 0} fixturer)`);
      failed += 1;
      continue;
    }

    // Avsparken enligt API:t kan ligga i framtiden även när loggens datum
    // passerat. Då finns ingen closing än — vänta till nästa körning.
    if (new Date(match.commence_time).getTime() > now - SETTLE_GRACE_MS) {
      details.push(`${bet.event}: avspark ${match.commence_time.slice(0, 16)} — inte spelad än`);
      continue;
    }

    // Många rader har bara ett datum, så eventAt står på midnatt. Frågar man
    // efter oddsen då får man linjen ett halvt dygn (ibland flera dagar) före
    // avspark — ett öppningspris som kallas closing. API:ets commence_time är
    // den riktiga avsparken och är det ögonblicksbilden ska utgå från.
    const driftMs = Math.abs(
      new Date(match.commence_time).getTime() - bet.eventAt!.getTime()
    );
    const maxDrift = isDateOnly(bet.eventAt!) ? MAX_DRIFT_DATE_ONLY_MS : MAX_DRIFT_TIMED_MS;
    if (driftMs > maxDrift) {
      details.push(
        `${bet.event}: närmaste match ${match.commence_time.slice(0, 16)} ligger ${(driftMs / 3.6e6).toFixed(0)} h från ${bet.eventAt!.toISOString().slice(0, 16)} — för osäkert`
      );
      failed += 1;
      continue;
    }
    if (driftMs > 3 * 60 * 60 * 1000) {
      details.push(
        `${bet.event}: avspark ${match.commence_time.slice(0, 16)} i API:t, ${bet.eventAt!.toISOString().slice(0, 16)} i loggen — använder API:ets`
      );
    }

    if (!dryRun && bet.externalRef !== match.id) {
      await prisma.bet.update({
        where: { id: bet.id },
        data: { externalRef: match.id, sportKey },
      });
      linked += 1;
    }
    resolved.push({ ...row, eventId: match.id, commenceTime: match.commence_time });
  }

  // --- Steg 2: hämta matchens odds vid samma tidpunkt -----------------------
  // En förfrågan per match och ögonblicksbild, med alla marknader spelen på den
  // matchen behöver — marknad två kostar tio krediter extra, inte ett nytt anrop.
  const groups = new Map<
    string,
    { sportKey: string; eventId: string; date: string; markets: Set<string>; bets: typeof resolved }
  >();
  for (const row of resolved) {
    const date = snapshotFor(new Date(row.commenceTime));
    const key = `${row.sportKey}|${row.eventId}|${date}`;
    const group = groups.get(key) ?? {
      sportKey: row.sportKey,
      eventId: row.eventId,
      date,
      markets: new Set<string>(),
      bets: [] as typeof resolved,
    };
    group.markets.add(row.market);
    group.bets.push(row);
    groups.set(key, group);
  }

  let closingUpdated = 0;

  for (const group of groups.values()) {
    const markets = [...group.markets];
    const cost = CREDITS_PER_MARKET * markets.length;
    if (!budget.canAfford(cost)) break;

    let event;
    try {
      const res = await getHistoricalEventOdds(group.sportKey, group.eventId, group.date, {
        regions: "eu",
        markets: markets.join(","),
      });
      budget.record(res.quota, cost);
      event = res.data.data;
    } catch (e) {
      budget.record({ remaining: budget.remaining, used: null, last: cost }, cost);
      details.push(`${group.bets[0]?.bet.event}: odds — ${(e as Error).message}`);
      failed += group.bets.length;
      continue;
    }

    for (const { bet, market } of group.bets) {
      const target = oddsApiOutcomeForBet(bet, event);
      if (!target || target.market !== market) {
        details.push(`${bet.event}: kunde inte mappa "${bet.selection}" → ${market}`);
        failed += 1;
        continue;
      }

      const picked = referencePriceFor(
        event,
        target.market,
        target.outcomeName,
        target.point,
        REFERENCE_BOOKS
      );
      if (!picked) {
        details.push(
          `${bet.event}: ingen referensbok noterade ${target.market} ${target.outcomeName}${target.point != null ? ` ${target.point}` : ""}`
        );
        failed += 1;
        continue;
      }

      const pct = clvPct(bet.odds, picked.price);
      details.push(
        `${bet.event} — ${bet.selection}: closing ${picked.price.toFixed(2)} (${picked.bookmaker}), du ${bet.odds.toFixed(2)}, CLV ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%${dryRun ? " [dry-run]" : ""}`
      );

      if (!dryRun) {
        await prisma.bet.update({
          where: { id: bet.id },
          data: { closingOdds: picked.price },
        });
      }
      closingUpdated += 1;
    }
  }

  if (budget.stopped) details.push(`Stoppad: ${budget.stopped}`);

  return {
    scanned,
    eligible: eligible.length,
    linked,
    closingUpdated,
    failed,
    creditsSpent: budget.spent,
    remaining: budget.remaining,
    stopped: budget.stopped,
    details,
  };
}
