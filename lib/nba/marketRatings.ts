// Marknadens lagrating: lagens styrka ur tidigare matchers stängningslinjer.
//
// Varje spelad match med en stängningsspread ger en observation
//   hemmalagets förväntade marginal (−linjen) = hemmaplan + r(hemma) − r(borta)
// som löses med viktad ridge (färska matcher väger mest). Bara matcher före
// asOf används — kvällens egen linje är aldrig med. Boxscore-ratingen och
// spelarmodellen avviker från marknadens bedömning av lagen med ~3 poäng utan
// att avvikelsen säger något om utfallet; marknadens egen historik tar bort
// det bruset, medan kvällens uppställning (RAPM, bortfall, okända spelare)
// fortfarande justeras ovanpå.

export interface MarketLine {
  /** Matchstart i ms. */
  t: number;
  homeId: number;
  awayId: number;
  neutral: boolean;
  /** Hemmalagets handicap vid stängning (−5 = hemma favorit med 5). */
  line: number;
}

export interface MarketRatings {
  /** Hemmaplan i poäng. */
  hca: number;
  /** Poäng över snittlaget, och viktat antal matcher bakom. */
  teams: Map<number, { r: number; weight: number }>;
}

export interface MarketRatingOpts {
  halfLifeDays: number;
  /** Ridge mot snittlaget, i matcher. */
  ridge: number;
  maxAgeDays: number;
}

export const DEFAULT_MARKET_RATING: MarketRatingOpts = { halfLifeDays: 30, ridge: 2, maxAgeDays: 120 };

/** Så här många dagar bakåt linjerna läses (lite mer än maxAgeDays). */
export const MARKET_LINE_DAYS = 150;

export function fitMarketRatings(lines: MarketLine[], asOf: number, o: MarketRatingOpts = DEFAULT_MARKET_RATING): MarketRatings {
  const obs = lines
    .filter((l) => l.t < asOf && asOf - l.t <= o.maxAgeDays * 864e5)
    .map((l) => ({ ...l, y: -l.line, w: Math.pow(0.5, (asOf - l.t) / 864e5 / o.halfLifeDays), h: l.neutral ? 0 : 1 }));
  const teams = new Map<number, { r: number; weight: number }>();
  if (!obs.length) return { hca: 0, teams };
  for (const x of obs) {
    for (const id of [x.homeId, x.awayId]) {
      const t = teams.get(id) ?? { r: 0, weight: 0 };
      t.weight += x.w;
      teams.set(id, t);
    }
  }
  let hca = 2;
  for (let iter = 0; iter < 60; iter++) {
    const acc = new Map<number, number>();
    let hs = 0;
    let hw = 0;
    for (const x of obs) {
      const rh = teams.get(x.homeId)!.r;
      const ra = teams.get(x.awayId)!.r;
      // Hemmalaget: y = hca·h + rh − ra  ⇒  rh ≈ y − hca·h + ra; bortalaget tvärtom.
      acc.set(x.homeId, (acc.get(x.homeId) ?? 0) + x.w * (x.y - hca * x.h + ra));
      acc.set(x.awayId, (acc.get(x.awayId) ?? 0) + x.w * (hca * x.h + rh - x.y));
      if (x.h) {
        hs += x.w * (x.y - rh + ra);
        hw += x.w;
      }
    }
    teams.forEach((t, id) => (t.r = (acc.get(id) ?? 0) / (t.weight + o.ridge)));
    if (hw > 0) hca = hs / hw;
    // Centrera: snittlaget = 0.
    let s = 0;
    teams.forEach((t) => (s += t.r));
    const mean = s / teams.size;
    teams.forEach((t) => (t.r -= mean));
  }
  return { hca, teams };
}

/**
 * Marknadens förväntade marginal för hemmalaget, eller null om något av lagen
 * har för lite underlag (säsongsstarten).
 */
export function marketMargin(m: MarketRatings, homeId: number, awayId: number, neutral: boolean, minWeight = 3, teamScale = 1): number | null {
  const h = m.teams.get(homeId);
  const a = m.teams.get(awayId);
  if (!h || !a || h.weight < minWeight || a.weight < minWeight) return null;
  return (neutral ? 0 : m.hca) + teamScale * (h.r - a.r);
}
