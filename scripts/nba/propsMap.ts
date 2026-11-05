/**
 * Kopplar OddsPapi-spelar-id i prop-historiken till ESPN-spelare och sparar
 * kopplingen i NbaOddspapiPlayer. Kräver datasetet från nba:props-history.
 *
 *   npm run nba:props-map -- --dry      # bara rapporten
 *   npm run nba:props-map               # spara
 *
 * Rapporten (grind G1): precision mot seed-kopplingarna (live-linje = historikens
 * pris), täckning av Pinnacles prop-rader, andel kopplade rader där spelaren
 * inte spelade, och linje mot utfall per statistik (kontroll, används inte
 * för att koppla).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import net from "node:net";
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { loadHistory } from "../../lib/nba/store";
import { cachedHistory } from "../../lib/nba/historyCache";
import { extractPropSeries, type PropSeriesByBook } from "../../lib/nba/propsHistory";
import { loadIds, reclassifyPropMarkets, type PropMarketSpec, type PropStatKey } from "../../lib/oddspapi/markets";
import { MAP_STATS, rowStat, seedFromLiveLines, statMap, type PidAppearance } from "../../lib/nba/propsMapping";

const PROPS_DIR = path.join(".claude", "nba-props");
const BOOK_PRIORITY = ["pinnacle", "unibet.se", "betsson"];
/** Bara linjer som fanns kvar nära avspark: en linje som drogs in före start
 * betyder oftast att spelaren ströks — som "frånvaro" straffade den rätt spelare. */
const AT_PRIORITY = ["close", "-1h"];

interface SnapRow {
  gameId: number;
  startAt: string;
  book: string;
  pid: string;
  stat: PropStatKey;
  at: string;
  line: number;
}

