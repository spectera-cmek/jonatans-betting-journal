/**
 * Kontrollerar HLTV-parsrarna mot riktiga sidor och sparar trimmade utdrag
 * som testfixturer.
 *
 *   npm run cs2:capture                 # ranking → första laget → senaste match → karta
 *   npm run cs2:capture -- --team 9565 --match 2370727
 *   npm run cs2:capture -- --headless    # osynligt fönster (Cloudflare släpper sällan igenom)
 *
 * Skriver tests/fixtures/cs2/live/<typ>.html och en tolkningsrapport. Saknas
 * något fält i rapporten är det parsern som behöver ses över — skicka
 * rapporten (och gärna fixturerna) så kan selektorerna rättas.
 * Behöver ingen databas.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseMapStats,
  parseMatchPage,
  parseRanking,
  parseResults,
  parseTeamPage,
} from "../../lib/cs2/hltv/parse";
import { HltvSession, headedFromArgs } from "../../lib/cs2/hltv/session";
import { trimHltvPage, type HltvPageKind } from "../../lib/cs2/hltv/trim";
import { hltvUrls } from "../../lib/cs2/hltv/urls";

const OUT_DIR = path.join("tests", "fixtures", "cs2", "live");

function argNum(flag: string): number | null {
  const i = process.argv.indexOf(flag);
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const problems: string[] = [];
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${detail}`);
  if (!ok) problems.push(label);
}

async function save(kind: HltvPageKind, html: string) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, `${kind}.html`), trimHltvPage(html, kind), "utf8");
}

async function main() {
  const session = new HltvSession({ headed: headedFromArgs(), maxPages: 20 });
  try {
    console.log("Ranking (VRS)");
    const rankingHtml = await session.getHtml(hltvUrls.vrsRanking(), { maxAgeMs: 86_400_000 });
    await save("ranking", rankingHtml);
    const ranked = parseRanking(rankingHtml);
    check("lag", ranked.length >= 10, `${ranked.length} lag`);
    check("lineups", ranked.slice(0, 5).every((r) => r.players.length >= 5), ranked.slice(0, 3).map((r) => `${r.team.name} (${r.players.length})`).join(", "));
    check("poäng", ranked.slice(0, 5).every((r) => r.points != null), String(ranked[0]?.points));

    const teamId = argNum("--team") ?? ranked[0]?.team.id;
    if (!teamId) throw new Error("Inget lag att fortsätta med");
    console.log(`\nLagsida ${teamId}`);
    const teamHtml = await session.getHtml(hltvUrls.team(teamId, ranked.find((r) => r.team.id === teamId)?.team.slug ?? "x"));
    await save("team", teamHtml);
    const team = parseTeamPage(teamHtml);
    check("namn", !!team.name, String(team.name));
    check("trupp", team.players.length >= 5, team.players.map((p) => p.nickname).join(", "));
    check("kommande matcher", true, `${team.upcoming.length} (0 kan vara rätt)`);

    console.log("\nResultat");
    const now = new Date();
    const resultsHtml = await session.getHtml(hltvUrls.teamResults(teamId, new Date(now.getTime() - 90 * 86_400_000), now));
    await save("results", resultsHtml);
    const results = parseResults(resultsHtml);
    check("matcher", results.length > 0, `${results.length} st, första: ${results[0]?.team1Name} ${results[0]?.score1}–${results[0]?.score2} ${results[0]?.team2Name}`);

    const matchId = argNum("--match") ?? results[0]?.matchId;
    if (!matchId) throw new Error("Ingen match att fortsätta med");
    console.log(`\nMatchsida ${matchId}`);
    const matchHtml = await session.getHtml(hltvUrls.match(matchId, results.find((r) => r.matchId === matchId)?.slug ?? "x"));
    await save("match", matchHtml);
    const match = parseMatchPage(matchHtml);
    check("lag", !!match.team1 && !!match.team2, `${match.team1?.name} (${match.team1?.id}) vs ${match.team2?.name} (${match.team2?.id})`);
    check("datum", !!match.startAt, String(match.startAt?.toISOString()));
    check("format", !!match.format, `${match.format} · LAN=${match.lan}`);
    check("status", match.status === "finished", match.status);
    check("veto", match.vetoes.length >= 6 || match.format === "bo1", match.vetoLines.join(" | "));
    check("kartor", match.maps.some((m) => m.played), match.maps.map((m) => `${m.mapName} ${m.team1Score}-${m.team2Score} pick=${m.pickedBy} halvlekar=${m.halves.map((h) => `${h.team1}:${h.team2}(${h.team1Side})`).join(",")}`).join(" | "));
    check("mapstats-länkar", match.maps.filter((m) => m.played).every((m) => m.mapStatsId != null), match.maps.map((m) => m.mapStatsId).join(", "));
    check("demolänk", !!match.demoUrl, String(match.demoUrl));
    check("lineups", match.lineups.length === 2 && match.lineups.every((l) => l.players.length >= 5), match.lineups.map((l) => `${l.teamName}: ${l.players.map((p) => p.nickname).join("/")}`).join(" · "));

    const mapStatsId = match.maps.find((m) => m.mapStatsId != null)?.mapStatsId;
    if (mapStatsId) {
      console.log(`\nMapstats ${mapStatsId}`);
      const msHtml = await session.getHtml(hltvUrls.mapStats(mapStatsId));
      await save("mapstats", msHtml);
      const ms = parseMapStats(msHtml);
      const played = match.maps.find((m) => m.mapStatsId === mapStatsId);
      check("karta", !!ms.mapName, String(ms.mapName));
      check("lag", !!ms.team1 && !!ms.team2, `${ms.team1?.name} ${ms.team1Score} – ${ms.team2Score} ${ms.team2?.name}`);
      check("matchlänk", ms.matchId === matchId, String(ms.matchId));
      check("startsida", !!ms.team1StartSide, String(ms.team1StartSide));
      const expected = played ? (played.team1Score ?? 0) + (played.team2Score ?? 0) : null;
      check("rundhistorik", ms.rounds.length > 0 && (expected == null || ms.rounds.length === expected), `${ms.rounds.length} rundor (väntat ${expected})`);
      const all = ms.players.filter((p) => p.side === "all");
      check("scoreboard", all.length === 10, `${all.length} spelare · ${all.slice(0, 3).map((p) => `${p.nickname} ${p.kills}-${p.deaths} hs=${p.headshots} adr=${p.adr} rating=${p.rating}`).join(" · ")}`);
      check("CT/T-split", ms.players.filter((p) => p.side !== "all").length === 20, `${ms.players.filter((p) => p.side === "ct").length} CT, ${ms.players.filter((p) => p.side === "t").length} T`);
    }

    console.log(`\nFixturer sparade i ${OUT_DIR}. Sidor: ${session.fetched} hämtade, ${session.cacheHits} ur cachen.`);
    if (problems.length > 0) {
      console.log(`\n${problems.length} kontroll(er) misslyckades: ${problems.join(", ")}`);
      process.exitCode = 2;
    } else {
      console.log("\nAlla kontroller OK — parsrarna stämmer mot HLTV just nu.");
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
