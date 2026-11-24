// Pick'em-valen för Stage 1 av PGL Major Singapore 2026.
//
// Kör:  npm run cs2:pickem
//       npm run cs2:pickem -- --all-bo1      (känslighet: allt bo1)
//       npm run cs2:pickem -- --all-bo3      (känslighet: allt bo3)
//       npm run cs2:pickem -- --dump-matrix  (skriv ut hela parmatrisen)
//
// Modellen är CS2-modellens egen (ratings → veto → kartor → serie), kalibrerad
// mot Kambis rond 1-priser med en global skalfaktor. Simuleringen följer
// Valves Swiss-format: bo1 utom när avancering eller elimination står på spel.
//
// Se docs/superpowers/specs/2026-11-24-cs2-major-pickem-simulator-design.md.

import "dotenv/config";
import { cs2Prisma } from "../../lib/cs2Db";
import { globalModel } from "../../lib/cs2/matchup";
import { seriesProbs, vetoDistribution, vetoProfile, type VetoHistoryRow } from "../../lib/cs2/veto";
import { mapDistribution, DEFAULT_SIGMA } from "../../lib/cs2/mapModel";
import { matchSpread, pistolWinProb, roundWinProb } from "../../lib/cs2/ratings";
import { activeMapPool } from "../../lib/cs2/maps";
import { fetchBetOffers, fetchCs2Events, findKambiEvent } from "../../lib/cs2/kambi";
import {
  calibrate,
  devigLogit,
  expectedHits,
  fitCalibration,
  greedyPicks,
  optimizePicks,
  pHitAtLeast,
  simulateSwiss,
  tally,
  type Outcome,
  type PickSet,
  type SwissTeam,
} from "../../lib/cs2/pickem";

const EVENT = "Major Singapore 2026 Stage 1";
const SIMS = 200_000;
const AT_LEAST = 5;
const SEED = 20261124;

const DAY = 86_400_000;
const sinceOf = (months: number) => new Date(Date.now() - months * 30 * DAY);

type Format = "bo1" | "bo3";

const args = process.argv.slice(2);
const forceFormat: Format | null = args.includes("--all-bo1")
  ? "bo1"
  : args.includes("--all-bo3")
    ? "bo3"
    : null;
const dumpMatrix = args.includes("--dump-matrix");

