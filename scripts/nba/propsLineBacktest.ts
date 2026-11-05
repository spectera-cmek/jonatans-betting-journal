/**
 * Props mot riktiga linjer (Pinnacle, Unibet/Kambi, Betsson ur OddsPapi-
 * historiken). Kräver nba:props-history och nba:props-map. Läser bara.
 *
 *   npm run nba:props-line-backtest
 *   npm run nba:props-line-backtest -- --lineup prev        # speltidsläge: förra matchens spelare + de med linjer
 *   npm run nba:props-line-backtest -- --prop usageSigma=0.15 --split 0.6
 *   npm run nba:props-line-backtest -- --reuse              # analysera om utan att simulera (samma inställningar)
 *   npm run nba:props-line-backtest -- --json ut.json --save
 *
 * Rapporten: devig-metod (D1), modell mot Pinnacle med vikt w trimmad på första
 * 60 % av datumen och rapporterad på resten (D2), mjuka böckers värde mot
 * Pinnacle (vid speltillfället → stängning och utfall), modellens förmåga att
 * förutsäga Pinnacles rörelse (D3) och bias per nivå.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import net from "node:net";
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { loadHistory } from "../../lib/nba/store";
import { DEFAULT_NBA_PARAMS, NBA_MODEL_VERSION, type NbaModelParams } from "../../lib/nba/params";
import { DEFAULT_PROP_PARAMS, PROP_STATS, type PropParams, type PropStat } from "../../lib/nba/props";
import { GameContextCache, projectGamePlayers } from "../../lib/nba/propsBacktest";
import type { PlayerGameRow } from "../../lib/nba/ratings";
import { DEVIG_METHODS, type DevigMethod } from "../../lib/nba/devig";
import {
  bestPerProp,
  betTimeSkill,
  biasByTier,
  blendStudy,
  devigCalibration,
  makeRecord,
  softBookBets,
  summarizeBets,
  type EvBet,
  type LineRecord,
  type SnapQuote,
} from "../../lib/nba/propsLineBacktest";

const PROPS_DIR = path.join(".claude", "nba-props");

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
function args(flag: string): string[] {
  return process.argv.flatMap((a, i) => (a === flag ? [process.argv[i + 1] ?? ""] : []));
}

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)} %`;
const f4 = (x: number) => x.toFixed(4);

interface SnapLine extends SnapQuote {
  gameId: number;
  pid: string;
  stat: PropStat;
}

async function readSnapshots(from: number, to: number): Promise<SnapLine[]> {
  const out: SnapLine[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(PROPS_DIR, "snapshots.jsonl")) });
  for await (const l of rl) {
    if (!l) continue;
    const r = JSON.parse(l);
    const t = Date.parse(r.startAt);
    if (t < from || t > to) continue;
    out.push({ gameId: r.gameId, pid: r.pid, stat: r.stat, book: r.book, at: r.at, tSec: r.tSec, line: r.line, over: r.over, under: r.under, maxStake: r.maxStake ?? null, rungs: r.rungs });
  }
  return out;
}

async function buildRecords(opts: { from: Date; to: Date; lineup: "actual" | "prev"; pp: PropParams; p: NbaModelParams; log: (m: string) => void }): Promise<LineRecord[]> {
  const mapRows = await db.nbaOddspapiPlayer.findMany();
  const map = new Map(mapRows.map((m) => [m.oddspapiId, m.playerId]));
  opts.log(`Kopplade OddsPapi-id: ${map.size}`);
  const snaps = (await readSnapshots(opts.from.getTime(), opts.to.getTime())).filter((s) => map.has(s.pid));
  const byGame = new Map<number, SnapLine[]>();
  for (const s of snaps) { const l_ = byGame.get(s.gameId); if (l_) l_.push(s); else byGame.set(s.gameId, [s]); }
  const games = await db.nbaGame.findMany({
    where: { id: { in: [...byGame.keys()] }, status: "final", boxFetchedAt: { not: null } },
    orderBy: { startAt: "asc" },
  });
  opts.log(`${games.length} matcher, ${snaps.length} kopplade ögonblicksbilder`);
  // Pinnacles spread för utklassningsrisken: stängning (actual) eller speltid (prev).
  const spreadSource = opts.lineup === "prev" ? "oddspapi-bet" : "oddspapi-history";
  const spreads = await db.nbaOdds.findMany({ where: { gameId: { in: games.map((g) => g.id) }, market: "spread", source: spreadSource }, orderBy: { capturedAt: "asc" } });
  const absSpread = new Map(spreads.filter((s) => s.line != null).map((s) => [s.gameId, Math.abs(s.line!)]));
  const minT = games.length ? games[0].startAt.getTime() : Date.now();
  opts.log("Laddar historik …");
  const h = await loadHistory(db, new Date(minT - 420 * 864e5));
  const rowsByGame = new Map<number, PlayerGameRow[]>();
  for (const r of h.allPlayerRows) {
    const l = rowsByGame.get(r.gameId);
    if (l) l.push(r);
    else rowsByGame.set(r.gameId, [r]);
  }
  const ctx = new GameContextCache(h, opts.p);
  const recs: LineRecord[] = [];
  let void_ = 0;
  for (const [gi, g] of games.entries()) {
    if ((gi + 1) % 50 === 0) process.stdout.write(`\r  ${gi + 1}/${games.length}`);
    const { lg, rt } = ctx.at(g.startAt.getTime());
    const lines = byGame.get(g.id) ?? [];
    const players = new Set(lines.map((l) => map.get(l.pid)!));
    const rows = rowsByGame.get(g.id) ?? [];
    const proj = projectGamePlayers(
      h,
      { id: g.id, t: g.startAt.getTime(), homeId: g.homeTeamId, awayId: g.awayTeamId, neutral: g.neutral, seasonType: g.seasonType, homeScore: g.homeScore ?? 0, awayScore: g.awayScore ?? 0 },
      rows,
      lg,
      rt,
      { params: opts.p, propParams: opts.pp, lineup: opts.lineup, absSpread: absSpread.get(g.id) ?? null, expected: players, only: players, byGame: rowsByGame }
    );
    const grouped = new Map<string, SnapLine[]>();
    for (const l of lines) {
      const k = `${map.get(l.pid)}|${l.stat}`;
      { const l_ = grouped.get(k); if (l_) l_.push(l); else grouped.set(k, [l]); }
    }
    for (const [k, qs] of grouped) {
      const [pidStr, stat] = k.split("|");
      const playerId = Number(pidStr);
      const actualRow = rows.find((r) => r.playerId === playerId && r.minutes > 0);
      const pr = proj.get(playerId);
      if (!actualRow || !pr) {
        void_++;
        continue;
      }
      recs.push(
        makeRecord(
          { gameId: g.id, t: g.startAt.getTime(), seasonType: g.seasonType, playerId, stat: stat as PropStat, minutes: pr.minutes },
          pr.samples[stat as PropStat],
          qs,
          actualRow
        )
      );
    }
  }
  process.stdout.write("\n");
  opts.log(`${recs.length} spelare-stat-matcher (${void_} utan spel/projektion — void)`);
  return recs;
}

function printEv(title: string, rows: ReturnType<typeof summarizeBets>) {
  console.log(`\n${title}`);
  console.log("  grupp                         n   EV vid spel   EV mot stängning (t)    ROI mot utfall (t)");
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(26)} ${String(r.n).padStart(5)}   ${pct(r.evBet).padStart(9)}   ${pct(r.evClose.mean).padStart(9)} (${r.evClose.t.toFixed(1).padStart(5)})   ${pct(r.roi.mean).padStart(9)} (${r.roi.t.toFixed(1).padStart(5)})`
    );
  }
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const from = new Date(`${arg("--from") ?? "2026-01-01"}T00:00:00Z`);
  const to = arg("--to") ? new Date(`${arg("--to")}T23:59:59Z`) : new Date();
  const lineup = (arg("--lineup") ?? "actual") as "actual" | "prev";
  const frac = Number(arg("--split")) || 0.6;
  const method = (arg("--method") ?? "power") as DevigMethod;
  const pp: PropParams = { ...DEFAULT_PROP_PARAMS, sims: Number(arg("--sims")) || 2000 };
  for (const kv of args("--prop")) {
    const [k, v] = kv.split("=");
    if (!(k in pp) || !Number.isFinite(Number(v))) throw new Error(`Okänd prop-parameter: ${kv}`);
    (pp as unknown as Record<string, number>)[k] = Number(v);
  }
  const p: NbaModelParams = { ...DEFAULT_NBA_PARAMS };
  for (const kv of args("--param")) {
    const [k, v] = kv.split("=");
    if (!(k in p) || !Number.isFinite(Number(v))) throw new Error(`Okänd parameter: ${kv}`);
    (p as unknown as Record<string, number>)[k] = Number(v);
  }
  const key = crypto.createHash("sha1").update(JSON.stringify({ from, to, lineup, pp, p, v: NBA_MODEL_VERSION })).digest("hex").slice(0, 10);
  const cacheFile = path.join(PROPS_DIR, `records-${lineup}-${key}.json`);
  let recs: LineRecord[];
  if (process.argv.includes("--reuse") && fs.existsSync(cacheFile)) {
    recs = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`${recs.length} poster ur ${cacheFile}`);
  } else {
    recs = await buildRecords({ from, to, lineup, pp, p, log: (m) => console.log(m) });
    fs.writeFileSync(cacheFile, JSON.stringify(recs));
  }
  const counts = Object.fromEntries(PROP_STATS.map((s) => [s, recs.filter((r) => r.stat === s).length]));
  console.log(`Uppställning: ${lineup} · devig: ${method} · ${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(" · ")}`);

  // D1
  const calib = devigCalibration(recs);
  console.log("\nD1 · Pinnacles stängning mot utfall: log loss per devig-metod (lägre = bättre)");
  console.log(`  stat       n   ${DEVIG_METHODS.map((m) => m.padStart(8)).join("")}`);
  for (const c of calib.sort((a, b) => a.stat.localeCompare(b.stat))) console.log(`  ${c.stat.padEnd(6)} ${String(c.n).padStart(6)}   ${DEVIG_METHODS.map((m) => f4(c.logLoss[m]).padStart(8)).join("")}`);
  const cal = calib.find((c) => c.stat === "alla");
  if (cal) console.log(`  reliability (prop): ${cal.bins.map(([p, y, n]) => `${(100 * p).toFixed(0)}→${(100 * y).toFixed(0)}% (${n})`).join(" · ")}`);

  // D2
  const blend = blendStudy(recs, { method, frac });
  console.log(`\nD2 · Modell mot Pinnacle på stängningslinjen — vikt trimmad på första ${frac * 100} % av datumen, testdelen nedan`);
  console.log("  stat     träning/test   marknad   modell    bästa w   blandat   Δ mot marknad [95 % KI]");
  for (const b of blend.sort((a, c) => a.stat.localeCompare(c.stat))) {
    console.log(
      `  ${b.stat.padEnd(6)} ${String(b.nTrain).padStart(6)}/${String(b.nTest).padEnd(6)}   ${f4(b.llMarket)}    ${f4(b.llModel)}    ${b.bestW.toFixed(2).padStart(5)}     ${f4(b.llBlend)}    ${(b.delta >= 0 ? "+" : "") + b.delta.toFixed(4)} [${b.ci[0].toFixed(4)}, ${b.ci[1].toFixed(4)}]`
    );
  }

  // D2 vid speltillfället: modellen mot Pinnacles pris DÅ (rätt kriterium för produktionens vikt).
  const blendAt: Record<string, ReturnType<typeof blendStudy>> = {};
  for (const at of ["open", "-6h", "-3h"]) {
    blendAt[at] = blendStudy(recs, { method, frac, at });
    console.log(`
D2 vid ${at} · modell mot Pinnacles pris vid den tidpunkten (testdelen)`);
    for (const x of blendAt[at].sort((a, c) => a.stat.localeCompare(c.stat))) {
      console.log(`  ${x.stat.padEnd(6)} ${String(x.nTest).padStart(6)}   marknad ${f4(x.llMarket)}  modell ${f4(x.llModel)}  w ${x.bestW.toFixed(2)}  blandat ${f4(x.llBlend)}  Δ ${(x.delta >= 0 ? "+" : "") + x.delta.toFixed(4)} [${x.ci[0].toFixed(4)}, ${x.ci[1].toFixed(4)}]`);
    }
  }

  // Mjuka böcker
  const wBlend = Object.fromEntries(blend.map((b) => [b.stat, b.bestW]));
  // Betsson utesluts som standard: historikens Betsson-steg ger +80 % "EV" även mot
  // utfallet på andra linjer än Pinnacles — linjerna i stegen stämmer inte (datafel).
  const softBooks = (arg("--books") ?? "unibet.se").split(",").map((x) => x.trim()).filter(Boolean);
  const bets = softBookBets(recs, { method, w: wBlend, books: softBooks });
  const pick = (thr: number, score: (b: EvBet) => number) => bestPerProp(bets.filter((b) => score(b) >= thr), score);
  for (const thr of [0, 0.03, 0.05]) {
    printEv(`Mjuka böcker · spel där värdet mot Pinnacle vid speltillfället ≥ ${thr * 100} % (bästa sida/steg per prop)`, summarizeBets(pick(thr, (b) => b.evBet), (b) => `${b.book} ${b.at}`, () => true));
  }
  const sel = pick(0.03, (b) => b.evBet);
  printEv("Uppdelat (≥ 3 %, alla tidpunkter): statistik", summarizeBets(sel, (b) => `${b.book} ${b.stat}`, () => true));
  printEv("Uppdelat (≥ 3 %): sida och samma/annan linje", summarizeBets(sel, (b) => `${b.book} ${b.side} ${b.sameLine ? "samma" : "annan"}`, () => true));
  printEv("Uppdelat (≥ 3 %): oddsband", summarizeBets(sel, (b) => `${b.book} ${b.price < 1.7 ? "<1,70" : b.price <= 2.1 ? "1,70–2,10" : ">2,10"}`, () => true));
  const seasonOf = new Map(recs.map((r) => [r.gameId, r.seasonType]));
  printEv("Uppdelat (≥ 3 %): grundserie/slutspel", summarizeBets(sel, (b) => `${b.book} ${seasonOf.get(b.gameId) === 3 ? "slutspel" : "grundserie"}`, () => true));
  printEv("Med modellen inblandad (vikt w per stat ur D2), ≥ 3 %", summarizeBets(pick(0.03, (b) => b.evBlend), (b) => `${b.book} ${b.at}`, () => true));

  // D3
  const skill = betTimeSkill(recs, { method });
  console.log("\nD3 · Förutsäger modellens edge Pinnacles rörelse till stängningen? (logit; t klustrat per match)");
  console.log("  stat   tid        n     korr    lutning      t");
  for (const s of skill.sort((a, b) => a.stat.localeCompare(b.stat) || a.at.localeCompare(b.at))) {
    console.log(`  ${s.stat.padEnd(6)} ${s.at.padEnd(6)} ${String(s.n).padStart(6)}   ${s.corr.toFixed(3).padStart(6)}   ${s.slope.toFixed(3).padStart(7)}   ${s.t.toFixed(1).padStart(5)}`);
  }

  // Bias
  const tiers = biasByTier(recs);
  console.log("\nBias per nivå (utfall − modell, utfall − Pinnacles stängning, modell − linje)");
  for (const t of tiers.sort((a, b) => a.stat.localeCompare(b.stat) || a.tier.localeCompare(b.tier))) {
    console.log(`  ${t.stat.padEnd(4)} ${t.tier.padEnd(7)} n ${String(t.n).padStart(5)}   ${t.biasModel.toFixed(2).padStart(6)}   ${t.biasLine.toFixed(2).padStart(6)}   ${t.modelMinusLine.toFixed(2).padStart(6)}`);
  }

  const result = { from, to, lineup, method, frac, pp, records: recs.length, calib, blend, blendAt, skill, tiers, ev: summarizeBets(pick(0.03, (b) => b.evBet), (b) => `${b.book} ${b.at}`, () => true) };
  const json = arg("--json");
  if (json) fs.writeFileSync(json, JSON.stringify(result, null, 1));
  if (process.argv.includes("--save")) {
    await db.nbaBacktestRun.create({
      data: { modelVersion: `props-line-${lineup}`, fromDate: from, toDate: to, games: new Set(recs.map((r) => r.gameId)).size, params: { pp, p, method, frac } as object, metrics: JSON.parse(JSON.stringify({ calib, blend, skill, tiers, ev: result.ev })) },
    });
    console.log("\nSparad i NbaBacktestRun.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
