/**
 * Engångskörning efter att ODDSPAPI_KEY satts: tar reda på NBA:s
 * turnerings-id, fotbollsligornas id och vilka basketmarknader (marketId) som
 * är moneyline, spread och total — och sparar det i lib/oddspapi/ids.json så
 * att den dagliga körningen inte behöver fråga igen.
 *
 *   npm run oddspapi:discover
 *
 * Kostar högst 3 anrop (tournaments ×2, markets). /account är gratis.
 * Turneringar som redan finns i ids.json hämtas inte igen (spara kvot);
 * --refresh hämtar allt på nytt. Ett fel i ett steg stoppar inte de andra.
 * Kontrollera utskriften — särskilt att spread-linjerna har rätt tecken —
 * och checka in ids.json.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import net from "node:net";
// Nodes standard (250 ms per adress) ger ETIMEDOUT på långsamma nät — ge varje adress 3 s.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import fs from "node:fs";
import {
  oddspapiRetry,
  getAccount,
  getMarkets,
  getTournaments,
  hasOddspapiKey,
  oddspapiBookmaker,
  oddspapiCallsThisRun,
  SPORT_BASKETBALL,
  SPORT_SOCCER,
} from "../../lib/oddspapi";
import { buildMarketMap, buildPropMarketMap, IDS_PATH, loadIds, type OddspapiIds } from "../../lib/oddspapi/markets";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  const refresh = process.argv.includes("--refresh");
  const prev = loadIds();

  // 1. NBA-turneringen (återanvänds från ids.json om den redan finns).
  let nba = refresh ? null : prev?.nba ?? null;
  if (nba) console.log(`NBA: tournamentId ${nba.tournamentId} (sparad sedan tidigare)`);
  else {
    try {
      const bt = await oddspapiRetry(() => getTournaments(SPORT_BASKETBALL));
      const hit = bt.find((t) => /^nba$/i.test(t.tournamentName)) ?? bt.find((t) => /\bnba\b/i.test(t.tournamentName) && /usa/i.test(t.categoryName));
      if (hit) nba = { tournamentId: hit.tournamentId, tournamentName: hit.tournamentName };
      console.log(hit ? `NBA: tournamentId ${hit.tournamentId} (${hit.categoryName} / ${hit.tournamentName})` : "⚠ hittade ingen NBA-turnering");
      if (!hit) console.log(`  Basketturneringar med NBA i namnet: ${bt.filter((t) => /nba/i.test(t.tournamentName)).map((t) => `${t.tournamentId} ${t.tournamentName}`).join("; ")}`);
    } catch (e) {
      console.log(`⚠ NBA-turneringen: ${errText(e)}`);
    }
  }

  // 2. Marknadskatalogen — det viktiga för NBA och props.
  let catalog: Awaited<ReturnType<typeof getMarkets>> = [];
  try {
    catalog = await oddspapiRetry(() => getMarkets());
  } catch (e) {
    console.log(`⚠ Marknadskatalogen: ${errText(e)}`);
  }
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
  const propMarkets = buildPropMarketMap(catalog);
  const propCount: Record<string, number> = {};
  for (const m of Object.values(propMarkets)) propCount[m.stat] = (propCount[m.stat] ?? 0) + 1;
  const hasProps = sub?.bookmakers?.[book]?.has_player_props;
  console.log(
    `Spelarprops: ${Object.keys(propMarkets).length} marknader (${Object.entries(propCount).map(([k, v]) => `${k} ${v}`).join(", ") || "inga"})` +
      `${hasProps === false ? ` — men ${book} har INTE props i din plan` : hasProps ? ` — ${book} har props i din plan` : ""}`
  );
  const basketAll = catalog.filter((m) => m.sportId === SPORT_BASKETBALL && !m.playerProp);
  if (!byKind.ml || !byKind.spread || !byKind.total) {
    console.log("⚠ Någon marknadstyp saknas. Basketmarknader i katalogen (de 25 första):");
    for (const m of basketAll.slice(0, 25)) console.log(`  ${m.marketId} type=${m.marketType} period=${m.period} hc=${m.handicap} "${m.marketName}" [${m.outcomes.map((o) => o.outcomeName).join("/")}]`);
  }

  // 3. Fotbollsligorna till nästa modell — ett fel här stoppar inte resten.
  let footballTournaments: Record<string, number> = (!refresh && prev?.footballTournaments) || {};
  if (Object.keys(footballTournaments).length) console.log(`Fotbollsligor: ${Object.keys(footballTournaments).length} sparade sedan tidigare`);
  else {
    try {
      const ft = await oddspapiRetry(() => getTournaments(SPORT_SOCCER));
      footballTournaments = {};
      for (const [name, [cat, tn]] of Object.entries(FOOTBALL)) {
        const hit = ft.find((t) => cat.test(`${t.categoryName} ${t.categorySlug}`) && tn.test(t.tournamentName));
        if (hit) footballTournaments[name] = hit.tournamentId;
        console.log(`${name}: ${hit ? hit.tournamentId : "hittades inte"}`);
      }
    } catch (e) {
      console.log(`⚠ Fotbollsligorna (behövs inte för NBA): ${errText(e)}`);
    }
  }

  // Behåll det som redan fanns om ett steg misslyckades.
  const ids: OddspapiIds = {
    generatedAt: new Date().toISOString(),
    bookmaker: book,
    nba: nba ?? prev?.nba ?? null,
    basketballMarkets: Object.keys(markets).length ? markets : prev?.basketballMarkets ?? {},
    basketballPropMarkets: Object.keys(propMarkets).length ? propMarkets : prev?.basketballPropMarkets ?? {},
    bookHasPlayerProps: hasProps ?? prev?.bookHasPlayerProps,
    footballTournaments,
  };
  fs.writeFileSync(IDS_PATH, JSON.stringify(ids, null, 1) + "\n");
  console.log(`Sparat i ${IDS_PATH}. Debiterade anrop: ${oddspapiCallsThisRun()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
