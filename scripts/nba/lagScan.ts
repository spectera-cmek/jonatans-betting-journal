/**
 * Hur ofta, hur länge och när ligger dina bolag efter Pinnacle? Går igenom
 * varje prisändring (OddsPapi-historiken, gratis) de sista 24 h före start
 * och hittar fönster där bolagets odds är bättre än Pinnacles rättvisa pris
 * på samma linje. Vinnare, spread och total.
 *
 *   npm run nba:lag-scan                                   # unibet.se + betsson, EV ≥ 2 %
 *   npm run nba:lag-scan -- --min-ev 0.03 --books unibet.se
 *   npm run nba:lag-scan -- --from 2026-10-01 --max 100
 *
 * Historiken sparas i .claude/oddspapi-history/ (lokalt) — en omkörning med
 * andra trösklar tar sekunder. Första körningen ≈ 5,4 s per match.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
// Nodes standard (250 ms per adress) ger ETIMEDOUT på långsamma nät — ge varje adress 3 s.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { getHistoricalOdds, hasOddspapiKey, oddspapiBookmaker, oddspapiRetry, OddspapiError, type OpHistoricalOdds, type OpHistoryEntry } from "../../lib/oddspapi";
import { loadIds, type MarketSpec } from "../../lib/oddspapi/markets";
import { valueWindows, type ValueWindow } from "../../lib/nba/lag";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const CACHE = path.join(".claude", "oddspapi-history");
const KINDS = ["ml", "spread", "total"] as const;
type Kind = (typeof KINDS)[number];
const NAME: Record<Kind, string> = { ml: "vinnare", spread: "spread", total: "total" };
/** Pinnacles pris på vår sida: sållar bort tunna alternativa linjer. */
const BAND: Record<Kind, [number, number]> = { ml: [1.05, 6], spread: [1.6, 2.5], total: [1.6, 2.5] };

interface Found extends ValueWindow {
  gameId: number;
  book: string;
  kind: Kind;
}

async function history(fixtureId: string, books: string[]): Promise<OpHistoricalOdds | null> {
  const file = path.join(CACHE, `${fixtureId}.json`);
  if (fs.existsSync(file)) {
    const h = JSON.parse(fs.readFileSync(file, "utf8")) as OpHistoricalOdds | null;
    if (!h || books.every((b) => h.bookmakers?.[b])) return h;
  }
  let h: OpHistoricalOdds | null = null;
  try {
    h = await oddspapiRetry(() => getHistoricalOdds(fixtureId, books), 5);
  } catch (e) {
    if (!(e instanceof OddspapiError && e.statusCode === 404)) throw e;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(h));
  return h;
}

const series = (h: OpHistoricalOdds, book: string, marketId: string, outcomeId: string): OpHistoryEntry[] => {
  const oc = h.bookmakers?.[book]?.markets?.[marketId]?.outcomes?.[outcomeId];
  const s = oc?.players?.["0"] ?? Object.values(oc?.players ?? {})[0];
  return Array.isArray(s) ? s : [];
};

