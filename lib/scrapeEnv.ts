// Is the OddsPortal CLV scrape reachable from this deployment?
//
// The scrape drives a real Chromium through Playwright. Playwright keeps its
// browser binaries in a user-level cache outside the project directory
// (~/.cache/ms-playwright), and a serverless bundle contains only the project
// plus traced node_modules — so the browser is never there and
// chromium.launch() can only throw. Rather than let the button fail with a 502
// on every tap, we hide it and say why.
//
// The flag is set in next.config.mjs and inlined into both the server and the
// client bundle at build time, so both sides agree without an extra request.
export const CLV_SCRAPE_AVAILABLE = process.env.NEXT_PUBLIC_CLV_SCRAPE !== "0";

export const CLV_SCRAPE_UNAVAILABLE_MESSAGE =
  "OddsPortal-hämtning kräver en lokal webbläsare och kan inte köras i molnet. Sätt closing-odds för hand, eller kör npm run scrape:clv på datorn.";
