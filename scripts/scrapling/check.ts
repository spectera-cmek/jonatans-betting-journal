/**
 * Kontrollerar att Scrapling-kedjan fungerar: TS → Python-workern → nätet.
 * Hämtar en ofarlig sida, först med HTTP-läget och sedan med webbläsaren.
 * Rör ingen databas och ingen av sajterna som skrapas.
 *
 *   npm run scrapling:check
 *   npm run scrapling:check -- --headed      # visa webbläsarfönstret
 *   npm run scrapling:check -- --url https://www.oddsportal.com/
 */
import { ScraplingWorker } from "../../lib/scrapling";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const url = argValue("--url") ?? "https://example.com/";
  const worker = new ScraplingWorker({
    headed: process.argv.includes("--headed"),
    onLog: (line) => console.log(`    ${line}`),
  });
  let failed = false;
  try {
    for (const mode of ["http", "browser"] as const) {
      console.log(`\n${mode === "http" ? "HTTP-läget" : "Webbläsarläget"}: ${url}`);
      const started = Date.now();
      try {
        const res = await worker.fetch({ mode, url, timeoutMs: 120_000 });
        const title = res.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "(ingen titel)";
        const ok = res.status >= 200 && res.status < 400;
        if (!ok) failed = true;
        console.log(`  ${ok ? "✓" : "✗"} ${res.status} · "${title}" · ${res.body.length} tecken · ${Date.now() - started} ms`);
      } catch (err) {
        failed = true;
        console.log(`  ✗ ${(err as Error).message}`);
      }
    }
  } finally {
    await worker.close();
  }
  console.log(failed ? "\nNågot gick fel — se ovan. Har du kört npm run scrapling:setup?" : "\n✓ Scrapling fungerar.");
  process.exit(failed ? 1 : 0);
}

main();
