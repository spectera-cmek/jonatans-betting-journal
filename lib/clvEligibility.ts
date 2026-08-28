// Vilka spel kan The Odds API faktiskt prissätta?
//
// The Odds API:s "featured markets" är tre: h2h, totals och spreads — och för
// fotboll betyder de matchvinnare, MÅL totalt och asiatiskt handikapp. Inget
// annat.
//
// Kolumnen `market` i databasen är däremot inte den semantiska marknaden utan
// avräkningstypen (se lib/betTaxonomy.ts): ett spel på "Athletic Bilbao — över
// 3.5 offside" ligger som `market: "totals"`. Frågar man API:t om `totals` för
// den matchen får man priset på över/under 3,5 MÅL — ett helt annat spel, och
// ett tyst fel: siffran ser rimlig ut och hamnar i CLV-snittet.
//
// Av 626 spel som passerade det gamla filtret (single + match + featured +
// icke-spelare) var 296 hörnor, kort, skott, offside, kills, kartor, halvlekar
// eller kombinerade totaler. Nästan hälften hade fått fel closing.
//
// Därför gäller: hellre ingen CLV än fel CLV. Allt som inte säkert är en
// featured-marknad avvisas, med ett skäl som går att läsa i loggen.

import { inferSportKey } from "./eventLink";

/** The Odds API:s featured markets. */
export const FEATURED_MARKETS = ["h2h", "totals", "spreads"] as const;
export type FeaturedMarket = (typeof FEATURED_MARKETS)[number];

/**
 * Semantiska kategorier som motsvarar en featured-marknad rakt av.
 * `marketCategory` är normaliserad av lib/betTaxonomy.ts.
 */
const CATEGORY_FOR_MARKET: Record<FeaturedMarket, ReadonlySet<string>> = {
  h2h: new Set(["matchvinnare"]),
  totals: new Set(["totalt", "mål"]),
  spreads: new Set(["handikapp", "asian handicap"]),
};

/**
 * Sporter API:t täcker, och vilka featured-marknader som är meningsfulla där.
 *
 * Kampsport har bara h2h: "totalt" där är ronder, inte mål, och en träff på fel
 * enhet är precis det tysta felet vi undviker. Esport saknas helt — "totalt" är
 * kills eller kartor. Tennis saknas också, men av ett annat skäl: The Odds API
 * har ingen generell tennisnyckel, bara en per turnering (se inferSportKey).
 */
const MARKETS_BY_SPORT: Record<string, ReadonlySet<FeaturedMarket>> = {
  football: new Set(["h2h", "totals", "spreads"]),
  basketball: new Set(["h2h", "totals", "spreads"]),
  baseball: new Set(["h2h", "totals", "spreads"]),
  "ice hockey": new Set(["h2h", "totals", "spreads"]),
  "american football": new Set(["h2h", "totals", "spreads"]),
  mma: new Set(["h2h"]),
  boxing: new Set(["h2h"]),
};

/**
 * Ordstammar som diskvalificerar — matchar ett ord som BÖRJAR så här, för att
 * täcka svenska böjningar ("hörnor", "skottet", "halvleken").
 */
const BLOCKING_STEMS = [
  "hörn", "korner", "offside", "skott", "räddning", "utvisning", "frispark",
  "halvlek", "kvart", "period", "inning", "assist", "retur", "rebound",
  "trepoäng", "frikast", "strikeout", "poäng", "runda", "rundor", "karta",
  "kartor", "dubbelchans", "kombination", "avancemang", "specialspel",
  "vinstmetod", "straffar", "förläng",
];

/**
 * Ord som diskvalificerar bara som HELA ord.
 *
 * De är för korta eller för vanliga för att stamma-matchas: "kort" ligger i
 * Kortrijk, "set" i Somerset, "hit" i Whitecaps och "game" i Gameiro — alla
 * riktiga lagnamn som annars hade sorterats bort.
 */
const BLOCKING_WORDS = new Set([
  "kort", "card", "cards", "foul", "fouls", "set", "sets", "game", "games",
  "rond", "ronder", "map", "maps", "kill", "kills", "hit", "hits", "point",
  "points", "save", "saves", "shot", "shots", "sog", "ess", "ace", "aces",
  "bas", "baser", "walk", "walks", "quarter", "quartern", "halftime", "dnb",
  "träff", "träffar", "180s",
]);

