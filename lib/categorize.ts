// Best-effort categorisation of imported bet365 bets. The statement carries no sport
// or clean market field, so we infer them from the event (team/player names) and the
// per-leg market text. Heuristic by design — uncertain cases fall back to "Other"/"Övrigt".
//
// Pure & dependency-free so it is reusable from scripts and trivially unit-testable.

export interface LegLike {
  selection?: string;
  event?: string;
  market?: string | null;
  odds?: number | null;
  outcome?: string;
}

/* ----------------------------- Market categories ---------------------------- */

// Map the ~600 raw market strings to a small set of clean categories. Ordered:
// most specific first (a player-points line must beat the generic "Totalt" rule).
export function normalizeMarket(raw: string | null | undefined): string {
  if (!raw) return "Övrigt";
  const t = raw.toLowerCase();
  const has = (re: RegExp) => re.test(t);

  if (has(/vinstmetod|method of victory/)) return "Vinstmetod";
  if (has(/trepoäng|trepoangare|3-?poäng|gjorda treor|\btreor\b|three[- ]point/)) return "Trepoängare";
  if (has(/frikast|free ?throws?/)) return "Frikast";
  if (has(/assist/)) return "Assists";
  if (has(/returer|rebound/)) return "Returer";
  if (has(/poäng|points/)) return "Spelarpoäng";
  // "Skott på mål" is a stricter market than plain "Skott" — match it first.
  if (has(/skott på mål|skott pa mal|on target|shots on goal|\bsog\b/)) return "Skott på mål";
  if (has(/skott|shots?\b/)) return "Skott";
  if (has(/räddning|\bsaves?\b/)) return "Räddningar";
  if (has(/hörn|corner/)) return "Hörnor";
  if (has(/kort|foul|varnad|tackling|utvisning|booking|card/)) return "Kort & fouls";
  if (has(/\bess\b|\baces?\b/)) return "Ess";
  if (has(/båda lagen|gör båda|btts|both teams/)) return "BTTS";
  if (has(/dubbelchans|double chance/)) return "Dubbelchans";
  if (has(/handikapp|handicap|spread|run ?line/)) return "Handikapp";
  if (has(/halvlek|first half|second half|halftime|paus|1:a halvlek|2:a halvlek/)) return "Halvlek";
  if (
    has(
      /matchvinnare|fulltidsresultat|resultat efter fulltid|matchodds|att vinna match|to win|vinnare|moneyline|1x2|matchresultat|outright|att kvalificera|att lyfta|trofé|head-to-head|match result/
    )
  )
    return "Matchvinnare";
  if (has(/totalt|över\/under|ö\/u|over\/under|antal mål|total|mål i match|first to|milestones/)) return "Totalt";
  return "Övrigt";
}

/* -------------------------------- Sport teams ------------------------------- */

// Nicknames are matched by suffix on the "CITY Nick" event tokens. Ambiguous
// nicknames (Rangers/Kings/Panthers/Cardinals/Giants/Jets) are excluded here and
// resolved by full name in AMBIG below.
const NBA = [
  "lakers","celtics","mavericks","knicks","pacers","hawks","spurs","bulls","nuggets","thunder",
  "cavaliers","timberwolves","clippers","heat","76ers","warriors","bucks","rockets","pistons",
  "hornets","nets","magic","suns","pelicans","raptors","grizzlies","jazz","trail blazers","wizards",
];
const MLB = [
  "orioles","braves","mets","phillies","yankees","guardians","blue jays","cubs","red sox","marlins",
  "royals","astros","padres","angels","rockies","mariners","tigers","rays","reds","twins","dodgers",
  "white sox","diamondbacks","brewers","nationals","pirates","athletics",
];
const NHL = [
  "oilers","stars","hurricanes","red wings","canucks","golden knights","bruins","maple leafs",
  "lightning","avalanche","capitals","islanders","devils","flyers","penguins","sabres","senators",
  "blackhawks","wild","predators","sharks","ducks","blue jackets","kraken","flames","canadiens","mammoth",
];
const NFL = [
  "patriots","49ers","seahawks","chiefs","broncos","chargers","rams","texans","jaguars","dolphins",
  "bengals","bills","packers","saints","ravens","cowboys","bears","steelers","eagles","vikings","lions",
  "commanders","titans","colts","browns","raiders",
];
// Full "CITY Nick" -> league for nicknames shared across leagues.
const AMBIG: Record<string, [string, string]> = {
  "la kings": ["Ice Hockey", "NHL"],
  "sac kings": ["Basketball", "NBA"],
  "ny rangers": ["Ice Hockey", "NHL"],
  "tex rangers": ["Baseball", "MLB"],
  "fla panthers": ["Ice Hockey", "NHL"],
  "car panthers": ["American Football", "NFL"],
  "stl cardinals": ["Baseball", "MLB"],
  "ari cardinals": ["American Football", "NFL"],
  "sf giants": ["Baseball", "MLB"],
  "ny giants": ["American Football", "NFL"],
  "wpg jets": ["Ice Hockey", "NHL"],
  "ny jets": ["American Football", "NFL"],
  "nyj jets": ["American Football", "NFL"],
};

