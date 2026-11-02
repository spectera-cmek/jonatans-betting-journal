/**
 * Listar bolagen i din OddsPapi-plan, med namnen som OddsPapi använder.
 * Gratis (/account räknas inte mot kvoten).
 *
 *   npm run oddspapi:books                          # alla
 *   npm run oddspapi:books -- unibet betsson smarkets   # bara de som matchar
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import net from "node:net";
// Nodes standard (250 ms per adress) ger ETIMEDOUT på långsamma nät — ge varje adress 3 s.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import { getAccount, hasOddspapiKey } from "../../lib/oddspapi";

async function main() {
  if (!hasOddspapiKey()) {
    console.error("ODDSPAPI_KEY saknas i .env.local");
    process.exit(1);
  }
  const acc = await getAccount();
  const sub = acc.subscriptions?.find((s) => s.is_active) ?? acc.subscriptions?.[0];
  const books = Object.entries(sub?.bookmakers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const filters = process.argv.slice(2).map((s) => s.toLowerCase());
  const hits = filters.length ? books.filter(([slug]) => filters.some((f) => slug.toLowerCase().includes(f))) : books;
  console.log(`${hits.length} av ${books.length} bolag${filters.length ? ` som matchar ${filters.join(", ")}` : ""}:`);
  for (const [slug, info] of hits) console.log(`  ${slug}${info?.has_player_props ? "  (props)" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
