// Kvitto-tolkning → förifyllt formulär i AddBetModal.
//
// Ren funktion utan React så mappningen kan enhetstestas: det som står på
// kvittot ska följa med hela vägen in i loggen — bookmaker, typ av spel
// (singel/kombination/bet builder), avspark med klockslag och eventtyp. Fält
// kvittot inte visar lämnas TOMMA i stället för att ärva formulärets defaults
// (annars loggas t.ex. varje oläst kvitto som "Bet365").

import { normalizeBookmaker } from "./constants";
import { inferEventKind } from "./betTaxonomy";
import { dayIso } from "./time";
import type { ParsedBetWithDupe } from "./betslipExtract";

/** Formulärfälten ett kvitto kan fylla i — en delmängd av AddBetModals Form. */
export interface BetslipFormFields {
  eventAt: string;
  event: string;
  selection: string;
  market: string;
  odds: string;
  stakeUnits: string;
  betType: string;
  bookmaker: string;
  eventKind: string;
  selectionSide: string;
  sport?: string;
  league?: string;
  homeTeam?: string;
  awayTeam?: string;
  marketCategory?: string;
  marketScope?: string;
  line?: string;
}

export interface BetslipPrefill {
  form: BetslipFormFields;
  importRef?: string | null;
  placedAt?: string | null;
  /** Matchstart med klockslag när kvittot visar den — datumfältet i formuläret
   *  rymmer bara datum, men kickoff-CLV behöver tiden. */
  eventAtIso?: string | null;
  legs?: unknown;
  duplicate?: { betId: string; event: string; selection: string } | null;
  queue?: { index: number; total: number };
}

const BET_TYPES = new Set(["single", "accumulator", "betbuilder"]);

/** Tidsstämpeln som svensk kalenderdag (YYYY-MM-DD); ogiltig/tom → null. */
function swedishDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dayIso(d);
}

/** Avspark med klockslag — bara ett datum duger inte för kickoff-CLV. */
function kickoffIso(iso: string | null | undefined): string | null {
  if (!iso || !/\d{1,2}:\d{2}/.test(iso)) return null;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** Lag-mot-lag i eventtexten ("Arsenal vs Chelsea", "Arsenal – Chelsea"). */
function looksLikeFixture(event: string): boolean {
  return /\bvs\.?\b|\bv\.\b|\s[–—-]\s|\s@\s/i.test(event);
}

export function betslipPrefill(
  parsed: ParsedBetWithDupe,
  opts: { unitValue: number; index?: number; total?: number }
): BetslipPrefill {
  const { unitValue, index = 0, total = 1 } = opts;
  const eventAtIso = kickoffIso(parsed.eventAt);
  const day = swedishDay(parsed.eventAt) ?? swedishDay(parsed.placedAt) ?? dayIso(new Date());

  const form: BetslipFormFields = {
    eventAt: day,
    event: parsed.event,
    selection: parsed.selection,
    market: parsed.market,
    // Oläsbart odds/insats → tomt fält, aldrig ett påhittat värde.
    odds: parsed.odds != null && parsed.odds > 1 ? String(parsed.odds) : "",
    stakeUnits:
      parsed.stakeKr != null && parsed.stakeKr > 0 && unitValue > 0
        ? String(+(parsed.stakeKr / unitValue).toFixed(2))
        : "",
    // Bet Builder är en egen speltyp i appen — den får aldrig falla tillbaka
    // till "single", då tappas kombons ben och kombo-varningen.
    betType: parsed.betType && BET_TYPES.has(parsed.betType) ? parsed.betType : "single",
    // Okänd bookmaker lämnas tom så användaren väljer den i modalen.
    bookmaker: normalizeBookmaker(parsed.bookmaker) ?? "",
    eventKind:
      inferEventKind(parsed.event, parsed.selection) === "outright" ||
      (!parsed.homeTeam && !parsed.awayTeam && !looksLikeFixture(parsed.event))
        ? "outright"
        : "match",
    // Syns ingen sida på kvittot: låt servern härleda den ur selection-texten
    // i stället för att ärva formulärets "home".
    selectionSide: parsed.selectionSide ?? "",
  };
  if (parsed.sport) form.sport = parsed.sport;
  if (parsed.league) form.league = parsed.league;
  if (parsed.homeTeam) form.homeTeam = parsed.homeTeam;
  if (parsed.awayTeam) form.awayTeam = parsed.awayTeam;
  if (parsed.marketCategory) form.marketCategory = parsed.marketCategory;
  if (parsed.marketScope) form.marketScope = parsed.marketScope;
  if (parsed.line != null) form.line = String(parsed.line);

  return {
    form,
    importRef: parsed.importRef,
    placedAt: parsed.placedAt,
    eventAtIso,
    legs: parsed.legs && parsed.legs.length ? parsed.legs : undefined,
    duplicate: parsed.duplicate,
    queue: { index, total },
  };
}