async function readSnapshots(): Promise<SnapRow[]> {
  const out: SnapRow[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(PROPS_DIR, "snapshots.jsonl")) });
  for await (const l of rl) {
    if (!l) continue;
    const r = JSON.parse(l);
    out.push({ gameId: r.gameId, startAt: r.startAt, book: r.book, pid: r.pid, stat: r.stat, at: r.at, line: r.line });
  }
  return out;
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function corr(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const ids = loadIds();
  const propMarkets: Record<string, PropMarketSpec> = reclassifyPropMarkets(ids?.basketballPropMarkets as Record<string, PropMarketSpec> | undefined);

  // --- 1. Seed: sparade Pinnacle-linjer (OddsPapi, utan id) mot historiken -----------
  const live = await db.nbaPropLine.findMany({ where: { book: "pinnacle", source: "oddspapi" }, select: { gameId: true, playerId: true, stat: true, line: true, over: true, under: true, capturedAt: true, oddspapiPlayerId: true } });
  const liveGames = await db.nbaGame.findMany({ where: { id: { in: [...new Set(live.map((l) => l.gameId))] }, status: "final", oddspapiFixtureId: { not: null } }, select: { id: true, startAt: true, oddspapiFixtureId: true } });
  console.log(`Seed: ${live.length} sparade Pinnacle-linjer i ${liveGames.length} spelade matcher — hämtar historiken (gratis) …`);
  const series = new Map<number, { startMs: number; books: PropSeriesByBook }>();
  for (const g of liveGames) {
    const h = await cachedHistory(g.oddspapiFixtureId!, ["pinnacle"]);
    series.set(g.id, { startMs: g.startAt.getTime(), books: extractPropSeries(h, propMarkets, ["pinnacle"], g.startAt.getTime()) });
  }
  const seeds = seedFromLiveLines(
    live.map((l) => ({ ...l, capturedAt: l.capturedAt.getTime() })),
    series
  );
  const liveIds = await db.nbaOddspapiPlayer.findMany({ where: { source: "live" } });
  const fixed = new Map<string, number>([...[...seeds].map(([pid, s]) => [pid, s.playerId] as [string, number]), ...liveIds.map((l) => [l.oddspapiId, l.playerId] as [string, number])]);
  console.log(`  ${seeds.size} id kopplade via pris, ${liveIds.length} via live-namn`);

  // --- 2. Uppträdanden per id ur datasetet ---------------------------------------
  console.log("Läser ögonblicksbilder …");
  const snaps = await readSnapshots();
  const games = await db.nbaGame.findMany({ where: { id: { in: [...new Set(snaps.map((s) => s.gameId))] } }, select: { id: true, startAt: true, homeTeamId: true, awayTeamId: true } });
  const gameInfo = new Map(games.map((g) => [g.id, g]));
  // Bästa linje per (id, match, stat): bok i prioritetsordning, senaste tidpunkten.
  const best = new Map<string, { rank: number; line: number }>();
  for (const s of snaps) {
    if (!AT_PRIORITY.includes(s.at) || !BOOK_PRIORITY.includes(s.book)) continue;
    const rank = BOOK_PRIORITY.indexOf(s.book) * 10 + AT_PRIORITY.indexOf(s.at);
    const k = `${s.pid}|${s.gameId}|${s.stat}`;
    const cur = best.get(k);
    if (!cur || rank < cur.rank) best.set(k, { rank, line: s.line });
  }
  const apps = new Map<string, PidAppearance[]>();
  const appIdx = new Map<string, PidAppearance>();
  for (const [k, v] of best) {
    const [pid, gid, stat] = k.split("|");
    const g = gameInfo.get(Number(gid));
    if (!g) continue;
    let a = appIdx.get(`${pid}|${gid}`);
    if (!a) {
      a = { gameId: g.id, t: g.startAt.getTime(), homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, lines: {} };
      appIdx.set(`${pid}|${gid}`, a);
      { const l_ = apps.get(pid); if (l_) l_.push(a); else apps.set(pid, [a]); }
    }
    a.lines[stat as PropStatKey] = v.line;
  }
  console.log(`  ${apps.size} id, ${appIdx.size} id-matcher`);

  console.log("Laddar boxscores …");
  const minT = Math.min(...games.map((g) => g.startAt.getTime()));
  const h = await loadHistory(db, new Date(minT - 200 * 864e5));

  const num = (f: string) => (arg(f) != null ? Number(arg(f)) : undefined);
  const opts = { minMargin: num("--min-margin"), maxCost: num("--max-cost"), minPresence: num("--min-presence") };

  // Svep: precision (mot seed) och täckning för olika trösklar.
  if (process.argv.includes("--sweep")) {
    for (const minMargin of [0.25, 0.5, 0.75, 1, 1.5]) {
      for (const maxCost of [2.5, 4]) {
        const b = statMap(apps, h, new Map(), { minMargin, maxCost, minPresence: opts.minPresence });
        let c = 0;
        let ok = 0;
        for (const m of b) {
          const gold = fixed.get(m.pid);
          if (gold == null) continue;
          c++;
          if (gold === m.playerId) ok++;
        }
        const f = statMap(apps, h, fixed, { minMargin, maxCost, minPresence: opts.minPresence });
        const mapped = new Set([...fixed.keys(), ...f.map((m) => m.pid)]);
        let rows = 0;
        let hit = 0;
        for (const [k, v] of best) {
          if (v.rank >= 10) continue;
          rows++;
          if (mapped.has(k.split("|")[0])) hit++;
        }
        console.log(`  marginal ≥ ${minMargin} · kostnad ≤ ${maxCost}: precision ${ok}/${c} = ${c ? ((100 * ok) / c).toFixed(1) : "–"} % · täckning ${((100 * hit) / rows).toFixed(1)} %`);
      }
    }
    return;
  }

  // --- 3. Precision: statistisk koppling UTAN seed, jämförd med seed --------------
  const blind = statMap(apps, h, new Map(), opts);
  let checked = 0;
  let right = 0;
  const wrong: string[] = [];
  for (const m of blind) {
    const gold = fixed.get(m.pid);
    if (gold == null) continue;
    checked++;
    if (gold === m.playerId) right++;
    else if (wrong.length < 5) wrong.push(`${m.pid}: ${m.playerId} ≠ ${gold} (kostnad ${m.cost.toFixed(2)}, marginal ${m.margin.toFixed(2)})`);
  }
  console.log(`\nPrecision mot seed: ${right}/${checked}${checked ? ` = ${((100 * right) / checked).toFixed(1)} %` : ""}${wrong.length ? `\n  fel: ${wrong.join("; ")}` : ""}`);

  // --- 4. Slutlig koppling: seed fast, resten statistiskt ---------------------------
  const stat = statMap(apps, h, fixed, opts);
  const mapping = new Map<string, { playerId: number; source: string; confidence: number }>();
  for (const [pid, playerId] of fixed) mapping.set(pid, { playerId, source: seeds.has(pid) ? "join" : "live", confidence: 1 });
  for (const m of stat) mapping.set(m.pid, { playerId: m.playerId, source: "stat", confidence: m.confidence });

  // --- 5. Kontroll mot utfall (används inte för kopplingen) -------------------------
  const byGame = new Map<number, Map<number, (typeof h.allPlayerRows)[number]>>();
  for (const r of h.allPlayerRows) {
    const m = byGame.get(r.gameId) ?? new Map();
    m.set(r.playerId, r);
    byGame.set(r.gameId, m);
  }
  let pinRows = 0;
  let pinMapped = 0;
  let zeroMin = 0;
  const pairs: Record<string, { line: number[]; actual: number[] }> = {};
  for (const [k, v] of best) {
    const [pid, gid, st] = k.split("|");
    if (v.rank >= 10) continue; // bara Pinnacle
    pinRows++;
    const m = mapping.get(pid);
    if (!m) continue;
    pinMapped++;
    const r = byGame.get(Number(gid))?.get(m.playerId);
    if (!r || r.minutes <= 0) {
      zeroMin++;
      continue;
    }
    const p = (pairs[st] ??= { line: [], actual: [] });
    p.line.push(v.line);
    p.actual.push(rowStat(r, st as PropStatKey));
  }
  console.log(`\nKopplade id: ${mapping.size} av ${apps.size} (seed ${seeds.size}, live ${liveIds.length}, statistiskt ${stat.length})`);
  console.log(`Pinnacle-rader (id-match-stat): ${pinMapped}/${pinRows} kopplade = ${((100 * pinMapped) / Math.max(1, pinRows)).toFixed(1)} % · spelade inte: ${((100 * zeroMin) / Math.max(1, pinMapped)).toFixed(1)} %`);
  console.log("Linje mot utfall (Pinnacle, kopplade, kontroll):");
  for (const st of MAP_STATS) {
    const p = pairs[st];
    if (!p?.line.length) continue;
    const bias = p.actual.reduce((a, b, i) => a + b - p.line[i], 0) / p.line.length;
    console.log(`  ${st.padEnd(4)} n ${String(p.line.length).padStart(5)} · korr ${corr(p.line, p.actual).toFixed(3)} · snitt utfall − linje ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}`);
  }

  if (dry) {
    console.log("\n--dry: inget sparat.");
    return;
  }
  const players = await db.nbaPlayer.findMany({ where: { id: { in: [...new Set([...mapping.values()].map((m) => m.playerId))] } }, select: { id: true, name: true } });
  const names = new Map(players.map((p) => [p.id, p.name]));
  let saved = 0;
  for (const [pid, m] of mapping) {
    if (m.source === "live") continue; // live-kopplingar skrivs av fångsten
    const data = { playerId: m.playerId, name: names.get(m.playerId) ?? null, source: m.source, confidence: m.confidence };
    await db.nbaOddspapiPlayer.upsert({ where: { oddspapiId: pid }, create: { oddspapiId: pid, ...data }, update: data });
    saved++;
  }
  console.log(`\n${saved} kopplingar sparade i NbaOddspapiPlayer.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
