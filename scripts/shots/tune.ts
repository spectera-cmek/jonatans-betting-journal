/**
 * Söker parametrar för skottmodellen och mäter dem på data den inte tunats på.
 *
 *   npx tsx scripts/shots/tune.ts --metric corners
 *   npx tsx scripts/shots/tune.ts --metric corners --league allsvenskan
 *
 * Upplägget:
 *   • matcherna delas kronologiskt: äldre 60 % TUNING, nyare 40 % VALIDERING
 *   • varje kandidat utvärderas walk-forward inom sin del — ratings ser bara
 *     matcher spelade före avspark
 *   • vinnaren väljs på tuning-delen och rapporteras sedan på validerings-
 *     delen, som aldrig påverkat valet
 *
 * Utan den delningen mäter man hur väl parametrarna memorerat sitt eget
 * stickprov, vilket alltid ser bra ut och aldrig håller.
 *
 * Läser bara — skriver aldrig till databasen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { lineProbs, negBinPmfVector, convolvePmf, type ShotMetric } from "../../lib/shotModel";
import {
  SHOT_LEAGUES,
  findLeague,
  buildLeagueModel,
  projectFixture,
  metricValues,
  type ShotLeague,
  type ShotMatchRow,
  type SignalWeights,
} from "../../lib/shotData";
import { shotsPrisma as prisma, hasShotsDb } from "../../lib/shotsDb";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

interface Candidate {
  label: string;
  halfLife: number;
  shrinkK: number;
  signalWeights?: SignalWeights;
}

/** Kandidaterna: först signalmixen, sedan formfönster och shrinkage. */
function candidates(metric: ShotMetric): Candidate[] {
  const mixes: Array<[string, SignalWeights | undefined]> = [
    ["endast mätetalet", undefined],
    ["+ skott", { [metric]: 1, shots: 1 }],
    ["+ skott + xG", { [metric]: 1, shots: 1, xg: 1 }],
    ["+ skott×2 + xG", { [metric]: 2, shots: 2, xg: 1 }],
    ["skott-tungt", { [metric]: 1, shots: 3, xg: 1 }],
    ["xG-tungt", { [metric]: 1, shots: 1, xg: 3 }],
    ["alla fyra", { [metric]: 1, shots: 1, sot: 1, xg: 1 }],
  ];
  const out: Candidate[] = [];
  for (const [name, signalWeights] of mixes) {
    for (const halfLife of [6, 10, 16]) {
      for (const shrinkK of [4, 8, 14]) {
        out.push({ label: `${name} · hl${halfLife} k${shrinkK}`, halfLife, shrinkK, signalWeights });
      }
    }
  }
  return out;
}

interface OddsRow {
  matchId: string;
  side: string;
  line: number;
}

function logLoss(p: number, hit: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return -(hit * Math.log(q) + (1 - hit) * Math.log(1 - q));
}

function actualFor(row: ShotMatchRow, metric: ShotMetric, side: string): number | null {
  const v = metricValues(row, metric);
  if (!v) return null;
  if (side === "home") return v.home;
  if (side === "away") return v.away;
  return v.home + v.away;
}

/**
 * Genomsnittlig log-loss för en kandidat över de linjer marknaden faktiskt
 * lade, walk-forward inom `rows`. `history` är matcher före perioden som
 * ratingen får värma upp på.
 */
function evaluate(
  history: ShotMatchRow[],
  rows: ShotMatchRow[],
  linesByMatch: Map<string, OddsRow[]>,
  metric: ShotMetric,
  cand: Candidate
): { logLoss: number; n: number } | null {
  let total = 0;
  let n = 0;
  let cache: { day: string; model: ReturnType<typeof buildLeagueModel> } | null = null;

  for (const row of rows) {
    const lines = linesByMatch.get(row.id);
    if (!lines?.length) continue;

    const day = row.kickoffAt.toISOString().slice(0, 10);
    if (!cache || cache.day !== day) {
      const seen = history.concat(rows.filter((r) => r.kickoffAt < row.kickoffAt));
      cache = {
        day,
        model: buildLeagueModel(seen, metric, {
          halfLife: cand.halfLife,
          shrinkK: cand.shrinkK,
          signalWeights: cand.signalWeights,
        }),
      };
    }
    const model = cache.model;
    if (!model) continue;

    const lambdas = projectFixture(model, row.homeTeamId, row.awayTeamId);
    for (const l of lines) {
      const actual = actualFor(row, metric, l.side);
      if (actual == null) continue;
      if (Number.isInteger(l.line) && actual === l.line) continue;

      const pmf =
        l.side === "home"
          ? negBinPmfVector(lambdas.home, model.dispersion)
          : l.side === "away"
            ? negBinPmfVector(lambdas.away, model.dispersion)
            : convolvePmf(
                negBinPmfVector(lambdas.home, model.dispersion),
                negBinPmfVector(lambdas.away, model.dispersion)
              );
      const p = lineProbs(pmf, l.line).pOverNoPush;
      total += logLoss(p, actual > l.line ? 1 : 0);
      n += 1;
    }
  }
  return n === 0 ? null : { logLoss: total / n, n };
}

