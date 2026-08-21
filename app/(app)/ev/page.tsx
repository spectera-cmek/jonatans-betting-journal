"use client";

import { useEffect, useMemo, useState } from "react";
import { Topbar } from "@/components/Shell";
import { Card, Empty } from "@/components/ui";
import { InlineStat, MiniStat } from "@/components/stats";
import { IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import { krShort } from "@/lib/format";
import type { EvMatch, EvMatchMarket, EvMeta } from "@/lib/evScreen";

/** Visningsnamn. Okända böcker visas med sin slug hellre än att döljas. */
const BOOK_LABELS: Record<string, string> = {
  pinnacle: "Pinnacle",
  "betfair-exchange": "Betfair",
  matchbook: "Matchbook",
  "betfair-sportsbook": "Betfair SB",
  "paddy-power": "Paddy",
  "william-hill": "W Hill",
  betsson: "Betsson",
  nordicbet: "NordicBet",
  coolbet: "Coolbet",
  betinia: "Betinia",
  unibet: "Unibet",
  leovegas: "LeoVegas",
  expekt: "Expekt",
  "888sport": "888sport",
  "betmgm-se": "BetMGM",
  svenskaspel: "Svenska Spel",
  atg: "ATG",
  hajper: "Hajper",
  campobet: "CampoBet",
  mrgreen: "Mr Green",
  betclic: "Betclic",
};

const bookLabel = (key: string) => BOOK_LABELS[key] ?? key;

/**
 * Böcker som sätter fair line men som inte går att spela hos.
 *
 * De sorteras överst i rutnätet — hela skärmen mäts mot dem, så de är
 * ankaret ögat ska kunna jämföra mot utan att leta.
 */
const REFERENCE_BOOKS = ["pinnacle", "betfair-exchange", "matchbook"];

const MARKETS = [
  { key: "1x2", label: "Matchresultat" },
  { key: "totals", label: "Över/under mål" },
  { key: "ah", label: "Asiatiskt handikapp" },
];

interface EvResponse {
  matches: EvMatch[];
  meta: EvMeta;
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;

function kickoffLabel(iso: string) {
  return new Date(iso).toLocaleString("sv-SE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "nyss";
  if (mins < 60) return `${mins} min sedan`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h sedan` : `${Math.round(h / 24)} dygn sedan`;
}

function edgeTone(edge: number): string {
  if (edge >= 0.03) return "pos";
  if (edge <= 0) return "neg";
  return "";
}

/** Referensens marginal: 0,056 → "105,6 %", dvs 5,6 % påslag. */
const overroundLabel = (overround: number) => `${((1 + overround) * 100).toFixed(1)} %`;

/**
 * Utbetalning vid bästa spelbara pris — samma tal spelbolagen kallar
 * utbetalningsprocent, fast tvärs över alla böcker. Över 100 % = arbitrage.
 */
const payoutLabel = (p: number | null) => (p == null ? "—" : `${(p * 100).toFixed(1)} %`);

/** Ett utfall som kort: bästa pris, hos vem, och EV mot fair. */
function OutcomeCard({ o }: { o: EvMatchMarket["outcomes"][number] }) {
  const positive = o.bestOdds != null && o.edge > 0;
  return (
    <div className={`ap-ev-card ${positive ? "ap-ev-card-pos" : ""}`}>
      <div className="ap-ev-card-sel">{o.shortLabel}</div>
      <div className="ap-ev-card-odds ap-num">
        {o.bestOdds != null ? o.bestOdds.toFixed(2) : "—"}
      </div>
      <div className="ap-ev-card-book">{o.bestBook ? bookLabel(o.bestBook) : "—"}</div>
      <div className={`ap-ev-card-ev ap-num ${edgeTone(o.edge)}`}>
        {o.bestOdds != null ? signedPct(o.edge) : "—"}
      </div>
    </div>
  );
}

/** Rutnätet: en rad per bok, en kolumn per utfall. Bästa priset grönt. */
function BookGrid({ match }: { match: EvMatch }) {
  // Referensböckerna först — resten i den ordning API:et gav (flest priser först).
  const books = useMemo(() => {
    const refs = REFERENCE_BOOKS.filter((b) => match.books.includes(b));
    const rest = match.books.filter((b) => !REFERENCE_BOOKS.includes(b));
    return [...refs, ...rest];
  }, [match.books]);

  // Alla utfall i platt ordning, med marknadsgräns markerad för rubrikraden.
  const cols = useMemo(
    () =>
      match.markets.flatMap((m) =>
        m.outcomes.map((o, i) => ({ market: m, outcome: o, firstOfMarket: i === 0 }))
      ),
    [match.markets]
  );

  const grid = `minmax(104px, 1.2fr) repeat(${cols.length}, minmax(58px, 1fr))`;

  return (
    <div className="ap-ev-grid-wrap">
      <div className="ap-ev-grid">
        <div className="ap-ev-grid-head" style={{ gridTemplateColumns: grid }}>
          <span>Spelbolag</span>
          {cols.map((c, i) => (
            <span
              key={i}
              className={`ap-r ${c.firstOfMarket && i > 0 ? "ap-ev-colsep" : ""}`}
              title={`${c.market.marketLabel} — ${c.outcome.outcomeLabel}`}
            >
              {c.outcome.shortLabel}
            </span>
          ))}
        </div>

        {/* Fair line först: det är raden allt annat jämförs mot. */}
        <div className="ap-ev-grid-row ap-ev-grid-fair" style={{ gridTemplateColumns: grid }}>
          <span>Fair</span>
          {cols.map((c, i) => (
            <span key={i} className={`ap-r ap-num ${c.firstOfMarket && i > 0 ? "ap-ev-colsep" : ""}`}>
              {c.outcome.fairOdds.toFixed(2)}
            </span>
          ))}
        </div>

        {books.map((book) => {
          const bookIdx = match.books.indexOf(book);
          const isRef = REFERENCE_BOOKS.includes(book);
          return (
            <div
              key={book}
              className={`ap-ev-grid-row ${isRef ? "ap-ev-grid-ref" : ""}`}
              style={{ gridTemplateColumns: grid }}
            >
              <span className="ap-ell">
                {bookLabel(book)}
                {isRef && <span className="ap-tag" style={{ marginLeft: 6 }}>REF</span>}
              </span>
              {cols.map((c, i) => {
                const price = c.outcome.prices[bookIdx];
                const best = price != null && c.outcome.bestBook === book;
                return (
                  <span
                    key={i}
                    className={`ap-r ap-num ${best ? "ap-ev-best" : ""} ${
                      c.firstOfMarket && i > 0 ? "ap-ev-colsep" : ""
                    }`}
                    style={price == null ? { color: "var(--dim2)" } : undefined}
                  >
                    {price != null ? price.toFixed(2) : "—"}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Referensens kvalitet för en marknad — varför fair ligger där den ligger. */
function MarketMeta({ m }: { m: EvMatchMarket }) {
  const exchange = m.refSource === "exchange";
  return (
    <div className="ap-shot-detail-stats">
      <MiniStat
        label="Referens"
        value={exchange ? "Betfair-börsen" : "Pinnacle"}
        sub={exchange ? "mitten mellan back och lay" : "avviggad"}
      />
      <MiniStat label="Referensens marginal" value={overroundLabel(m.overround)} sub="före avviggning" />
      <MiniStat
        label="Utbetalning bästa pris"
        value={payoutLabel(m.bestPayout)}
        sub={m.bestPayout != null && m.bestPayout > 1 ? "över 100 % — arbitrage" : "tvärs alla böcker"}
      />
      {exchange && m.refSpreadPct != null && (
        <MiniStat label="Spread" value={`${m.refSpreadPct.toFixed(2)} %`} />
      )}
      {exchange && m.refMinSize != null && (
        <MiniStat label="Orderdjup" value={krShort(m.refMinSize)} sub="tunnaste sidan" />
      )}
      {m.refDisagreement != null && (
        <MiniStat label="Källorna isär" value={pct1(m.refDisagreement)} sub="börs mot Pinnacle" />
      )}
    </div>
  );
}

function MatchCard({ match }: { match: EvMatch }) {
  const [open, setOpen] = useState(false);

  return (
    <Card style={{ padding: 0 }}>
      <div className="ap-ev-match">
        <div className="ap-ev-match-head">
          <div className="ap-ev-match-when ap-num">{kickoffLabel(match.kickoffAt)}</div>
          <div className="ap-ev-match-teams">
            {match.homeTeam}–{match.awayTeam}
            <span className="ap-tag" style={{ marginLeft: 8 }}>{match.leagueLabel}</span>
          </div>
          <div className={`ap-ev-match-edge ap-num ${edgeTone(match.bestEdge)}`}>
            {signedPct(match.bestEdge)}
          </div>
        </div>

        {match.markets.map((m, i) => (
          <div key={i} className="ap-ev-market">
            <div className="ap-ev-market-head">
              <span className="ap-ev-market-name">
                {m.marketLabel}
                {m.line != null && m.market !== "1x2" && ` ${String(m.line).replace(".", ",")}`}
              </span>
              <span
                className={`ap-ev-market-or ap-num ${m.bestPayout != null && m.bestPayout > 1 ? "pos" : ""}`}
                title="Utbetalning om du tar bästa pris på varje utfall. Över 100 % = arbitrage."
              >
                {payoutLabel(m.bestPayout)}
              </span>
            </div>
            <div className="ap-ev-cards">
              {m.outcomes.map((o) => (
                <OutcomeCard key={o.outcome} o={o} />
              ))}
            </div>
          </div>
        ))}

        {match.suppressed > 0 && (
          <div className="ap-shot-warn">
            {match.suppressed} marknad{match.suppressed === 1 ? "" : "er"} visas inte — börsen och
            Pinnacle var för oense om priset, och då byter EV tecken beroende på vilken källa som
            råkar väljas.
          </div>
        )}

        <button type="button" className="ap-ev-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Dölj spelbolagen" : `Visa alla ${match.books.length} spelbolag`}
          <span className={`ap-ev-chev ${open ? "open" : ""}`}>⌄</span>
        </button>

        {open && (
          <div className="ap-ev-expand">
            <BookGrid match={match} />
            {match.markets.map((m, i) => (
              <div key={i} className="ap-ev-market-meta">
                <div className="ap-ev-market-meta-name">
                  {m.marketLabel}
                  {m.line != null && m.market !== "1x2" && ` ${String(m.line).replace(".", ",")}`}
                </div>
                <MarketMeta m={m} />
              </div>
            ))}
            <details className="ap-fine">
              <summary>Så räknas det</summary>
              <div className="ap-fine-details">
                Fair pris är börsens mittpunkt mellan bästa back och bästa lay, räknad i
                sannolikhetsrum — <em>(1/back + 1/lay) / 2</em> — och normaliserad så marknadens
                utfall summerar till 100 %. Mitten används bara när spreaden är snäv nog; annars
                används avviggad Pinnacle. Börserna utesluts ur prisjakten, eftersom en edge mätt
                mot samma bok som satte referensen är cirkulär. EV är{" "}
                <em>odds × sannolikhet − 1</em>.
              </div>
            </details>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function EvPage() {
  const [data, setData] = useState<EvResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [league, setLeague] = useState("");
  const [market, setMarket] = useState("");
  const [minEdge, setMinEdge] = useState(-100);
  const [days, setDays] = useState(14);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (league) qs.set("league", league);
    if (market) qs.set("market", market);
    qs.set("minEdge", String(minEdge / 100));
    qs.set("days", String(days));
    api
      .get<EvResponse>(`/api/ev?${qs.toString()}`)
      .then((res) => !cancelled && setData(res))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Kunde inte hämta priserna"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [league, market, minEdge, days]);

  const matches = data?.matches ?? [];
  const meta = data?.meta;

  const headline = useMemo(() => {
    if (matches.length === 0) return null;
    const positive = matches.reduce(
      (n, m) => n + m.markets.reduce((k, mk) => k + mk.outcomes.filter((o) => o.edge > 0).length, 0),
      0
    );
    return { best: matches[0].bestEdge, positive };
  }, [matches]);

  const showList = loading || (!error && !!meta?.dbConfigured && !meta.missingPrices);

  return (
    <div>
      <Topbar
        title="Oddsjämförelse"
        sub="Alla spelbolag per match, mätt mot börsen och Pinnacle"
        icon={IC.percent}
      />

      <Card>
        <div className="ap-shot-filters">
          <div className="ap-field">
            <label htmlFor="ev-league">Liga</label>
            <div className="ap-select">
              <select id="ev-league" value={league} onChange={(e) => setLeague(e.target.value)}>
                <option value="">Alla ligor</option>
                {(meta?.leagues ?? []).map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label htmlFor="ev-market">Marknad</label>
            <div className="ap-select">
              <select id="ev-market" value={market} onChange={(e) => setMarket(e.target.value)}>
                <option value="">Alla marknader</option>
                {MARKETS.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label htmlFor="ev-edge">Lägsta EV</label>
            <div className="ap-select">
              <select id="ev-edge" value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))}>
                <option value={-100}>Alla matcher</option>
                <option value={0}>0 %</option>
                <option value={1}>1 %</option>
                <option value={2}>2 %</option>
                <option value={3}>3 %</option>
                <option value={5}>5 %</option>
              </select>
            </div>
          </div>

          <div className="ap-field">
            <label htmlFor="ev-days">Horisont</label>
            <div className="ap-select">
              <select id="ev-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                <option value={2}>2 dagar</option>
                <option value={7}>7 dagar</option>
                <option value={14}>14 dagar</option>
              </select>
            </div>
          </div>
        </div>

        <div className="ap-shot-summary">
          <InlineStat label="Matcher" value={String(matches.length)} />
          <InlineStat
            label="Bästa EV"
            value={headline ? signedPct(headline.best) : "—"}
            tone={headline && headline.best > 0 ? "pos" : undefined}
          />
          <InlineStat label="Utfall över fair" value={String(headline?.positive ?? 0)} />
          <InlineStat label="Priser hämtade" value={ageLabel(meta?.capturedAt ?? null)} />
        </div>
      </Card>

      {error && (
        <Card>
          <Empty icon={IC.helpCircle} title="Kunde inte hämta priserna" hint={error} />
        </Card>
      )}

      {!error && !loading && meta && !meta.dbConfigured && (
        <Card>
          <Empty
            icon={IC.gear}
            title="Databasen är inte uppsatt"
            hint="Sätt SHOTS_DATABASE_URL i .env.local och kör npm run db:push:shots."
          />
        </Card>
      )}

      {!error && !loading && meta?.dbConfigured && meta.missingPrices && (
        <Card>
          <Empty
            icon={IC.percent}
            title="Inga priser hämtade än"
            hint="Kör npm run odds:ingest -- --confirm för att hämta matcher och priser."
          />
        </Card>
      )}

      {!error && !loading && meta && meta.handicapSignWarnings.length > 0 && (
        <Card>
          <div className="ap-shot-warn">
            Asiatiskt handikapp visas inte för{" "}
            <strong>{meta.handicapSignWarnings.join(", ")}</strong> — deras linjer pekar åt fel håll
            mot favoriten. Att jämföra böcker med olika tecken ger falsk EV på varje rad, så
            marknaden hålls tillbaka tills det är utrett.
          </div>
        </Card>
      )}

      {showList && (
        <>
          {loading && (
            <Card>
              <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--dim2)", fontSize: 14 }}>
                Laddar…
              </div>
            </Card>
          )}

          {!loading && matches.length === 0 && (
            <Card>
              <Empty
                icon={IC.search}
                title="Inga matcher med den filtreringen"
                hint="Sänk lägsta EV eller öka horisonten."
              />
            </Card>
          )}

          {!loading &&
            matches.map((m) => <MatchCard key={m.matchId} match={m} />)}
        </>
      )}
    </div>
  );
}