// Esports orgs (CS/Dota/etc.) seen in the history. Matched case-insensitively, exact token.
const ESPORTS = new Set(
  [
    "MOUZ","FaZe Clan","Team Vitality","Falcons","Natus Vincere","NAVI","G2 Esports","Team Spirit",
    "FURIA","Astralis","The MongolZ","3DMAX","Aurora","HEROIC","GamerLegion","Team Liquid",
    "Ninjas in Pyjamas","Eternal Fire","Legacy","PARIVISION","paiN Gaming","B8","Metizport","Wildcard",
    "Fnatic","FUT","M80","BIG","Monte","Spirit","Liquid","Heroic","Vitality","G2","FaZe","Complexity",
    "Cloud9","ENCE","Virtus.pro","Gambit","NIP","Imperial","9z","MIBR","TYLOO","Lynn Vision","Sangal",
    "Passion UA","SAW","Apeks","OG","BB Team","Gentle Mates","ECSTATIC","Fluxo","Nemiga","Betclic Apogee",
  ].map((s) => s.toLowerCase())
);

const BASKET_MKT = /trepoäng|returer|rebound|spelarpoäng|poäng|points|assist/;
const HOCKEY_MKT = /skott på mål|räddning|utvisning|\bperiod\b|power play|isgren/;
const BASEBALL_MKT = /inning|home ?run|strikeout|run ?line|slagman|slagträ/;
const TENNIS_MKT = /\bset\b|\bgames?\b|tie-?break|game-handikapp|serve|ess\b/;
const MMA_MKT = /vinstmetod|to win fight|method of victory|genom (ko|tko|submission|dq|domslut|tekniskt)|antal rundor|\brond/;

export function splitTeams(event: string): string[] {
  const e = event.trim();
  if (/ @ /.test(e)) return e.split(/ @ /).map((s) => s.trim());
  if (/ vs /i.test(e)) return e.split(/ vs /i).map((s) => s.trim());
  if (/ v /.test(e)) return e.split(/ v /).map((s) => s.trim());
  return [e];
}

function endsWithNick(team: string, nicks: string[]): boolean {
  const t = team.toLowerCase();
  return nicks.some((n) => t === n || t.endsWith(" " + n));
}

function classifyUS(teams: string[]): { sport: string; league: string | null } | null {
  for (const team of teams) {
    const full = team.toLowerCase();
    if (AMBIG[full]) {
      const [sport, league] = AMBIG[full];
      return { sport, league };
    }
  }
  for (const team of teams) {
    if (endsWithNick(team, NBA)) return { sport: "Basketball", league: "NBA" };
    if (endsWithNick(team, NHL)) return { sport: "Ice Hockey", league: "NHL" };
    if (endsWithNick(team, MLB)) return { sport: "Baseball", league: "MLB" };
    if (endsWithNick(team, NFL)) return { sport: "American Football", league: "NFL" };
  }
  return null;
}

/**
 * Infer { sport, league } for a bet from its event string and leg markets.
 * Sport values come from lib/constants SPORTS (English) so sportTag() resolves.
 */
export function inferSport(
  event: string | null | undefined,
  legs: LegLike[] = []
): { sport: string; league: string | null } {
  const ev = (event || "").trim();
  if (!ev) return { sport: "Other", league: null };
  const teams = splitTeams(ev);
  const mkts = legs.map((l) => l.market || "").join(" | ").toLowerCase();

  // 1) Esports — strong signal regardless of separator.
  if (teams.some((t) => ESPORTS.has(t.toLowerCase()))) return { sport: "Esports", league: null };

  // 2) US sports (the " @ " separator).
  if (/ @ /.test(ev)) {
    const us = classifyUS(teams);
    if (us) return us;
    if (HOCKEY_MKT.test(mkts)) return { sport: "Ice Hockey", league: "NHL" };
    if (BASEBALL_MKT.test(mkts)) return { sport: "Baseball", league: "MLB" };
    if (BASKET_MKT.test(mkts)) return { sport: "Basketball", league: "NBA" };
    return { sport: "Other", league: null };
  }

  // 3) MMA — " vs " separator or method/round markets.
  if (/ vs /i.test(ev) || MMA_MKT.test(mkts)) return { sport: "MMA", league: null };

  // 4) " v " events: tennis if tennis markets, otherwise football (the dominant case).
  if (/ v /.test(ev)) {
    if (TENNIS_MKT.test(mkts)) return { sport: "Tennis", league: null };
    return { sport: "Football", league: null };
  }

  // 5) Separator-less events.
  // Horse racing reads as "<race time> <Course>", e.g. "18.00 Wolverhampton".
  if (/^\d{1,2}[.:]\d{2}\s+\p{L}/u.test(ev)) return { sport: "Horse Racing", league: null };
  // Football tournaments / outrights (World Cup, Euros, group/qualifier props).
  if (/\b(vm|em)\s*20\d\d|world cup|euro\s*20|nations? league|champions league|qualif|\bkval\b|grupp/i.test(ev))
    return { sport: "Football", league: null };

  return { sport: "Other", league: null };
}

