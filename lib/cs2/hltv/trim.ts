// Krymper en HLTV-sida till de element parsrarna faktiskt läser, så den kan
// sparas som testfixtur. Skript, stilar, bilder och allt utanför de utvalda
// behållarna tas bort — kvar blir några kB i stället för flera hundra.

import { load } from "cheerio";

export type HltvPageKind = "ranking" | "team" | "results" | "match" | "mapstats";

const KEEP: Record<HltvPageKind, string[]> = {
  ranking: [".ranked-team"],
  team: [".profile-team-container", ".profile-team-name", ".team-country", ".players-table", ".bodyshot-team", "#matchesBox"],
  results: [".result-con", ".pagination-component"],
  match: [".team1-gradient", ".team2-gradient", ".timeAndEvent", ".countdown", ".veto-box", ".mapholder", ".lineups", "[data-demo-link]"],
  mapstats: [".match-info-box-con", ".match-info-box", ".team-left", ".team-right", ".match-info-row", ".round-history-con", "table.stats-table"],
};

/** Max antal förekomster per selektor — fixturen ska vara liten. */
const LIMIT: Partial<Record<string, number>> = { ".ranked-team": 5, ".result-con": 6 };

export function trimHltvPage(html: string, kind: HltvPageKind): string {
  const $ = load(html);
  const canonical = $('link[rel="canonical"]').attr("href") ?? "";
  $("script, style, noscript, iframe, svg, link, meta").remove();
  const parts: string[] = [];
  const taken = new Set<unknown>();
  for (const sel of KEEP[kind]) {
    const limit = LIMIT[sel] ?? 50;
    $(sel)
      .slice(0, limit)
      .each((_, el) => {
        // Hoppa över element som redan ingår i ett tidigare utvalt element.
        const ancestors = $(el).parents().toArray();
        if (ancestors.some((a) => taken.has(a))) return;
        taken.add(el);
        parts.push($.html(el));
      });
  }
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body>\n${parts.join("\n")}\n</body></html>\n`;
}
