/**
 * Backtestar skottmodellen mot lagrade odds — walk-forward, utan läckage.
 *
 *   npx tsx scripts/shots/backtest.ts
 *   npx tsx scripts/shots/backtest.ts --league allsvenskan --metric corners
 *   npx tsx scripts/shots/backtest.ts --min-history 60 --edge 3
 *
 * Upplägget speglar hur spelen faktiskt skulle lagts:
 *   • ratings räknas bara på matcher spelade FÖRE avspark
 *   • marknadsreferensen vägs över alla böcker och linjer via implicit λ
 *   • spelet läggs till bästa tillgängliga pris
 *   • ROI mäts mot faktiskt utfall
 *
 * OBS: TheStatsAPI lämnar `opening` tomt för skott- och hörnmarknader, så i
 * praktiken finns bara stängningspriser. Spelen läggs då till stängning, och
 * CLV går inte att mäta — utskriften visar vilken priskälla som användes.
 *
 * Läser bara — skriver aldrig till databasen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import {
  blendProb,
  lineProbs,
  marketConsensus,
  negBinFamily,
  correlatedTotalFamily,
  negBinPmfVector,
  correlatedTotalPmf,
  applyCalibration,
  type Calibration,
  priceEdge,
  DEFAULT_SHARP_BOOKS,
  type ShotMetric,
} from "../../lib/shotModel";
import {
  SHOT_LEAGUES,
  findLeague,
  buildLeagueModel,
  projectFixture,
  metricValues,
  type ShotLeague,
  type ShotMatchRow,
} from "../../lib/shotData";

import { shotsPrisma as prisma, hasShotsDb } from "../../lib/shotsDb";

const METRICS: ShotMetric[] = ["shots", "sot", "corners"];
const METRIC_LABEL: Record<ShotMetric, string> = { shots: "Skott", sot: "Skott på mål", corners: "Hörnor" };
const BLEND_WEIGHTS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 1];

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function numberArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

interface OddsRow {
  matchId: string;
  bookmaker: string;
  metric: string;
  side: string;
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  isClosing: boolean;
}

/** Faktiskt utfall för ett mätetal och en sida. */
function actualFor(row: ShotMatchRow, metric: ShotMetric, side: string): number | null {
  const v = metricValues(row, metric);
  if (!v) return null;
  if (side === "home") return v.home;
  if (side === "away") return v.away;
  return v.home + v.away;
}

/** Modellens P(över) för en sida, med matchtotalen som faltning av lagen. */
function modelProbOver(
  lambdas: { home: number; away: number },
  dispersion: number,
  side: string,
  line: number,
  rho: number,
  calibration: Calibration
): { pOver: number; pPush: number } {
  const pmf =
    side === "home"
      ? negBinPmfVector(lambdas.home, dispersion)
      : side === "away"
        ? negBinPmfVector(lambdas.away, dispersion)
        : correlatedTotalPmf(lambdas.home, lambdas.away, dispersion, rho);
  const lp = lineProbs(pmf, line);
  return { pOver: applyCalibration(lp.pOverNoPush, calibration), pPush: lp.pPush };
}

interface Observation {
  pModel: number;
  pMarket: number | null;
  /** 1 = över gick in, 0 = under. Push-rader hoppas över helt. */
  hit: number;
  /** Bästa öppningspris per sida bland alla böcker. */
  bestOver: { book: string; odds: number } | null;
  bestUnder: { book: string; odds: number } | null;
  /** Stängningspris hos samma bok, för CLV. */
  closingOver: Map<string, number>;
  closingUnder: Map<string, number>;
}

function logLoss(p: number, hit: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return -(hit * Math.log(q) + (1 - hit) * Math.log(1 - q));
}

/**
 * Kalibreringskurva: hamnar 60 %-prognoserna verkligen in 60 % av gångerna?
 *
 * Skiljer två helt olika fel. Om observerad frekvens följer den predikterade
 * är modellen ärlig men saknar information marknaden redan har — då hjälper
 * ingen parametertrimning. Avviker den systematiskt är modellen skev, och det
 * går att rätta.
 */
function calibration(obs: Array<{ p: number; hit: number }>, buckets = 5) {
  const rows: Array<{ lo: number; hi: number; n: number; predicted: number; actual: number }> = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const inBucket = obs.filter((o) => o.p >= lo && (b === buckets - 1 ? o.p <= hi : o.p < hi));
    if (inBucket.length === 0) continue;
    rows.push({
      lo,
      hi,
      n: inBucket.length,
      predicted: inBucket.reduce((s, o) => s + o.p, 0) / inBucket.length,
      actual: inBucket.reduce((s, o) => s + o.hit, 0) / inBucket.length,
    });
  }
  return rows;
}