/** Överlappande fönster (grannlinjer, samma sida) räknas som ett — det med högst EV. */
function dedupe(ws: Found[]): Found[] {
  const out: Found[] = [];
  const groups = new Map<string, Found[]>();
  for (const w of ws) {
    const k = `${w.gameId}|${w.book}|${w.kind}|${w.side}`;
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.openedAt - b.openedAt);
    let cur: Found | null = null;
    for (const w of g) {
      if (cur && w.openedAt < cur.closedAt) {
        if (w.ev > cur.ev) cur = { ...w, closedAt: Math.max(cur.closedAt, w.closedAt) };
        else cur.closedAt = Math.max(cur.closedAt, w.closedAt);
      } else {
        if (cur) out.push(cur);
        cur = { ...w };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

const hourSe = (t: number) => Number(new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Stockholm" }).format(new Date(t)));

async function main() {
  if (!hasNbaDb() || !hasOddspapiKey()) {
    console.error("NBA_DATABASE_URL och ODDSPAPI_KEY måste finnas i .env.local");
    process.exit(1);
  }
  const ids = loadIds();
  const markets = (ids?.basketballMarkets ?? {}) as Record<string, MarketSpec>;
  if (!Object.keys(markets).length) {
    console.error("lib/oddspapi/ids.json saknas — kör npm run oddspapi:discover");
    process.exit(1);
  }
  const ref = oddspapiBookmaker();
  const books = (arg("--books") ?? "unibet.se,betsson").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 2);
  const minEv = Number(arg("--min-ev")) || 0.02;
  const from = new Date(`${arg("--from") ?? "2026-01-01"}T00:00:00Z`);
  const to = arg("--to") ? new Date(`${arg("--to")}T23:59:59Z`) : new Date();
  const max = Number(arg("--max")) || 5000;

  const games = await db.nbaGame.findMany({
    where: { status: "final", startAt: { gte: from, lte: to }, oddspapiFixtureId: { not: null } },
    select: { id: true, startAt: true, oddspapiFixtureId: true },
    orderBy: { startAt: "asc" },
    take: max,
  });
  const cached = games.filter((g) => fs.existsSync(path.join(CACHE, `${g.oddspapiFixtureId}.json`))).length;
  console.log(`${games.length} matcher, ${cached} redan sparade lokalt — ≈ ${Math.ceil(((games.length - cached) * 5.4) / 60)} min att hämta. Bolag: ${books.join(", ")} mot ${ref}, EV ≥ ${minEv * 100} %`);

  const found: Found[] = [];
  let withData = 0;
  for (const [i, g] of games.entries()) {
    const h = await history(g.oddspapiFixtureId!, [ref, ...books]);
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${games.length}`);
    if (!h) continue;
    withData++;
    const start = g.startAt.getTime();
    for (const [marketId, spec] of Object.entries(markets)) {
      const out1 = Object.keys(spec.sides).find((o) => spec.sides[o] === 1);
      const out2 = Object.keys(spec.sides).find((o) => spec.sides[o] === 2);
      if (!out1 || !out2 || !(KINDS as readonly string[]).includes(spec.kind)) continue;
      if (spec.kind === "total" && (spec.line ?? 0) < 150) continue; // lagtotaler
      const r1 = series(h, ref, marketId, out1);
      const r2 = series(h, ref, marketId, out2);
      if (!r1.length || !r2.length) continue;
      for (const book of books) {
        const b1 = series(h, book, marketId, out1);
        const b2 = series(h, book, marketId, out2);
        if (!b1.length || !b2.length) continue;
        const ws = valueWindows({ ref1: r1, ref2: r2, book1: b1, book2: b2 }, { from: start - 24 * 3600e3, start, minEv, priceBand: BAND[spec.kind as Kind] });
        for (const w of ws) found.push({ ...w, gameId: g.id, book, kind: spec.kind as Kind });
      }
    }
  }

  const all = dedupe(found);
  console.log(`\n${withData} matcher med historik. Fönster = bolagets odds minst ${minEv * 100} % bättre än Pinnacles rättvisa pris på samma linje.\n`);
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;
  const stat = (xs: number[]) => {
    if (!xs.length) return "—";
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 2 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
    return `${pct(m)}${sd > 0 ? ` (t ${(m / (sd / Math.sqrt(xs.length))).toFixed(1)})` : ""}`;
  };
  for (const kind of KINDS) {
    console.log(`— ${NAME[kind]}`);
    for (const book of books) {
      const ws = all.filter((w) => w.kind === kind && w.book === book);
      if (!ws.length) {
        console.log(`  ${book.padEnd(10)} inga fönster`);
        continue;
      }
      const mins = ws.map((w) => (w.closedAt - w.openedAt) / 60e3).sort((a, b) => a - b);
      const long = ws.filter((w) => w.closedAt - w.openedAt >= 5 * 60e3);
      const by = (k: ValueWindow["closedBy"]) => Math.round((ws.filter((w) => w.closedBy === k).length / ws.length) * 100);
      console.log(
        `  ${book.padEnd(10)} ${ws.length} fönster (${(ws.length / Math.max(1, withData)).toFixed(2)} per match), median ${mins[Math.floor(mins.length / 2)].toFixed(0)} min, ` +
          `${Math.round((long.length / ws.length) * 100)} % öppna ≥ 5 min, snitt-EV ${pct(ws.reduce((a, w) => a + w.ev, 0) / ws.length)}`
      );
      console.log(
        `  ${"".padEnd(10)} EV mot stängning: alla ${stat(ws.filter((w) => w.evClose != null).map((w) => w.evClose!))}   ` +
          `öppna ≥ 5 min ${stat(long.filter((w) => w.evClose != null).map((w) => w.evClose!))}`
      );
      console.log(`  ${"".padEnd(10)} stängdes av: bolaget ${by("book")} %, Pinnacle ${by("ref")} %, stängd marknad ${by("suspended")} %, matchstart ${by("start")} %`);
      const buckets = [
        ["00–06", 0, 6],
        ["06–12", 6, 12],
        ["12–18", 12, 18],
        ["18–24", 18, 24],
      ] as const;
      console.log(
        `  ${"".padEnd(10)} öppnade (svensk tid): ${buckets.map(([l, a, b]) => `${l} ${ws.filter((w) => hourSe(w.openedAt) >= a && hourSe(w.openedAt) < b).length}`).join("  ")}`
      );
    }
  }
  console.log("\nLäsguide: \"EV mot stängning\" med t > 2 = fönstren är äkta värde, inte brus.");
  console.log("Stängda av Pinnacle = Pinnacle flyttade tillbaka (brus). Stängda av bolaget = bolaget kom ifatt (äkta eftersläpning).");
  console.log("\"Öppna ≥ 5 min\" är de du realistiskt hinner spela.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