/**
 * Fraser som diskvalificerar.
 *
 * De fångar spel där kategorin ser rätt ut men urvalet avslöjar något annat:
 * "Schweiz +0.5 (1:a halvlek Asian handicap)" är kategori Handikapp men gäller
 * en halvlek, och "Över 5.5 mål tillsammans" är kategori Totalt men summerar
 * flera matcher.
 */
const BLOCKING_PHRASES = [
  "tillsammans", "bet builder", "double chance", "pengarna tillbaka",
  "draw no bet", "home run", "första mål", "first goal", "anytime goalscorer",
  // Serievinnare i slutspel ligger som "Matchvinnare" men gäller hela serien,
  // inte matchen — och fick matchens h2h-pris.
  "vinnare av serien", "serievinnare", "series winner", "vinnare av matchserien",
  // Lagtotal, inte matchtotal: "Antal mål för England: Över 3.5" hämtade
  // priset på över 3,5 mål i HELA matchen.
  "mål för", "goals for", "team total", "lagtotal",
];

/** "3-0", "3–0", "2:1" — ett korrekt resultat, aldrig en h2h-utgång. */
const SCORELINE = /\b\d{1,2}\s*[-–—:]\s*\d{1,2}\b/;

/**
 * Rimliga totallinjer per sport.
 *
 * Sista nätet för spel som saknar kategori: en fotbollstotal på 22,5 är hörnor
 * eller kort, aldrig mål, och skulle annars hämta målpriset på 22,5 — som inte
 * finns, eller värre, som finns för en helt annan linje.
 */
const TOTAL_LINE_RANGE: Record<string, [number, number]> = {
  football: [0.5, 8.5],
  basketball: [80, 320],
  baseball: [4.5, 18.5],
  "ice hockey": [3.5, 10.5],
  "american football": [25.5, 75.5],
};

/** Notering som stänger av CLV-hämtning för ett enskilt spel. */
export const CLV_SKIP_MARKER = "[clv:skip]";

export interface EligibilityBet {
  betType?: string | null;
  eventKind?: string | null;
  market?: string | null;
  marketCategory?: string | null;
  marketScope?: string | null;
  selection?: string | null;
  line?: number | null;
  sport?: string | null;
  league?: string | null;
  sportKey?: string | null;
  eventAt?: Date | string | null;
  notes?: string | null;
  boosted?: boolean | null;
}

export type Eligibility =
  | { ok: true; market: FeaturedMarket; sportKey: string }
  | { ok: false; reason: string };

function folded(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase("sv-SE").trim();
}

/** Orden i en text, skiljetecken och siffror bortsorterade. */
function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Första diskvalificerande ordet/frasen i texten, eller null.
 * Exporterad för testerna — reglerna är lättast att bevisa en sträng i taget.
 */
export function findBlocker(text: string): string | null {
  for (const phrase of BLOCKING_PHRASES) {
    if (text.includes(phrase)) return phrase;
  }
  for (const word of words(text)) {
    if (BLOCKING_WORDS.has(word)) return word;
    const stem = BLOCKING_STEMS.find((s) => word.startsWith(s));
    if (stem) return stem;
  }
  return null;
}

/**
 * Kan The Odds API:s featured-marknader prissätta det här spelet?
 *
 * Returnerar sportKey också, eftersom ett spel utan härledbar sportKey inte går
 * att slå upp och alltså är oanvändbart även om marknaden stämmer.
 */