async function backtestLeague(leagueKey: string, metric: ShotMetric, minHistory: number, edgeThreshold: number) {
  const rows = (await prisma.shotMatch.findMany({
    where: { leagueKey, status: "finished", statsFetchedAt: { not: null } },
    orderBy: { kickoffAt: "asc" },
    select: {
      id: true, kickoffAt: true, homeTeamId: true, awayTeamId: true,
      homeShots: true, awayShots: true, homeSot: true, awaySot: true,
      homeCorners: true, awayCorners: true,
      homeXg: true, awayXg: true,
    },
  })) as ShotMatchRow[];

  const usable = rows.filter((r) => metricValues(r, metric) !== null);
  if (usable.length <= minHistory) {
    console.log(`  ${pad(METRIC_LABEL[metric], 14)} för lite data (${usable.length} matcher, kräver > ${minHistory})`);
    return null;
  }

  const oddsRows = (await prisma.shotOddsSnapshot.findMany({
    where: { matchId: { in: usable.map((r) => r.id) }, metric },
    select: { matchId: true, bookmaker: true, metric: true, side: true, line: true, overOdds: true, underOdds: true, isClosing: true },
  })) as OddsRow[];

  if (oddsRows.length === 0) {
    console.log(`  ${pad(METRIC_LABEL[metric], 14)} inga odds lagrade — kör shots:odds först`);
    return null;
  }

  const byMatch = new Map<string, OddsRow[]>();
  for (const o of oddsRows) {
    const list = byMatch.get(o.matchId);
    if (list) list.push(o);
    else byMatch.set(o.matchId, [o]);
  }

  // Ratings räknas om per unik speldag i stället för per match — samma
  // information (inget spelat den dagen är känt vid avspark), en bråkdel
  // av arbetet.
  const observations: Observation[] = [];
  let openingCount = 0;
  let closingCount = 0;
  let modelCache: { day: string; model: ReturnType<typeof buildLeagueModel> } | null = null;

  for (let i = minHistory; i < usable.length; i++) {
    const row = usable[i];
    const day = row.kickoffAt.toISOString().slice(0, 10);
    if (!modelCache || modelCache.day !== day) {
      const history = usable.filter((r) => r.kickoffAt < row.kickoffAt);
      modelCache = { day, model: buildLeagueModel(history, metric) };
    }
    const model = modelCache.model;
    if (!model) continue;

    const lambdas = projectFixture(model, row.homeTeamId, row.awayTeamId);
    const matchOdds = byMatch.get(row.id) ?? [];
    if (matchOdds.length === 0) continue;

    // Grupp per (side, line).
    const groups = new Map<string, OddsRow[]>();
    for (const o of matchOdds) {
      const key = `${o.side}|${o.line}`;
      const g = groups.get(key);
      if (g) g.push(o);
      else groups.set(key, [o]);
    }

    for (const [key, group] of groups) {
      const [side, lineRaw] = key.split("|");
      const line = Number(lineRaw);
      const actual = actualFor(row, metric, side);
      if (actual == null) continue;
      if (Number.isInteger(line) && actual === line) continue; // push — ingen information

      const { pOver } = modelProbOver(lambdas, model.dispersion, side, line, model.appliedRho, model.calibration);

      const openingRows = group.filter((o) => !o.isClosing);
      const closing = group.filter((o) => o.isClosing);

      // TheStatsAPI lämnar `opening` tomt för de här marknaderna — i praktiken
      // finns bara stängningspriser. Faller vi inte tillbaka på dem blir hela
      // backtestet tomt. Priset man spelar till blir då stängningen, vilket
      // gör CLV omätbar; det räknas och rapporteras separat.
      const usedOpening = openingRows.length > 0;
      const priced = usedOpening ? openingRows : closing;
      if (priced.length === 0) continue;
      if (usedOpening) openingCount += 1;
      else closingCount += 1;

      // Referensen vägs över ALLA linjer böckerna lagt på samma sida, via
      // implicit λ — böckerna lägger sällan samma linje.
      const sideQuotes = matchOdds
        .filter((o) => o.side === side && o.isClosing === !usedOpening)
        .map((o) => ({ bookmaker: o.bookmaker, line: o.line, overOdds: o.overOdds, underOdds: o.underOdds }));

      // Samma fördelningsfamilj som modellen prissätter sidan med — annars
      // läses marknadsreferensen av på en bredare fördelning än modellens och
      // edgen blåses upp på de yttersta linjerna.
      const total = lambdas.home + lambdas.away;
      const ref = marketConsensus(sideQuotes, line, {
        pmfFor:
          side === "match"
            ? correlatedTotalFamily(model.dispersion, total > 0 ? lambdas.home / total : 0.5, model.appliedRho)
            : negBinFamily(model.dispersion),
        preferBooks: DEFAULT_SHARP_BOOKS,
      });
      const pMarket = ref?.p ?? null;

      let bestOver: { book: string; odds: number } | null = null;
      let bestUnder: { book: string; odds: number } | null = null;
      for (const o of priced) {
        if (o.overOdds != null && o.overOdds > 1 && (!bestOver || o.overOdds > bestOver.odds)) {
          bestOver = { book: o.bookmaker, odds: o.overOdds };
        }
        if (o.underOdds != null && o.underOdds > 1 && (!bestUnder || o.underOdds > bestUnder.odds)) {
          bestUnder = { book: o.bookmaker, odds: o.underOdds };
        }
      }

      const closingOver = new Map<string, number>();
      const closingUnder = new Map<string, number>();
      for (const c of closing) {
        if (c.overOdds != null) closingOver.set(c.bookmaker, c.overOdds);
        if (c.underOdds != null) closingUnder.set(c.bookmaker, c.underOdds);
      }

      observations.push({
        pModel: pOver,
        pMarket,
        hit: actual > line ? 1 : 0,
        bestOver,
        bestUnder,
        closingOver,
        closingUnder,
      });
    }
  }

  if (observations.length === 0) {
    console.log(`  ${pad(METRIC_LABEL[metric], 14)} inga jämförbara linjer`);
    return null;
  }

  const withRef = observations.filter((o) => o.pMarket != null).length;

  // --- Kalibrering per blendvikt ---
  const perWeight = BLEND_WEIGHTS.map((w) => {
    let ll = 0;
    let brier = 0;
    let n = 0;
    for (const o of observations) {
      const p = blendProb(o.pModel, o.pMarket, w);
      ll += logLoss(p, o.hit);
      brier += (p - o.hit) * (p - o.hit);
      n += 1;
    }
    return { w, logLoss: ll / n, brier: brier / n, n };
  });
  const best = perWeight.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));

  // Naiv baslinje: ligans egen basfrekvens av "över".
  const baseRate = observations.reduce((s, o) => s + o.hit, 0) / observations.length;
  const baseLogLoss =
    observations.reduce((s, o) => s + logLoss(baseRate, o.hit), 0) / observations.length;

  // --- ROI och CLV vid bästa vikt ---
  let bets = 0;
  let staked = 0;
  let returned = 0;
  let wins = 0;
  let clvSum = 0;
  let clvN = 0;
  for (const o of observations) {
    const p = blendProb(o.pModel, o.pMarket, best.w);
    const eOver = o.bestOver ? priceEdge(o.bestOver.odds, p) : -Infinity;
    const eUnder = o.bestUnder ? priceEdge(o.bestUnder.odds, 1 - p) : -Infinity;
    const takeOver = eOver >= eUnder;
    const edge = Math.max(eOver, eUnder);
    if (!Number.isFinite(edge) || edge < edgeThreshold) continue;
    const pick = takeOver ? o.bestOver! : o.bestUnder!;
    const won = takeOver ? o.hit === 1 : o.hit === 0;
    bets += 1;
    staked += 1;
    if (won) {
      returned += pick.odds;
      wins += 1;
    }
    const closingOdds = (takeOver ? o.closingOver : o.closingUnder).get(pick.book);
    if (closingOdds && closingOdds > 1) {
      clvSum += pick.odds / closingOdds - 1;
      clvN += 1;
    }
  }

  const beatsBaseline = best.logLoss < baseLogLoss;
  const priceNote = openingCount === 0 ? "till stängning (inga öppningspris)" : `${openingCount} öppning / ${closingCount} stängning`;
  console.log(
    `  ${pad(METRIC_LABEL[metric], 14)} ${padL(String(observations.length), 6)} linjer · bästa w ${best.w.toFixed(2)} · ` +
      `log-loss ${best.logLoss.toFixed(4)} vs baslinje ${baseLogLoss.toFixed(4)} ${beatsBaseline ? "✓" : "✗"}`
  );
  console.log(`  ${pad("", 14)} ${padL("", 6)} marknadsref ${withRef}/${observations.length} · priser: ${priceNote}`);

  // Kalibrering: modellen för sig, marknaden för sig.
  const modelCal = calibration(observations.map((o) => ({ p: o.pModel, hit: o.hit })));
  const marketCal = calibration(
    observations.filter((o) => o.pMarket != null).map((o) => ({ p: o.pMarket as number, hit: o.hit }))
  );
  const fmtCal = (rows: ReturnType<typeof calibration>) =>
    rows.map((r) => `${(r.predicted * 100).toFixed(0)}→${(r.actual * 100).toFixed(0)}(${r.n})`).join("  ");
  console.log(`  ${pad("", 14)} ${padL("", 6)} kalib modell:   ${fmtCal(modelCal)}`);
  console.log(`  ${pad("", 14)} ${padL("", 6)} kalib marknad:  ${fmtCal(marketCal)}`);

  // Systematisk skevhet i avviggningen: hur ofta går övern in, jämfört med vad
  // det avviggade marknadspriset påstår? Proportionell avvigg antar att vigen
  // fördelas jämnt, men böcker shadar typiskt övern eftersom pengarna ligger
  // där. Är avvikelsen större än ~2 standardfel är den värd att korrigera —
  // och då sitter edgen i avviggningen, inte i modellen.
  const withMarket = observations.filter((o) => o.pMarket != null);
  if (withMarket.length > 0) {
    const predicted = withMarket.reduce((s, o) => s + (o.pMarket as number), 0) / withMarket.length;
    const actual = withMarket.reduce((s, o) => s + o.hit, 0) / withMarket.length;
    const se = Math.sqrt((actual * (1 - actual)) / withMarket.length);
    const z = se > 0 ? (actual - predicted) / se : 0;
    console.log(
      `  ${pad("", 14)} ${padL("", 6)} över-bias: marknad ${(predicted * 100).toFixed(1)} % vs utfall ` +
        `${(actual * 100).toFixed(1)} % (${((actual - predicted) * 100).toFixed(1)} pp, z=${z.toFixed(2)})` +
        `${Math.abs(z) >= 2 ? " ← systematisk" : ""}`
    );
  }
  console.log(
    `  ${pad("", 14)} ${padL(String(bets), 6)} spel · ROI ${bets ? pct(returned / staked - 1) : "—"} · ` +
      `träff ${bets ? pct(wins / bets) : "—"} · CLV ${clvN ? pct(clvSum / clvN) : "—"}`
  );

  return {
    metric,
    observations: observations.length,
    perWeight,
    best,
    baseLogLoss,
    bets,
    roi: bets ? returned / staked - 1 : null,
    clv: clvN ? clvSum / clvN : null,
  };
}

