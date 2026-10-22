/**
 * Kontrollerar Sofascore-tolkarna mot riktiga svar och sparar trimmade utdrag
 * som testfixturer. Motsvarigheten till cs2:capture.
 *
 *   npm run sofascore:capture
 *   npm run sofascore:capture -- --days 3     # leta färdiga matcher längre bakåt
 *
 * För fotboll, basket och hockey: hittar en färdigspelad match, hämtar
 * lagstatistik och lineups, och skriver ut vilka fält som finns. Kontrollerar
 * också att ligornas sofascoreId i lib/shotData.ts pekar på rätt liga.
 *
 * Skriver tests/fixtures/sofascore/live/*.json. Saknas något fält i rapporten
 * är det tolkaren eller mappningen som behöver ses över — skicka rapporten.
 * Behöver ingen databas. Kör från din vanliga uppkoppling: Sofascore spärrar
 * de flesta moln- och VPN-adresser.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { SHOT_LEAGUES } from "../../lib/shotData";
import { sofaPaths, utcDate, type SofaSport } from "../../lib/sofascore/api";
import { SOFA_MAX_AGE, SofascoreClient } from "../../lib/sofascore/client";
import {
  parseEvents,
  parseLineups,
  parseStatistics,
  parseUniqueTournament,
  shotTotals,
  type SofaEvent,
} from "../../lib/sofascore/parse";
import { PROP_STAT_CHECKS } from "../../lib/propsGrading";

const OUT_DIR = path.join("tests", "fixtures", "sofascore", "live");

/** Turneringar att föredra per sport — de vanligaste i bet-loggen. */
const PREFERRED: Record<SofaSport, number[]> = {
  football: SHOT_LEAGUES.map((l) => l.sofascoreId).filter((x): x is number => x != null),
  basketball: [132], // NBA
  "ice-hockey": [234], // NHL
};

const problems: string[] = [];
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${detail}`);
  if (!ok) problems.push(label);
}

function argNum(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function save(name: string, json: unknown) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, name), JSON.stringify(json, null, 1), "utf8");
}

/** Behåller ALL-perioden — resten är samma form och bara brus i en fixtur. */
function trimStatistics(json: unknown): unknown {
  const stats = (json as { statistics?: { period?: string }[] })?.statistics ?? [];
  return { statistics: stats.filter((p) => p.period === "ALL") };
}

/** Fyra spelare per lag räcker för att se formen. */
function trimLineups(json: unknown): unknown {
  const j = (json ?? {}) as Record<string, { players?: unknown[] } & Record<string, unknown>>;
  const side = (s?: { players?: unknown[] }) => ({ players: (s?.players ?? []).slice(0, 4) });
  return { confirmed: j.confirmed, home: side(j.home), away: side(j.away) };
}

async function findFinished(client: SofascoreClient, sport: SofaSport, days: number): Promise<SofaEvent | null> {
  for (let back = 1; back <= days; back++) {
    const date = utcDate(new Date(Date.now() - back * 86_400_000));
    const json = await client.get(sofaPaths.scheduledEvents(sport, date), SOFA_MAX_AGE.schedule);
    const finished = parseEvents(json).events.filter((e) => e.status === "finished");
    const preferred = finished.find((e) => e.uniqueTournamentId != null && PREFERRED[sport].includes(e.uniqueTournamentId));
    if (preferred ?? finished[0]) return preferred ?? finished[0];
  }
  return null;
}

async function captureSport(client: SofascoreClient, sport: SofaSport, days: number) {
  console.log(`\n${sport}`);
  const ev = await findFinished(client, sport, days);
  check("färdig match", ev !== null, ev ? `${ev.homeTeam.name} ${ev.homeScoreFinal}–${ev.awayScoreFinal} ${ev.awayTeam.name} (${ev.tournamentName}, ${ev.id})` : "ingen hittad");
  if (!ev) return;
  check("tid och turnering", ev.uniqueTournamentId != null, `${ev.startAt.toISOString()} · ut=${ev.uniqueTournamentId} · säsong=${ev.seasonId}`);
  await save(`${sport}-event.json`, await client.get(sofaPaths.event(ev.id), SOFA_MAX_AGE.finished));

  const statsJson = await client.get(sofaPaths.statistics(ev.id), SOFA_MAX_AGE.finished);
  const stats = parseStatistics(statsJson ?? {});
  check("lagstatistik", Object.keys(stats).length > 0, `${Object.keys(stats).length} nycklar: ${Object.keys(stats).join(", ")}`);
  if (statsJson) await save(`${sport}-statistics.json`, trimStatistics(statsJson));
  if (sport === "football") {
    const t = shotTotals(stats);
    check(
      "skottmodellens fält",
      t.homeShots != null && t.homeSot != null && t.homeCorners != null,
      `skott ${t.homeShots}–${t.awayShots} · på mål ${t.homeSot}–${t.awaySot} · hörnor ${t.homeCorners}–${t.awayCorners} · xG ${t.homeXg}–${t.awayXg}`
    );
  }

  const lineupsJson = await client.get(sofaPaths.lineups(ev.id), SOFA_MAX_AGE.finished);
  const lineups = parseLineups(lineupsJson ?? {});
  check("lineups", lineups.players.length > 0, `${lineups.players.length} spelare`);
  if (lineupsJson) await save(`${sport}-lineups.json`, trimLineups(lineupsJson));
  const keys = [...new Set(lineups.players.flatMap((p) => Object.keys(p.stats)))].sort();
  console.log(`    spelarnycklar: ${keys.join(", ")}`);
  for (const c of PROP_STAT_CHECKS.filter((x) => x.sport === sport)) {
    const found = c.keys.find((k) => keys.includes(k));
    check(`props: ${c.label}`, !!found, found ? `"${found}"` : `ingen av ${c.keys.join(" / ")}`);
  }
}

async function main() {
  const days = argNum("--days", 2);
  const client = new SofascoreClient({ maxRequests: 60 });
  try {
    console.log("Ligor i skottmodellen");
    for (const league of SHOT_LEAGUES.filter((l) => l.sofascoreId != null)) {
      const t = parseUniqueTournament(await client.get(sofaPaths.uniqueTournament(league.sofascoreId!), SOFA_MAX_AGE.seasons));
      check(`${league.label} (${league.sofascoreId})`, !!t, t ? `${t.name}${t.category ? ` · ${t.category}` : ""}` : "okänt id");
    }
    for (const sport of ["football", "basketball", "ice-hockey"] as const) {
      await captureSport(client, sport, days);
    }
  } finally {
    await client.close();
  }
  console.log(`\nFixturer sparade i ${OUT_DIR}. Anrop: ${client.fetched} hämtade, ${client.cacheHits} ur cachen.`);
  if (problems.length) {
    console.log(`\n${problems.length} kontroll(er) misslyckades: ${problems.join(", ")}`);
    console.log("Skicka rapporten ovan så rättas tolkaren/mappningen.");
    process.exitCode = 1;
  } else {
    console.log("\nAlla kontroller OK — tolkarna stämmer mot Sofascore just nu.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