/** Sport/league/market for a whole bet, derived from its first (primary) leg + event. */
export function categorizeBet(
  event: string | null | undefined,
  legs: LegLike[] = []
): { sport: string; league: string | null; market: string } {
  const { sport, league } = inferSport(event, legs);
  const market = normalizeMarket(legs[0]?.market ?? null);
  return { sport, league, market };
}

/* ------------------------------ Market scope ------------------------------- */

export type MarketScope = "player" | "team" | "match";

// Categories that are per-player by definition.
const PLAYER_PROP = new Set(["Spelarpoäng", "Returer", "Assists", "Trepoängare", "Frikast"]);
// Categories that describe the match outcome as a whole.
const MATCH_CATEGORY = new Set([
  "Matchvinnare", "Dubbelchans", "BTTS", "Handikapp", "Halvlek", "Vinstmetod", "Totalt",
]);
// Stat categories that can be player, team or match — disambiguated from the text.
const AMBIG_STAT = new Set(["Skott", "Skott på mål", "Hörnor", "Kort & fouls", "Räddningar", "Ess"]);

/**
 * Best-effort scope of a bet — Spelare / Lag / Match (totalt). Heuristic by
 * design; returns null ("Okänd") when nothing is conclusive. Never throws.
 *  - `selectionRaw` keeps original casing so a leading name can be detected.
 *  - `teams` are candidate team names (home/away) used to spot team-level props.
 */
export function inferScope(
  selectionRaw: string | null | undefined,
  marketCategory: string,
  teams: (string | null | undefined)[] = []
): MarketScope | null {
  const raw = (selectionRaw || "").trim();
  const s = raw.toLowerCase();

  // Per-player categories are unambiguous.
  if (PLAYER_PROP.has(marketCategory)) return "player";

  // Explicit match-wide phrasing wins over category guesses.
  if (/\btotalt\b|\btotal\b|i matchen|båda lagen|both teams|\bbtts\b/.test(s)) return "match";

  // Match-outcome categories (incl. over/under match totals & handicaps).
  if (MATCH_CATEGORY.has(marketCategory)) return "match";

  // A named team in the selection → team-level prop (e.g. team corners).
  const teamHit = teams.some((t) => t && s.includes(t.trim().toLowerCase()));
  if (teamHit) return "team";

  // Ambiguous stat props: a leading over/under reads as a match total; a leading
  // name + line reads as a player line (e.g. "Saka 1+ skott på mål").
  if (AMBIG_STAT.has(marketCategory) && s) {
    if (/^(över|under|o|u|ö|total|totalt)\b/.test(s)) return "match";
    if (/\d/.test(s) && /^[a-zåäöéèüáàç.'\-]+/i.test(raw)) return "player";
  }

  return null;
}

/**
 * Detailed market for a whole bet: the semantic category + best-effort scope.
 * Uses the free-text selection first (manual bets), falling back to the first
 * leg's market text (imports) and the event for team detection.
 */
export function categorizeDetail(
  selection: string | null | undefined,
  event: string | null | undefined,
  legs: LegLike[] = [],
  homeTeam?: string | null,
  awayTeam?: string | null
): { marketCategory: string; marketScope: MarketScope | null } {
  const fromSelection = normalizeMarket(selection);
  const marketCategory =
    fromSelection !== "Övrigt" ? fromSelection : normalizeMarket(legs[0]?.market ?? null);
  const scopeText = selection || legs[0]?.market || "";
  const teams = homeTeam || awayTeam ? [homeTeam, awayTeam] : splitTeams(event || "");
  const marketScope = inferScope(scopeText, marketCategory, teams);
  return { marketCategory, marketScope };
}
