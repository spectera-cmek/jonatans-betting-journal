/**
 * Backtest av sega linjer — ingen modell. Spela när ett bolags odds är bättre
 * än Pinnacles rättvisa pris (utan marginal) vid samma tidpunkt, i alla
 * marknader (vinnare, spread, total). Facit: verkligt resultat (ROI) och
 * Pinnacles stängning (förväntad EV — mindre slump än ROI).
 *
 *   npm run nba:stale-lines                                   # unibet.se och betsson, 12 h före start
 *   npm run nba:stale-lines -- --books unibet.se,betsson --bet-hours 4
 *   npm run nba:stale-lines -- --from 2026-01-01 --to 2026-06-30
 *
 * Rättvist pris med power-metoden (drar mer marginal från underdogen), och en
 * stängd marknad vid speltiden räknas som inget pris.
 *
 * Kräver bolagens och Pinnacles historik:
 *   npm run nba:odds-history -- --confirm --books unibet.se,betsson [--bet-hours N]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { oddspapiBookmaker } from "../../lib/oddspapi";
import { betSource, HISTORY_CLOSING, UNRELIABLE_HISTORY_BOOKS } from "../../lib/nba/oddspapiCapture";
import { settle, type NbaMarket } from "../../lib/nba/pricing";
import { staleEv, type Quote } from "../../lib/nba/stale";
import { SUSPICIOUS_DIFF } from "../../lib/nba/backtest";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const MARKETS: NbaMarket[] = ["ml", "spread", "total"];
const THRESHOLDS = [0, 0.02, 0.04];
const NAME: Record<NbaMarket, string> = { ml: "vinnare", spread: "spread", total: "total" };

interface Bet {
  book: string;
  market: NbaMarket;
  ev: number;
  evClose: number | null;
  price: number;
  result: number; // 1 vinst, 0 förlust, 0,5 push
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const ref = oddspapiBookmaker();
  const books = (arg("--books") ?? "unibet.se,betsson").split(",").map((s) => s.trim()).filter(Boolean).filter((b) => {
    if (!UNRELIABLE_HISTORY_BOOKS.has(b)) return true;
    console.log(`${b} hoppas över: dess sparade OddsPapi-historik går inte att lita på (npm run nba:check-books -- ${b})`);
    return false;
  });
  const betHours = Number(arg("--bet-hours")) || 12;
  const BET = betSource(betHours);
  const from = new Date(`${arg("--from") ?? "2026-01-01"}T00:00:00Z`);
  const to = arg("--to") ? new Date(`${arg("--to")}T23:59:59Z`) : new Date();

  const games = await db.nbaGame.findMany({
    where: { status: "final", homeScore: { not: null }, startAt: { gte: from, lte: to } },
    select: {
      id: true,
      startAt: true,
      homeScore: true,
      awayScore: true,
      odds: { where: { book: { in: [ref, ...books] }, source: { in: [BET, HISTORY_CLOSING] } }, orderBy: { capturedAt: "desc" } },
    },
  });

  const bets: Bet[] = [];
  const best: Bet[] = []; // bästa bolaget per match och marknad (du kan spela var som helst)
  let compared = 0;
  let dropped = 0;
  for (const g of games) {
    const q = (book: string, market: NbaMarket, source: string): Quote | null => {
      const o = g.odds.find((x) => x.book === book && x.market === market && x.source === source && x.capturedAt <= g.startAt);
      return o ? { line: o.line, price1: o.price1, price2: o.price2 } : null;
    };
    for (const market of MARKETS) {
      const refBet = q(ref, market, BET);
      if (!refBet) continue;
      const refClose = q(ref, market, HISTORY_CLOSING);
      let top: Bet | null = null;
      for (const book of books) {
        const b = q(book, market, BET);
        if (!b) continue;
        compared++;
        if (market !== "ml" && (b.line == null || refBet.line == null || Math.abs(b.line - refBet.line) > SUSPICIOUS_DIFF[market])) {
          dropped++;
          continue;
        }
        const e = staleEv(market, refBet, b);
        if (!e) continue;
        const side = e.ev1 >= e.ev2 ? 1 : 2;
        const close = refClose ? staleEv(market, refClose, b) : null;
        const actual = settle(market, b.line, g.homeScore!, g.awayScore!);
        const bet: Bet = {
          book,
          market,
          ev: side === 1 ? e.ev1 : e.ev2,
          evClose: close ? (side === 1 ? close.ev1 : close.ev2) : null,
          price: side === 1 ? b.price1 : b.price2,
          result: actual === 0.5 ? 0.5 : (actual === 1) === (side === 1) ? 1 : 0,
        };
        bets.push(bet);
        if (!top || bet.ev > top.ev) top = bet;
      }
      if (top) best.push(top);
    }
  }

  console.log(`${games.length} matcher ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}, speltid ${betHours} h före start, referens ${ref}`);
  console.log(`${compared} bolagspriser jämförda${dropped ? `, ${dropped} slängda (linjen > 3/4 p från ${ref} — troligen datafel)` : ""}\n`);

  const row = (label: string, xs: Bet[]) => {
    const parts = THRESHOLDS.map((t) => {
      const s = xs.filter((x) => x.ev >= t);
      if (!s.length) return `EV ≥ ${t * 100} %: —`;
      const w = s.filter((x) => x.result === 1).length;
      const l = s.filter((x) => x.result === 0).length;
      const p = s.length - w - l;
      const profit = s.reduce((a, x) => a + (x.result === 1 ? x.price - 1 : x.result === 0 ? -1 : 0), 0);
      const cl = s.filter((x) => x.evClose != null).map((x) => x.evClose!);
      const clMean = cl.length ? cl.reduce((a, b) => a + b, 0) / cl.length : null;
      let tv: number | null = null;
      if (cl.length > 2 && clMean != null) {
        const sd = Math.sqrt(cl.reduce((a, b) => a + (b - clMean) ** 2, 0) / (cl.length - 1));
        tv = sd > 0 ? clMean / (sd / Math.sqrt(cl.length)) : null;
      }
      const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;
      return (
        `EV ≥ ${t * 100} %: ${s.length} spel ${w}-${l}-${p} snittodds ${(s.reduce((a, x) => a + x.price, 0) / s.length).toFixed(2)} ROI ${pct(profit / s.length)}  ` +
        `EV mot stängning ${clMean == null ? "—" : pct(clMean)}${tv == null ? "" : ` (t ${tv.toFixed(1)})`}`
      );
    });
    console.log(`${label.padEnd(22)} ${parts.join("   |   ")}`);
  };

  for (const market of MARKETS) {
    console.log(`— ${NAME[market]}`);
    for (const book of books) row(`  ${book}`, bets.filter((x) => x.market === market && x.book === book));
    if (books.length > 1) row("  bästa bolaget", best.filter((x) => x.market === market));
  }
  console.log("\nLäsguide: EV = vad spelet var värt mot Pinnacles rättvisa pris när du spelade.");
  console.log("\"EV mot stängning\" = samma spel värderat mot Pinnacles stängning: det mest pålitliga måttet");
  console.log("(t > 2 = svårt att få av slump). ROI är verkligt utfall men har stor slump på några hundra spel.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
