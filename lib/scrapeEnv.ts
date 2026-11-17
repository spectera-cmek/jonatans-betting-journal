// Is the OddsPortal CLV scrape reachable from this deployment?
//
// The scrape runs the Scrapling worker: a Python process driving a real
// browser (npm run scrapling:setup). A serverless deployment has neither
// Python nor the browser, so starting the worker can only fail. Rather than
// let the button fail with a 502 on every tap, we hide it and say why.
//
// The flag is set in next.config.mjs and inlined into both the server and the
// client bundle at build time, so both sides agree without an extra request.
export const CLV_SCRAPE_AVAILABLE = process.env.NEXT_PUBLIC_CLV_SCRAPE !== "0";

export const CLV_SCRAPE_UNAVAILABLE_MESSAGE =
  "OddsPortal-hämtning kräver en lokal webbläsare och kan inte köras i molnet. Sätt closing-odds för hand, eller kör npm run scrape:clv på datorn.";