export function oddsApiClvEligibility(bet: EligibilityBet): Eligibility {
  if (bet.betType && bet.betType !== "single") return { ok: false, reason: "kupong, inte singel" };
  if (bet.eventKind && bet.eventKind !== "match") return { ok: false, reason: "inte en match" };
  if (!bet.eventAt) return { ok: false, reason: "saknar avsparkstid" };

  if (folded(bet.notes).includes(CLV_SKIP_MARKER)) {
    return { ok: false, reason: "markerad [clv:skip]" };
  }

  // Ett boostat pris är inte ett marknadspris. Att jämföra det mot closing ger
  // en påhittad edge, så spelet hämtas inte alls.
  if (bet.boosted) return { ok: false, reason: "oddsboost — inte ett marknadspris" };

  const market = folded(bet.market);
  if (!FEATURED_MARKETS.includes(market as FeaturedMarket)) {
    return { ok: false, reason: `marknad "${bet.market ?? "—"}" är inte featured` };
  }
  const featured = market as FeaturedMarket;

  if (folded(bet.marketScope) === "player") {
    return { ok: false, reason: "spelarmarknad" };
  }

  const category = folded(bet.marketCategory);
  if (category && !CATEGORY_FOR_MARKET[featured].has(category)) {
    return { ok: false, reason: `kategori "${bet.marketCategory}" ≠ ${featured}` };
  }

  const selection = folded(bet.selection);
  const blocker = findBlocker(`${selection} ${category}`);
  if (blocker) return { ok: false, reason: `urvalet nämner "${blocker}"` };

  // "Sinner 3-0" är ett korrekt resultat, men om selectionSide råkar vara satt
  // mappas det rakt av till h2h-priset. Resultatsiffror stoppas därför här.
  if (featured === "h2h" && SCORELINE.test(selection)) {
    return { ok: false, reason: "urvalet är ett resultat, inte en utgång" };
  }

  const sportKey = bet.sportKey && !bet.sportKey.startsWith("tsa:")
    ? bet.sportKey
    : inferSportKey(bet.sport, bet.league);
  if (!sportKey) {
    return { ok: false, reason: `ingen Odds API-liga för ${bet.sport ?? "—"}/${bet.league ?? "—"}` };
  }

  const sport = normalizedSport(bet.sport, sportKey);
  const allowed = MARKETS_BY_SPORT[sport];
  if (!allowed) return { ok: false, reason: `sporten ${bet.sport ?? sport} täcks inte` };
  if (!allowed.has(featured)) {
    return { ok: false, reason: `${featured} finns inte för ${bet.sport ?? sport}` };
  }

  if (featured === "totals") {
    if (bet.line == null) return { ok: false, reason: "totals utan linje" };
    // The Odds API:s `totals` är HELA matchens mål. En lagtotal har samma
    // kategori och samma linje men ett helt annat pris.
    if (folded(bet.marketScope) === "team") {
      return { ok: false, reason: "lagtotal, inte matchtotal" };
    }
    const range = TOTAL_LINE_RANGE[sport];
    if (range && (bet.line < range[0] || bet.line > range[1])) {
      return {
        ok: false,
        reason: `linjen ${bet.line} är ingen ${sport}-total (${range[0]}–${range[1]})`,
      };
    }
  }
  if (featured === "spreads" && bet.line == null) {
    return { ok: false, reason: "handikapp utan linje" };
  }

  return { ok: true, market: featured, sportKey };
}

/** Svensk/engelsk sportetikett → nyckeln i MARKETS_BY_SPORT, med sportKey som reserv. */
function normalizedSport(sport: string | null | undefined, sportKey: string): string {
  const s = folded(sport);
  if (s === "fotboll" || s === "soccer" || s === "football") return "football";
  if (s === "basket" || s === "basketball") return "basketball";
  if (s === "ishockey" || s === "ice hockey") return "ice hockey";
  if (s === "amerikansk fotboll" || s === "american football") return "american football";
  if (s === "boxning" || s === "boxing") return "boxing";
  if (s === "baseball" || s === "tennis" || s === "mma") return s;
  if (s) return s;

  // Sport saknas i raden — härled ur sportKey i stället för att avvisa.
  if (sportKey.startsWith("soccer_")) return "football";
  if (sportKey.startsWith("basketball_")) return "basketball";
  if (sportKey.startsWith("baseball_")) return "baseball";
  if (sportKey.startsWith("icehockey_")) return "ice hockey";
  if (sportKey.startsWith("americanfootball_")) return "american football";
  if (sportKey.startsWith("tennis_")) return "tennis";
  if (sportKey.startsWith("mma_")) return "mma";
  return sportKey;
}
