/**
 * Live-bevakning av sega linjer: var 30:e sekund jämförs Kambis NBA-priser
 * (Unibet, Paf) med Pinnacles rättvisa pris. När ett bolags odds är minst 3 %
 * bättre skickas en notis till mobilen (ntfy) och larmet sparas, så att vi
 * senare kan mäta vad larmen var värda mot Pinnacles stängning.
 *
 *   npm run nba:live-watch -- --once        # en jämförelse, skriver ut allt (kontroll)
 *   npm run nba:live-watch                  # bevaka till kl. 06 (svensk tid)
 *   npm run nba:live-watch -- --min-ev 0.04 --brands ubse,pafse --interval 30
 *
 * Mobilnotiser: installera appen ntfy (gratis), prenumerera på ett eget hemligt
 * kanalnamn och lägg samma namn i .env.local: NTFY_TOPIC=ditt-hemliga-namn
 * Utan NTFY_TOPIC skrivs larmen bara ut.
 *
 * Data: Kambis och Pinnacles öppna webb-API:er (ingen nyckel, inget OddsPapi-anrop).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import net from "node:net";
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { fetchKambiNba, fetchPinnacleNba, KAMBI_BRANDS, type LiveEvent } from "../../lib/live/books";
import { describeEdge, edgeKey, findEdges, matchEvents, updateWindows, type OpenWindow } from "../../lib/live/edges";
import { nickname } from "../../lib/nba/oddspapiCapture";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm" });
const hourSe = () => Number(new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Stockholm" }).format(new Date()));

async function notify(title: string, message: string, click?: string) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message, priority: 4, tags: ["basketball"], ...(click ? { click } : {}) }),
    });
  } catch (e) {
    console.log(`  (notisen gick inte fram: ${e instanceof Error ? e.message : e})`);
  }
}

async function gameIdFor(ev: LiveEvent): Promise<number | null> {
  if (!hasNbaDb()) return null;
  const teams = await db.nbaTeam.findMany();
  const byNick = new Map(teams.map((t) => [nickname(t.name), t.id]));
  const home = byNick.get(nickname(ev.home));
  const away = byNick.get(nickname(ev.away));
  if (!home || !away) return null;
  const g = await db.nbaGame.findFirst({
    where: { homeTeamId: home, awayTeamId: away, startAt: { gte: new Date(ev.start - 3 * 3600e3), lte: new Date(ev.start + 3 * 3600e3) } },
    select: { id: true },
  });
  return g?.id ?? null;
}

async function main() {
  const once = process.argv.includes("--once");
  const minEv = Number(arg("--min-ev")) || 0.03;
  const interval = (Number(arg("--interval")) || 30) * 1000;
  const brands = (arg("--brands") ?? "ubse,pafse").split(",").map((s) => s.trim()).filter(Boolean);
  const untilHour = Number(arg("--until") ?? 6);
  const startedHour = hourSe();
  console.log(`${stamp()} Bevakar Kambi (${brands.map((b) => KAMBI_BRANDS[b]?.name ?? b).join(", ")}) mot Pinnacle, larm vid EV ≥ ${minEv * 100} %${process.env.NTFY_TOPIC ? ", notiser via ntfy" : " — NTFY_TOPIC saknas, larmen skrivs bara ut"}`);

  const open = new Map<string, OpenWindow>();
  const alertIds = new Map<string, number>();
  let errors = 0;

  for (;;) {
    try {
      const ref = await fetchPinnacleNba();
      for (const brand of brands) {
        const book = await fetchKambiNba(brand);
        const pairs = matchEvents(book, ref).filter((p) => p.book.start > Date.now());
        if (once) {
          console.log(`\n${KAMBI_BRANDS[brand]?.name ?? brand}: ${book.length} matcher, ${pairs.length} kopplade till Pinnacle (${ref.length} matcher där)`);
          for (const { book: b, ref: r } of pairs) {
            console.log(`  ${b.away} @ ${b.home}  ${new Date(b.start).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })}`);
            for (const kind of ["ml", "spread", "total"] as const) {
              const km = b.markets.find((m) => m.kind === kind);
              const pm = r.markets.find((m) => m.kind === kind && !m.alt);
              const f = (m?: { line: number | null; price1: number; price2: number }) => (m ? `${m.line ?? ""} ${m.price1.toFixed(2)}/${m.price2.toFixed(2)}` : "—");
              console.log(`    ${kind.padEnd(6)} Kambi ${f(km).padEnd(18)} Pinnacle ${f(pm)}   (${r.markets.filter((m) => m.kind === kind).length} linjer hos Pinnacle)`);
            }
            for (const e of findEdges(b, r, -1).sort((x, y) => y.ev - x.ev).slice(0, 3)) console.log(`    bäst: ${describeEdge(b, e)}${e.sameLine ? "" : " (omräknad linje)"}`);
          }
          continue;
        }
        const current = pairs.flatMap(({ book: b, ref: r }) => findEdges(b, r, minEv).map((edge) => ({ key: edgeKey(brand, b.id, edge), edge, ev: b })));
        const evByKey = new Map(current.map((c) => [c.key, c.ev]));
        const { alert, closed } = updateWindows(
          open,
          current.map(({ key, edge }) => ({ key, edge })),
          Date.now()
        );
        for (const w of alert) {
          const ev = evByKey.get(w.key)!;
          const text = describeEdge(ev, w.edge);
          const name = KAMBI_BRANDS[brand]?.name ?? brand;
          console.log(`${stamp()} LARM ${name}: ${ev.away} @ ${ev.home} — ${text}`);
          await notify(`${name}: ${ev.away} @ ${ev.home}`, text, KAMBI_BRANDS[brand]?.url(ev.id));
          if (hasNbaDb() && !alertIds.has(w.key)) {
            const row = await db.nbaLiveAlert.create({
              data: {
                brand,
                eventId: ev.id,
                gameId: await gameIdFor(ev),
                home: ev.home,
                away: ev.away,
                startAt: new Date(ev.start),
                market: w.edge.kind,
                line: w.edge.line,
                side: w.edge.side,
                price: w.edge.price,
                fairPrice: w.edge.fairPrice,
                ev: w.edge.ev,
                maxEv: w.maxEv,
                refLine: w.edge.refLine,
                sameLine: w.edge.sameLine,
                openedAt: new Date(w.openedAt),
              },
            });
            alertIds.set(w.key, row.id);
          } else if (alertIds.has(w.key)) {
            await db.nbaLiveAlert.update({ where: { id: alertIds.get(w.key)! }, data: { maxEv: w.maxEv } });
          }
        }
        for (const w of closed) {
          const id = alertIds.get(w.key);
          if (id != null) {
            await db.nbaLiveAlert.update({ where: { id }, data: { closedAt: new Date(), maxEv: w.maxEv } }).catch(() => null);
            alertIds.delete(w.key);
          }
          console.log(`${stamp()} stängt efter ${Math.round((Date.now() - w.openedAt) / 60e3)} min: ${w.key}`);
        }
      }
      errors = 0;
    } catch (e) {
      errors++;
      console.log(`${stamp()} fel (${errors}): ${e instanceof Error ? e.message : e}`);
      if (errors >= 20) throw e;
      await sleep(Math.min(300e3, interval * 2 ** Math.min(errors, 4)));
      continue;
    }
    if (once) break;
    // Stoppa vid --until (standard kl. 06), räknat från starttimmen.
    const h = hourSe();
    if (startedHour >= untilHour ? h >= untilHour && h < startedHour : h >= untilHour) {
      console.log(`${stamp()} Klart för i dag.`);
      break;
    }
    await sleep(interval);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
