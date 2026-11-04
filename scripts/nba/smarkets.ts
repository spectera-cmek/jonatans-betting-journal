/**
 * Smarkets priser för kommande NBA-matcher (gratis, ingen nyckel).
 * Sparar hela stegen (alla linjer) när något ändrats, och huvudlinjen som
 * vanligt odds så att appen visar modellens edge mot Smarkets (efter 2 % provision).
 *
 *   npm run nba:smarkets               # matcher inom 36 h
 *   npm run nba:smarkets -- --hours 12
 *
 * Körs varje timme av Schemaläggaren (npm run install:nba-tasks) och i
 * nba:update / nba:closing / nba:lineups. Smarkets har ingen historik —
 * det här bygger vår egen, för att senare kunna mäta modellen mot Smarkets.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import net from "node:net";
// Nodes standard (250 ms per adress) ger ETIMEDOUT på långsamma nät — ge varje adress 3 s.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { nbaPrisma as db, hasNbaDb } from "../../lib/nbaDb";
import { captureSmarkets } from "../../lib/nba/smarketsCapture";
import { captureKambiProps } from "../../lib/nba/kambiProps";

async function main() {
  if (!hasNbaDb()) {
    console.error("NBA_DATABASE_URL saknas i .env.local");
    process.exit(1);
  }
  const i = process.argv.indexOf("--hours");
  const hours = i === -1 ? 36 : Number(process.argv[i + 1]) || 36;
  const r = await captureSmarkets(db, { hours, log: (m) => console.log(m) });
  if (!r.events) console.log("Inga kommande NBA-matcher på Smarkets just nu.");
  if (r.unmatched.length) console.log(`Ej kopplade (matchen saknas i databasen — kör nba:update): ${r.unmatched.slice(0, 5).join("; ")}`);
  // Kambis spelarprops (svenska bolag) följer med i timkörningen — gratis.
  await captureKambiProps(db, { hours, log: (m) => console.log(`Kambi-props: ${m}`) }).catch((e) => console.log(`Kambi-props: hoppar över (${e instanceof Error ? e.message : e})`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
