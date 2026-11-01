/**
 * Engångskörning efter att ODDSPAPI_KEY satts: tar reda på NBA:s
 * turnerings-id, fotbollsligornas id och vilka basketmarknader (marketId) som
 * är moneyline, spread och total — och sparar det i lib/oddspapi/ids.json så
 * att den dagliga körningen inte behöver fråga igen.
 *
 *   npm run oddspapi:discover
 *
 * Kostar 3 anrop (tournaments ×2, markets). /account är gratis.
 * Kontrollera utskriften — särskilt att spread-linjerna har rätt tecken —
 * och checka in ids.json.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import fs from "node:fs";
import {
  getAccount,
  getMarkets,
  getTournaments,
  hasOddspapiKey,
  oddspapiBookmaker,
  oddspapiCallsThisRun,
  SPORT_BASKETBALL,
  SPORT_SOCCER,
} from "../../lib/oddspapi";
import { buildMarketMap, IDS_PATH, type OddspapiIds } from "../../lib/oddspapi/markets";

/** Fotbollsligorna den kommande fotbollsmodellen ska täcka: namn → [land/kategori, turneringsnamn]. */
const FOOTBALL: Record<string, [RegExp, RegExp]> = {
  "Premier League": [/england/i, /^premier league$/i],
  Allsvenskan: [/sweden/i, /^allsvenskan$/i],
  "La Liga": [/spain/i, /^la ?liga$/i],
  "Serie A": [/italy/i, /^serie a$/i],
  Bundesliga: [/germany/i, /^bundesliga$/i],
  "Champions League": [/international/i, /champions league/i],
};

async function main() {
  if (!hasOddspapiKey()) {
    console.error("ODDSPAPI_KEY saknas i .env.local");
    process.exit(1);
  }
  const book = oddspapiBookmaker();
  const acc = await getAccount();
  const sub = acc.subscriptions?.find((s) => s.is_active) ?? acc.subscriptions?.[0];
  if (sub) {
    console.log(`Konto: ${sub.request_count ?? "?"}/${sub.request_limit ?? "?"} anrop använda, sporter ${sub.sport_ids?.join(", ") ?? "?"}`);
    const books = Object.keys(sub.bookmakers ?? {});
    console.log(`Böcker i planen (${books.length}): ${books.slice(0, 40).join(", ")}${books.length > 40 ? " …" : ""}`);
    if (books.length && !books.includes(book)) {
      console.log(`⚠ ${book} finns inte i din plan — sätt ODDSPAPI_BOOKMAKER till en av böckerna ovan.`);
    }
  }

  const bt = await getTournaments(SPORT_BASKETBALL);
  const nba = bt.find((t) => /^nba$/i.test(t.tournamentName)) ?? bt.find((t) => /\bnba\b/i.test(t.tournamentName) && /usa/i.test(t.categoryName));
  console.log(nba ? `NBA: tournamentId ${nba.tournamentId} (${nba.categoryName} / ${nba.tournamentName})` : "⚠ hittade ingen NBA-turnering");
  if (!nba) console.log(`  Basketturneringar med NBA i namnet: ${bt.filter((t) => /nba/i.test(t.tournamentName)).map((t) => `${t.tournamentId} ${t.tournamentName}`).join("; ")}`);

  const ft = await getTournaments(SPORT_SOCCER);
  const footballTournaments: Record<string, number> = {};
  for (const [name, [cat, tn]] of Object.entries(FOOTBALL)) {
    const hit = ft.find((t) => cat.test(`${t.categoryName} ${t.categorySlug}`) && tn.test(t.tournamentName));
    if (hit) footballTournaments[name] = hit.tournamentId;
    console.log(`${name}: ${hit ? hit.tournamentId : "hittades inte"}`);
  }

  const catalog = await getMarkets();
  const markets = buildMarketMap(catalog);
  const byKind = { ml: 0, spread: 0, total: 0 };
  for (const m of Object.values(markets)) byKind[m.kind]++;
  console.log(`Basketmarknader: ${byKind.ml} moneyline, ${byKind.spread} spread-linjer, ${byKind.total} total-linjer`);
  const sample = (kind: string) =>
    Object.entries(markets)
      .filter(([, m]) => m.kind === kind)
      .slice(0, 4)
      .map(([id, m]) => `${id} "${m.name}" linje ${m.line}`)
      .join("; ");
  console.log(`  ml:     ${sample("ml")}`);
  console.log(`  spread: ${sample("spread")}`);
  console.log(`  total:  ${sample("total")}`);
  const basketAll = catalog.filter((m) => m.sportId === SPORT_BASKETBALL && !m.playerProp);
  if (!byKind.ml || !byKind.spread || !byKind.total) {
    console.log("⚠ Någon marknadstyp saknas. Basketmarknader i katalogen (de 25 första):");
    for (const m of basketAll.slice(0, 25)) console.log(`  ${m.marketId} type=${m.marketType} period=${m.period} hc=${m.handicap} "${m.marketName}" [${m.outcomes.map((o) => o.outcomeName).join("/")}]`);
  }

  const ids: OddspapiIds = {
    generatedAt: new Date().toISOString(),
    bookmaker: book,
    nba: nba ? { tournamentId: nba.tournamentId, tournamentName: nba.tournamentName } : null,
    basketballMarkets: markets,
    footballTournaments,
  };
  fs.writeFileSync(IDS_PATH, JSON.stringify(ids, null, 1) + "\n");
  console.log(`Sparat i ${IDS_PATH}. Debiterade anrop: ${oddspapiCallsThisRun()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
