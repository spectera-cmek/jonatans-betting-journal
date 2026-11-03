/**
 * Utforskar Smarkets öppna API (ingen nyckel) för kommande NBA-matcher:
 * vilka marknader som finns (vinnare, handicap, över/under), vad de heter
 * och vad bästa back/lay är just nu. Steg ett mot att samla Smarkets-priser
 * själva — Smarkets har ingen historik, och OddsPapi har inte Smarkets.
 *
 *   npm run smarkets:discover
 *
 * Skriver en kort sammanfattning och sparar hela svaren i
 * .claude/smarkets-sample.json (lokalt, checkas inte in).
 *
 * Priser: Smarkets anger sannolikhet i baspunkter (5000 = 50 % = 2,00).
 * Back = köp till lägsta säljbud ("offers"), lay = sälj till högsta köpbud ("bids").
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
// Nodes standard (250 ms per adress) ger ETIMEDOUT på långsamma nät — ge varje adress 3 s.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);

const BASE = "https://api.smarkets.com/v3";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(p: string): Promise<{ status: number; body: unknown }> {
  await sleep(400); // snällt mot API:t
  const res = await fetch(BASE + p, { headers: { Accept: "application/json", "User-Agent": "betting-tracker/1.0 (personal use)" } });
  const text = await res.text();
  let body: unknown = text.slice(0, 300);
  try {
    body = JSON.parse(text);
  } catch {
    /* lämnas som text */
  }
  return { status: res.status, body };
}

type Ev = { id: string; name?: string; full_slug?: string; start_datetime?: string; state?: string; type?: string; parent_id?: string | null };
type Mk = { id: string; name?: string; market_type?: { name?: string; param?: string } | string; state?: string; event_id?: string };
type Ct = { id: string; name?: string; market_id: string; contract_type?: { name?: string; param?: string } | string };
type Q = { bids?: Array<{ price: number; quantity: number }>; offers?: Array<{ price: number; quantity: number }> };

const dec = (bp: number | undefined) => (bp ? (10000 / bp).toFixed(2) : "—");
const label = (t: unknown) => (typeof t === "string" ? t : t && typeof t === "object" ? [(t as { name?: string }).name, (t as { param?: string }).param].filter(Boolean).join(" ") : "");

async function main() {
  const sample: Record<string, unknown> = {};

  // 1. Kommande basketmatcher. API:t har bytt filterparametrar över tid — prova flera.
  const tries = [
    "/events/?type_domain=basketball&type_scope=single_event&state=upcoming&state=live&sort=start_datetime,id&limit=200",
    "/events/?type=basketball_match&state=upcoming&state=live&sort=start_datetime,id&limit=200",
    "/events/?type_domain=basketball&state=upcoming&limit=200",
  ];
  let events: Ev[] = [];
  for (const t of tries) {
    const r = await get(t);
    const list = (r.body as { events?: Ev[] })?.events;
    console.log(`GET ${t.split("?")[0]}?${t.split("?")[1].slice(0, 60)}… → ${r.status}${Array.isArray(list) ? `, ${list.length} event` : ""}`);
    if (r.status === 403 || (typeof r.body === "string" && /cloudflare|attention required/i.test(r.body))) {
      console.log("  Blockerad av Cloudflare — prova från ett annat nät (t.ex. mobilens hotspot) och säg till.");
    }
    if (Array.isArray(list) && list.length) {
      events = list;
      sample.eventsQuery = t;
      sample.events = list.slice(0, 20);
      break;
    }
  }
  if (!events.length) {
    console.log("Hittade inga basketmatcher. Klistra in raderna ovan, så justerar jag frågan.");
    return save(sample);
  }

  const nba = events.filter((e) => /\/nba\b|nba/i.test(`${e.full_slug ?? ""} ${e.name ?? ""}`));
  console.log(`\n${events.length} basket-event, varav ${nba.length} NBA. Exempel:`);
  for (const e of (nba.length ? nba : events).slice(0, 5)) console.log(`  ${e.id}  ${e.start_datetime ?? ""}  ${e.name ?? ""}  [${e.type ?? ""}] ${e.full_slug ?? ""}`);
  const pickEv = (nba.length ? nba : events).filter((e) => e.state !== "ended").slice(0, 2);
  if (!pickEv.length) return save(sample);

  // 2. Marknader, kontrakt och priser för två matcher.
  const ids = pickEv.map((e) => e.id).join(",");
  const mr = await get(`/events/${ids}/markets/?limit=200`);
  const markets = ((mr.body as { markets?: Mk[] })?.markets ?? []) as Mk[];
  console.log(`\nGET /events/{id}/markets/ → ${mr.status}, ${markets.length} marknader`);
  sample.markets = markets;
  if (!markets.length) return save(sample);

  const contracts: Ct[] = [];
  const quotes: Record<string, Q> = {};
  // Max ~20 marknader per anrop i URL:en.
  for (let i = 0; i < markets.length; i += 20) {
    const chunk = markets.slice(i, i + 20).map((m) => m.id).join(",");
    const cr = await get(`/markets/${chunk}/contracts/`);
    contracts.push(...(((cr.body as { contracts?: Ct[] })?.contracts ?? []) as Ct[]));
    const qr = await get(`/markets/${chunk}/quotes/`);
    if (i === 0) console.log(`GET /markets/{ids}/contracts/ → ${cr.status}   /quotes/ → ${qr.status}`);
    Object.assign(quotes, (qr.body ?? {}) as Record<string, Q>);
  }
  sample.contracts = contracts;
  sample.quotes = quotes;

  for (const e of pickEv) {
    console.log(`\n${e.name}  (${e.start_datetime})`);
    for (const m of markets.filter((x) => String(x.event_id ?? e.id) === String(e.id))) {
      const cs = contracts.filter((c) => String(c.market_id) === String(m.id));
      const parts = cs.map((c) => {
        const q = quotes[c.id] ?? quotes[String(c.id)];
        const back = q?.offers?.length ? Math.min(...q.offers.map((o) => o.price)) : undefined;
        const lay = q?.bids?.length ? Math.max(...q.bids.map((o) => o.price)) : undefined;
        return `${c.name ?? c.id} [${label(c.contract_type)}] back ${dec(back)} / lay ${dec(lay)}`;
      });
      console.log(`  ${m.name ?? m.id}  [${label(m.market_type)}]${m.state ? ` ${m.state}` : ""}`);
      for (const p of parts) console.log(`      ${p}`);
    }
  }
  save(sample);
}

function save(sample: Record<string, unknown>) {
  const file = path.join(".claude", "smarkets-sample.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sample, null, 1));
  console.log(`\nHela svaren sparade i ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
