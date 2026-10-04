// URL:er mot HLTV. Allt är relativa sökvägar — sessionen lägger på domänen
// och använder sökvägen som cachenyckel.

export const HLTV_ORIGIN = "https://www.hltv.org";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const hltvUrls = {
  /** Valves VRS-ranking som HLTV visar den (standard). */
  vrsRanking: () => "/valve-ranking/teams",
  /** HLTV:s egen världsranking. */
  hltvRanking: () => "/ranking/teams",
  team: (id: number, slug = "x") => `/team/${id}/${slug}`,
  /** Resultat för ett lag i ett datumintervall. 100 per sida. */
  teamResults: (teamId: number, from: Date, to: Date, offset = 0) =>
    `/results?team=${teamId}&startDate=${ymd(from)}&endDate=${ymd(to)}${offset > 0 ? `&offset=${offset}` : ""}`,
  match: (id: number, slug = "x") => `/matches/${id}/${slug}`,
  mapStats: (mapStatsId: number, slug = "x") => `/stats/matches/mapstatsid/${mapStatsId}/${slug}`,
};

/** Siffran efter `/<kind>/` i en HLTV-länk, eller null. */
export function idFromHref(href: string | null | undefined, kind: string): number | null {
  if (!href) return null;
  const re = new RegExp(`/${kind}/(\\d+)(?:/|$|\\?)`);
  const m = href.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Slug efter id:t i en HLTV-länk ("/team/9565/vitality" → "vitality"). */
export function slugFromHref(href: string | null | undefined, kind: string): string | null {
  if (!href) return null;
  const m = href.match(new RegExp(`/${kind}/\\d+/([^/?#]+)`));
  return m ? m[1] : null;
}
