/**
 * Vad var larmen från nba:live-watch värda? Per marknad och bolag: antal larm,
 * hur länge de var öppna, EV när de kom, EV mot Pinnacles sista pris före
 * start (det pålitliga måttet) och verkligt utfall om man spelat alla.
 *
 *   npm run nba:live-report
 *   npm run nba:live-report -- --days 14
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { settle, type NbaMarket } from "../../lib/nba/pricing";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const days = Number(arg("--days")) || 365;
  const alerts = await db.nbaLiveAlert.findMany({ where: { openedAt: { gte: new Date(Date.now() - days * 864e5) } }, orderBy: { openedAt: "asc" } });
  if (!alerts.length) {
    console.log("Inga larm än. Bevakningen (BettingTracker-NbaLive) sparar dem när de kommer.");
    return;
  }
  const games = new Map(
    (await db.nbaGame.findMany({ where: { id: { in: alerts.map((a) => a.gameId).filter((x): x is number => x != null) } }, select: { id: true, status: true, homeScore: true, awayScore: true } })).map((g) => [g.id, g])
  );
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;
  const tstat = (xs: number[]) => {
    if (xs.length < 3) return "";
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    return sd > 0 ? ` (t ${(m / (sd / Math.sqrt(xs.length))).toFixed(1)})` : "";
  };
  console.log(`${alerts.length} larm sedan ${alerts[0].openedAt.toISOString().slice(0, 10)}\n`);
  const groups = new Map<string, typeof alerts>();
  for (const a of alerts) groups.set(`${a.market}|${a.brand}`, [...(groups.get(`${a.market}|${a.brand}`) ?? []), a]);
  for (const [k, xs] of [...groups].sort()) {
    const [market, brand] = k.split("|");
    const mins = xs.filter((a) => a.closedAt).map((a) => (a.closedAt!.getTime() - a.openedAt.getTime()) / 60e3).sort((a, b) => a - b);
    const cl = xs.filter((a) => a.evClose != null).map((a) => a.evClose!);
    let w = 0;
    let l = 0;
    let p = 0;
    let profit = 0;
    for (const a of xs) {
      const g = a.gameId != null ? games.get(a.gameId) : null;
      if (!g || g.status !== "final" || g.homeScore == null || g.awayScore == null) continue;
      const y = settle(market as NbaMarket, a.line, g.homeScore, g.awayScore);
      if (y === 0.5) p++;
      else if ((y === 1) === (a.side === 1)) {
        w++;
        profit += a.price - 1;
      } else {
        l++;
        profit -= 1;
      }
    }
    const settled = w + l + p;
    console.log(
      `${market.padEnd(6)} ${brand.padEnd(6)} ${xs.length} larm, median öppet ${mins.length ? mins[Math.floor(mins.length / 2)].toFixed(0) : "—"} min, ` +
        `EV vid larm ${pct(xs.reduce((a, b) => a + b.ev, 0) / xs.length)}, ` +
        `mot Pinnacles stängning ${cl.length ? pct(cl.reduce((a, b) => a + b, 0) / cl.length) + tstat(cl) : "—"} (${cl.length} st), ` +
        `utfall ${settled ? `${w}-${l}-${p} ROI ${pct(profit / settled)}` : "—"}`
    );
  }
  console.log("\nLäsguide: \"mot Pinnacles stängning\" över 0 med t > 2 = larmen är äkta värde. ROI har stor slump de första hundratals spelen.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