/** Deterministisk rng så en körning går att upprepa. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (p: number) => `${(p * 100).toFixed(1).padStart(5)} %`;

async function main() {
  // --- 1. Lagen och rond 1-lottningen ------------------------------------
  const matches = await cs2Prisma.cs2Match.findMany({
    where: { eventName: { contains: EVENT } },
    orderBy: { startAt: "asc" },
    select: { id: true, startAt: true, team1Id: true, team2Id: true, team1Name: true, team2Name: true },
  });
  if (matches.length !== 8) throw new Error(`Hittade ${matches.length} matcher för "${EVENT}", väntade 8.`);
  if (matches.some((m) => m.team1Id == null || m.team2Id == null)) throw new Error("Någon match saknar lag-id.");

  const ids = [...new Set(matches.flatMap((m) => [m.team1Id!, m.team2Id!]))];
  if (ids.length !== 16) throw new Error(`Hittade ${ids.length} distinkta lag, väntade 16.`);

  const teamRows = await cs2Prisma.cs2Team.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, rank: true, tracked: true },
  });
  const info = new Map(teamRows.map((t) => [t.id, t]));
  const name = (id: number) => info.get(id)?.name ?? String(id);
  const byRank = (a: number, b: number) => (info.get(a)?.rank ?? 999) - (info.get(b)?.rank ?? 999);

  // Lottningen avslöjar halvorna: seed k möter seed k+8. Den inre ordningen
  // approximeras med HLTV-rank och spelar bara roll för buchholz-skiljningar.
  const topHalf = matches.map((m) => m.team1Id!).sort(byRank);
  const bottomHalf = matches.map((m) => m.team2Id!).sort(byRank);
  const seeds = new Map<number, number>();
  topHalf.forEach((id, i) => seeds.set(id, i + 1));
  bottomHalf.forEach((id, i) => seeds.set(id, i + 9));
  const teams: SwissTeam[] = ids.map((id) => ({ id, seed: seeds.get(id)! }));
  const round1: Array<[number, number]> = matches.map((m) => [m.team1Id!, m.team2Id!]);

  console.log(`\n=== ${EVENT} — pick'em ===`);
  console.log(`Simuleringar ${SIMS.toLocaleString("sv-SE")}, rng-seed ${SEED}${forceFormat ? `, format tvingat till ${forceFormat}` : ""}`);
  console.log("\nRond 1:");
  for (const m of matches) {
    console.log(`  ${m.startAt?.toISOString().slice(11, 16)}  ${name(m.team1Id!).padEnd(20)} vs ${name(m.team2Id!)}`);
  }

  // --- 2. Sannolikhetsmatrisen ur modellen --------------------------------
  const global = await globalModel(cs2Prisma);
  const r = global.ratings;

  const recentVetoes = await cs2Prisma.cs2Veto.findMany({
    where: { match: { startAt: { gte: sinceOf(3) } } },
    select: { mapName: true, match: { select: { startAt: true } } },
  });
  let pool = activeMapPool(
    recentVetoes.map((v) => ({ mapName: v.mapName, at: v.match.startAt })),
    sinceOf(3),
    5
  );
  if (pool.length < 7) {
    const played = await cs2Prisma.cs2Map.groupBy({
      by: ["mapName"],
      where: { playedAt: { gte: sinceOf(3) } },
      _count: { _all: true },
      orderBy: { _count: { mapName: "desc" } },
    });
    for (const p of played) if (!pool.includes(p.mapName) && pool.length < 7) pool.push(p.mapName);
  }
  pool = pool.slice(0, 7);
  if (pool.length === 0) throw new Error("Ingen kartpool i databasen.");
  console.log(`\nKartpool: ${pool.join(", ")}`);

  const vetoHist = await cs2Prisma.cs2Veto.findMany({
    where: { teamId: { in: ids }, match: { startAt: { gte: sinceOf(6) } } },
    select: { teamId: true, action: true, mapName: true, match: { select: { startAt: true } } },
  });
  const vetoRows: VetoHistoryRow[] = vetoHist.map((h) => ({
    teamId: h.teamId,
    action: h.action,
    mapName: h.mapName,
    at: h.match.startAt,
  }));
  const profiles = new Map(ids.map((id) => [id, vetoProfile(vetoRows, id, pool)]));

  /**
   * P(a vinner serien) ur modellen, med kalibreringsfaktorn lagd på
   * KARTsannolikheten och inte på serien.
   *
   * En bo3-serie drar redan favoriten längre från 0,5 än en bo1 — läggs k
   * ovanpå serien dubbelräknas formatets egen förstärkning. k hör på kartan,
   * där modellens tvärsäkerhet uppstår; serieberäkningen får sedan göra sitt.
   */
  const pairProb = (a: number, b: number, format: Format, k: number): number => {
    const spread = matchSpread(info.get(a)?.tracked ?? false, info.get(b)?.tracked ?? false);
    const veto = vetoDistribution(format, pool, profiles.get(a)!, profiles.get(b)!, 0.5);
    const pistolCtA = pistolWinProb(r, a, b);
    const pistolCtB = pistolWinProb(r, b, a);
    const dists: Record<string, number> = {};
    for (const map of new Set([...pool, ...veto.paths.flatMap((p) => p.maps)])) {
      dists[map] = mapDistribution({
        // team1-argumentet utelämnas med flit: det lägger på HLTV:s
        // "listad först"-bias, som vänder tecken när man byter håll och gör
        // matrisen osymmetrisk. På neutralt LAN finns ingen hemmafördel att
        // modellera, så biasen hör inte hit.
        pCtA: roundWinProb(r, map, a, b, undefined, spread, {}),
        pCtB: roundWinProb(r, map, b, a, undefined, spread, {}),
        pistolCtA,
        pistolCtB,
        conv2: r.conv2,
        conv3: r.conv3,
        pAStartsCt: 0.5,
        sigma: DEFAULT_SIGMA,
      }).pAWin;
      if (k !== 1) dists[map] = calibrate(dists[map], k);
    }
    return seriesProbs(format, veto, (map) => dists[map] ?? 0.5).pA;
  };

  const buildMatrix = (k: number) => {
    const m = new Map<string, number>();
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        for (const f of ["bo1", "bo3"] as Format[]) m.set(`${a}|${b}|${f}`, pairProb(a, b, f, k));
      }
    }
    return (a: number, b: number, f: Format) => m.get(`${a}|${b}|${f}`)!;
  };

  let rawOf = buildMatrix(1);

  // --- 3. Kontrollera matrisen före användning ---------------------------
  const checkSymmetry = (of: (a: number, b: number, f: Format) => number, label: string) => {
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        for (const f of ["bo1", "bo3"] as Format[]) {
          const sum = of(a, b, f) + of(b, a, f);
          if (Math.abs(sum - 1) > 0.01) {
            throw new Error(`${label} är osymmetrisk: ${name(a)} vs ${name(b)} ${f} summerar till ${sum.toFixed(4)}.`);
          }
        }
      }
    }
  };
  checkSymmetry(rawOf, "Parmatrisen");
  if (dumpMatrix) {
    console.log("\nParmatris (bo1 / bo3), P(rad vinner):");
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        console.log(`  ${name(a).padEnd(20)} vs ${name(b).padEnd(20)} ${rawOf(a, b, "bo1").toFixed(3)} / ${rawOf(a, b, "bo3").toFixed(3)}`);
      }
    }
  }

  // --- 4. Kambis rond 1-priser och kalibreringen -------------------------
  console.log("\n--- Kalibrering mot Kambi (rond 1, bo1) ---");
  const points: Array<{ pModel: number; pMarket: number }> = [];
  const matchPairs: Array<[number, number]> = [];
  let events: Awaited<ReturnType<typeof fetchCs2Events>> = [];
  try {
    events = await fetchCs2Events();
  } catch (e) {
    console.log(`  Kambi svarade inte (${(e as Error).message}) — kör okalibrerat.`);
  }
  for (const m of matches) {
    const a = m.team1Id!;
    const b = m.team2Id!;
    const pModel = rawOf(a, b, "bo1");
    const ev = findKambiEvent({ startAt: m.startAt!, teams: [{ id: a, name: name(a) }, { id: b, name: name(b) }] }, events);
    if (!ev) {
      console.log(`  ${name(a).padEnd(20)} modell ${pct(pModel)}  marknad      —  (ingen Kambi-match)`);
      continue;
    }
    let offers: Awaited<ReturnType<typeof fetchBetOffers>> = [];
    try {
      offers = await fetchBetOffers(ev.id);
    } catch (e) {
      console.log(`  ${name(a).padEnd(20)} modell ${pct(pModel)}  marknad      —  (${(e as Error).message})`);
      continue;
    }
    const offer = offers.find((o) => (o.criterion?.englishLabel ?? o.criterion?.label) === "Match Odds");
    const outs = offer?.outcomes ?? [];
    const hit = (teamName: string) =>
      outs.find((o) => {
        const label = `${o.participant ?? ""} ${o.englishLabel ?? o.label ?? ""}`.toLowerCase();
        const needle = teamName.toLowerCase().split(/\s+/)[0];
        return label.includes(needle);
      });
    const oa = hit(name(a))?.odds;
    const ob = hit(name(b))?.odds;
    const dv = oa != null && ob != null ? devigLogit(oa / 1000, ob / 1000) : null;
    if (!dv) {
      console.log(`  ${name(a).padEnd(20)} modell ${pct(pModel)}  marknad      —  (inget Match Odds-pris)`);
      continue;
    }
    points.push({ pModel, pMarket: dv.pA });
    matchPairs.push([a, b]);
    const diff = pModel - dv.pA;
    console.log(
      `  ${name(a).padEnd(20)} modell ${pct(pModel)}  marknad ${pct(dv.pA)}  diff ${(diff * 100 >= 0 ? "+" : "") + (diff * 100).toFixed(1)} pe   (vs ${name(b)})`
    );
  }
  const fit = fitCalibration(points);
  console.log(`\n  k = ${fit.k}  (${fit.n} priser)${fit.warning ? `  VARNING: ${fit.warning}` : ""}`);
  console.log(
    `  ${fit.k < 1 ? "k under 1: modellen är tvärsäkrare än marknaden och dras in mot 0,5." : fit.k > 1 ? "k över 1: modellen är försiktigare än marknaden och dras ut." : "k = 1: modellen möter marknaden."}`
  );

  // Bygg om matrisen med k på kartnivå och kontrollera att den landar på
  // marknaden — restfaktorn ska nu ligga nära 1.
  if (fit.k !== 1) {
    rawOf = buildMatrix(fit.k);
    checkSymmetry(rawOf, "Den kalibrerade parmatrisen");
    const after = fitCalibration(points.map((pt, i) => ({ pModel: rawOf(matchPairs[i][0], matchPairs[i][1], "bo1"), pMarket: pt.pMarket })));
    console.log(`  Efter kalibrering: restfaktor ${after.k} (nära 1 = modellen möter nu marknaden)`);
  }

  // --- 5. Simulera och optimera ------------------------------------------
  const pWin = (a: number, b: number, format: Format) => rawOf(a, b, forceFormat ?? format);

  const rng = mulberry32(SEED);
  const sims: Array<Map<number, Outcome>> = [];
  for (let i = 0; i < SIMS; i++) sims.push(simulateSwiss(teams, round1, pWin, rng));
  const table = tally(sims, ids);

  // --- 6. Utskrift --------------------------------------------------------
  console.log("\n--- Utfall per lag ---");
  console.log(`  ${"lag".padEnd(20)} ${"seed".padStart(4)}  ${"3-0".padStart(7)} ${"3-1/3-2".padStart(7)} ${"vidare".padStart(7)} ${"0-3".padStart(7)}`);
  const sorted = [...ids].sort(
    (x, y) =>
      (table.p30.get(y)! + table.pAdv.get(y)!) - (table.p30.get(x)! + table.pAdv.get(x)!)
  );
  for (const id of sorted) {
    const p30 = table.p30.get(id)!;
    const pAdv = table.pAdv.get(id)!;
    console.log(
      `  ${name(id).padEnd(20)} ${String(seeds.get(id)).padStart(4)}  ${pct(p30)} ${pct(pAdv)} ${pct(p30 + pAdv)} ${pct(table.p03.get(id)!)}`
    );
  }
  const advSum = ids.reduce((s, id) => s + table.p30.get(id)! + table.pAdv.get(id)!, 0);
  console.log(`  Summa P(vidare) = ${advSum.toFixed(3)} (ska vara 8,000)`);

  const best = optimizePicks(table, AT_LEAST, mulberry32(SEED + 1));
  const greedy = greedyPicks(table);

  const show = (picks: PickSet) => {
    const line = (label: string, list: number[], p: Map<number, number>) =>
      `  ${label.padEnd(10)} ${list.map((id) => `${name(id)} (${(p.get(id)! * 100).toFixed(1)} %)`).join(", ")}`;
    console.log(line("3-0:", picks.threeZero, table.p30));
    console.log(line("3-1/3-2:", picks.advance, table.pAdv));
    console.log(line("0-3:", picks.zeroThree, table.p03));
  };

  console.log("\n--- Valen ---");
  show(best.picks);
  console.log(
    `\n  P(minst ${AT_LEAST} rätt) = ${pct(best.pHit)}   förväntat antal rätt = ${best.expected.toFixed(2)}`
  );
  console.log(
    `  Giriga EV-valet:      ${pct(pHitAtLeast(table, greedy, AT_LEAST))}   förväntat ${expectedHits(table, greedy).toFixed(2)}`
  );
  if (JSON.stringify(greedy) !== JSON.stringify(best.picks)) {
    console.log("  (optimeraren valde annorlunda än EV — tröskeln belönar val som slår in tillsammans)");
    show(greedy);
  }
}

main()
  .catch((e) => {
    console.error("\nFEL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => cs2Prisma.$disconnect());