async function tuneLeague(league: ShotLeague, metric: ShotMetric) {
  const rows = (await prisma.shotMatch.findMany({
    where: { leagueKey: league.key, status: "finished", statsFetchedAt: { not: null } },
    orderBy: { kickoffAt: "asc" },
    select: {
      id: true, kickoffAt: true, homeTeamId: true, awayTeamId: true,
      homeShots: true, awayShots: true, homeSot: true, awaySot: true,
      homeCorners: true, awayCorners: true, homeXg: true, awayXg: true,
    },
  })) as ShotMatchRow[];

  const usable = rows.filter((r) => metricValues(r, metric) !== null);
  if (usable.length < 120) {
    console.log(`\n=== ${league.label} · ${metric} === för lite data (${usable.length} matcher)`);
    return;
  }

  const odds = (await prisma.shotOddsSnapshot.findMany({
    where: { matchId: { in: usable.map((r) => r.id) }, metric, isClosing: true },
    select: { matchId: true, side: true, line: true },
    distinct: ["matchId", "side", "line"],
  })) as OddsRow[];
  if (odds.length === 0) {
    console.log(`\n=== ${league.label} · ${metric} === inga odds lagrade`);
    return;
  }
  const linesByMatch = new Map<string, OddsRow[]>();
  for (const o of odds) {
    const list = linesByMatch.get(o.matchId);
    if (list) list.push(o);
    else linesByMatch.set(o.matchId, [o]);
  }

  // Uppvärmning / tuning / validering, kronologiskt.
  const warmEnd = Math.floor(usable.length * 0.2);
  const tuneEnd = Math.floor(usable.length * 0.6);
  const warm = usable.slice(0, warmEnd);
  const tuneRows = usable.slice(warmEnd, tuneEnd);
  const valRows = usable.slice(tuneEnd);

  console.log(`\n=== ${league.label} · ${metric} ===`);
  console.log(
    `  ${usable.length} matcher · uppvärmning ${warm.length} · tuning ${tuneRows.length} · validering ${valRows.length}`
  );

  const scored: Array<{ cand: Candidate; tune: number; n: number }> = [];
  for (const cand of candidates(metric)) {
    const r = evaluate(warm, tuneRows, linesByMatch, metric, cand);
    if (r) scored.push({ cand, tune: r.logLoss, n: r.n });
  }
  if (scored.length === 0) {
    console.log("  inga jämförbara linjer");
    return;
  }
  scored.sort((a, b) => a.tune - b.tune);

  const baseline = scored.find((s) => s.cand.signalWeights === undefined && s.cand.halfLife === 10 && s.cand.shrinkK === 8);
  const best = scored[0];

  console.log(`  Topp 5 på TUNING-delen (${best.n} linjer):`);
  for (const s of scored.slice(0, 5)) {
    console.log(`    ${pad(s.cand.label, 30)} ${s.tune.toFixed(4)}`);
  }

  // Validering: bara vinnaren och nuvarande default, på data som inte styrt valet.
  const valBest = evaluate(warm.concat(tuneRows), valRows, linesByMatch, metric, best.cand);
  const current: Candidate = { label: "nuvarande default", halfLife: 10, shrinkK: 6 };
  const valCurrent = evaluate(warm.concat(tuneRows), valRows, linesByMatch, metric, current);

  console.log(`  VALIDERING (${valBest?.n ?? 0} linjer):`);
  if (valCurrent) console.log(`    ${pad("nuvarande default", 30)} ${valCurrent.logLoss.toFixed(4)}`);
  if (valBest) console.log(`    ${pad(best.cand.label, 30)} ${valBest.logLoss.toFixed(4)}`);
  if (valBest && valCurrent) {
    const diff = valCurrent.logLoss - valBest.logLoss;
    console.log(
      `    → ${diff > 0 ? "förbättring" : "FÖRSÄMRING"} ${padL((diff * 1000).toFixed(2), 7)} log-loss ×10⁻³ ${
        diff > 0.002 ? "(värd att byta)" : "(inom bruset — byt inte)"
      }`
    );
  }
  if (baseline) console.log(`    (tuning-värde för nuvarande default: ${baseline.tune.toFixed(4)})`);
}

async function main() {
  if (!hasShotsDb()) {
    console.error("SHOTS_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const leagueKey = argValue("--league") ?? "all";
  const metric = (argValue("--metric") ?? "corners") as ShotMetric;
  const leagues =
    leagueKey === "all" ? SHOT_LEAGUES : [findLeague(leagueKey)].filter((l): l is ShotLeague => l !== null);

  console.log(`Tunar ${metric} · ${candidates(metric).length} kandidater per liga`);
  for (const league of leagues) await tuneLeague(league, metric);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