async function main() {
  if (!hasShotsDb()) {
    console.error("SHOTS_DATABASE_URL saknas i .env.local — skottmodellen har en egen databas.");
    process.exit(1);
  }

  const leagueKey = argValue("--league") ?? "all";
  const metricArg = argValue("--metric");
  const minHistory = numberArg("--min-history", 40);
  const edgeThreshold = numberArg("--edge", 2) / 100;

  const leagues =
    leagueKey === "all" ? SHOT_LEAGUES : [findLeague(leagueKey)].filter((l): l is ShotLeague => l !== null);
  if (leagues.length === 0) {
    console.error(`Okänd liga "${leagueKey}". Välj bland: ${SHOT_LEAGUES.map((l) => l.key).join(", ")}, all`);
    process.exit(1);
  }
  const metrics = metricArg ? METRICS.filter((m) => m === metricArg) : METRICS;
  if (metrics.length === 0) {
    console.error(`Okänt mätetal "${metricArg}". Välj bland: ${METRICS.join(", ")}`);
    process.exit(1);
  }

  console.log(`Minsta historik före första spel: ${minHistory} matcher`);
  console.log(`Edge-tröskel: ${(edgeThreshold * 100).toFixed(1)} %\n`);

  const results: Array<{ league: string } & NonNullable<Awaited<ReturnType<typeof backtestLeague>>>> = [];
  for (const league of leagues) {
    const stored = await prisma.shotMatch.count({ where: { leagueKey: league.key } });
    if (stored === 0) {
      console.log(`=== ${league.label} === inga matcher lagrade — kör shots:ingest --league ${league.key}\n`);
      continue;
    }
    console.log(`=== ${league.label} (${stored} matcher) ===`);
    for (const metric of metrics) {
      const r = await backtestLeague(league.key, metric, minHistory, edgeThreshold);
      if (r) results.push({ league: league.label, ...r });
    }
    console.log();
  }

  if (results.length === 0) {
    console.log("Inget att rapportera. Kör shots:ingest och shots:odds först.");
    return;
  }

  console.log("Blendvikt (log-loss per w, lägre är bättre)");
  console.log(`  ${pad("liga / mätetal", 30)}${BLEND_WEIGHTS.map((w) => padL(w.toFixed(2), 8)).join("")}`);
  for (const r of results) {
    console.log(
      `  ${pad(`${r.league} · ${METRIC_LABEL[r.metric]}`, 30)}${r.perWeight.map((p) => padL(p.logLoss.toFixed(4), 8)).join("")}`
    );
  }
  console.log("\nw = 0 är ren marknad, w = 1 är ren modell. Ligger minimum vid w = 0");
  console.log("tillför modellen inget mot marknaden ännu — låt blendvikten stå kvar låg.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
