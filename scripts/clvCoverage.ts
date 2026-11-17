/**
 * Var saknas closing-odds, och varför? Läser bara — skriver ingenting.
 *
 *   npm run clv:coverage
 *   npm run clv:coverage -- --since 2025-01-01    # bara bets från och med datumet
 *
 * Räknar varje bet som KAN ha closing-odds (inte boostat, riktiga odds) och
 * delar upp de som saknar det efter skälet till att scrape:clv inte tar dem:
 * kombi, props, statistikmarknad, sport som inte skrapas, för gammalt för
 * standardfönstret — eller "skrapbar", alltså värd att köra igen.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { hasRealOdds } from "../lib/betting";
import { isScrapeableMarket, SCRAPEABLE_SPORTS } from "../lib/clvOddsPortalBatch";
import { planMarket } from "../lib/oddsPortal/scrape";

const prisma = new PrismaClient();
const DAY_MS = 86_400_000;
/** scrape:clv:s standardfönster (--since-days). */
const DEFAULT_WINDOW_DAYS = 14;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

type Bet = Awaited<ReturnType<typeof loadBets>>[number];

function loadBets(since: Date | undefined) {
  return prisma.bet.findMany({
    where: since ? { OR: [{ eventAt: { gte: since } }, { eventAt: null, placedAt: { gte: since } }] } : {},
    select: {
      sport: true,
      league: true,
      eventKind: true,
      betType: true,
      market: true,
      marketCategory: true,
      marketScope: true,
      selection: true,
      selectionSide: true,
      line: true,
      odds: true,
      closingOdds: true,
      boosted: true,
      eventAt: true,
      placedAt: true,
      event: true,
      homeTeam: true,
      awayTeam: true,
    },
  });
}

/** Varför scrape:clv inte hämtar closing för betet — eller "skrapbar". */
function reason(b: Bet, now: number): string {
  if (b.betType !== "single") return "Kombi/flera ben";
  if (b.eventKind !== "match") return "Långtidsspel (outright)";
  if (b.marketScope === "player") return "Spelarprops";
  if (!(SCRAPEABLE_SPORTS as readonly string[]).includes(b.sport ?? "")) return `Sport som inte skrapas (${b.sport || "saknas"})`;
  if (!isScrapeableMarket(b.market, b.marketCategory)) return `Annan marknad (${b.marketCategory || b.market})`;
  const plan = planMarket({ ...b, selection: b.selection });
  if (!plan.ok) return `Går inte på OddsPortal: ${plan.detail.split(" — ")[0]}`;
  const t = (b.eventAt ?? b.placedAt).getTime();
  if (t > now) return "Inte spelad än";
  if (now - t > DEFAULT_WINDOW_DAYS * DAY_MS) return `Skrapbar, äldre än ${DEFAULT_WINDOW_DAYS} dagar`;
  return "Skrapbar, senaste 14 dagarna";
}

function table(title: string, counts: Map<string, number>, total: number, max = 15) {
  console.log(`\n${title}`);
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rows.slice(0, max)) {
    console.log(`  ${String(n).padStart(6)}  ${((n / total) * 100).toFixed(1).padStart(5)} %  ${k}`);
  }
  if (rows.length > max) {
    const rest = rows.slice(max).reduce((s, [, n]) => s + n, 0);
    console.log(`  ${String(rest).padStart(6)}  ${((rest / total) * 100).toFixed(1).padStart(5)} %  (${rows.length - max} till)`);
  }
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

async function main() {
  const sinceRaw = argValue("--since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  const now = Date.now();
  const bets = await loadBets(since);

  const eligible = bets.filter((b) => !b.boosted && hasRealOdds(b));
  const missing = eligible.filter((b) => !(b.closingOdds != null && b.closingOdds > 1));
  const have = eligible.length - missing.length;
  console.log(`Bets${since ? ` från ${since.toISOString().slice(0, 10)}` : ""}: ${bets.length}`);
  console.log(`  kan ha closing-odds: ${eligible.length} (boostade och platshållarodds räknas bort)`);
  console.log(`  har closing-odds:    ${have} (${eligible.length ? ((have / eligible.length) * 100).toFixed(1) : "–"} %)`);
  console.log(`  saknar:              ${missing.length}`);
  if (missing.length === 0) return;

  const byReason = new Map<string, number>();
  const bySport = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byYear = new Map<string, number>();
  const scrapeable: Bet[] = [];
  for (const b of missing) {
    const r = reason(b, now);
    bump(byReason, r);
    bump(bySport, b.sport || "(ingen sport)");
    bump(byCategory, `${b.sport || "?"} · ${b.marketCategory || b.market}${b.marketScope ? ` (${b.marketScope})` : ""}`);
    bump(byYear, String((b.eventAt ?? b.placedAt).getFullYear()));
    if (r.startsWith("Skrapbar")) scrapeable.push(b);
  }

  table("Varför closing saknas", byReason, missing.length);
  table("Saknas per sport", bySport, missing.length);
  table("Saknas per marknad", byCategory, missing.length, 25);
  table("Saknas per år", byYear, missing.length);

  if (scrapeable.length) {
    const oldest = scrapeable.reduce((a, b) => ((a.eventAt ?? a.placedAt) < (b.eventAt ?? b.placedAt) ? a : b));
    const days = Math.ceil((now - (oldest.eventAt ?? oldest.placedAt).getTime()) / DAY_MS);
    console.log(`\n${scrapeable.length} bets går att försöka hämta. Äldsta är ${days} dagar gammalt — för att ta alla:`);
    console.log(`  npm run scrape:clv -- --since-days ${days} --limit ${scrapeable.length}            # torrkörning`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message.split("\n").filter(Boolean).slice(-1)[0] : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
