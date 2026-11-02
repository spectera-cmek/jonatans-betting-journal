// ESPN:s öppna NBA-JSON: schema/resultat, boxscores, skadelista och
// DraftKings-linjer (pickcenter). Ingen nyckel, ingen kvot — samma JSON som
// espn.com själv använder. Tolkningen är ren och testas mot sparade svar i
// tests/fixtures/espn-nba-*.json.

const BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

export type GameStatus = "scheduled" | "live" | "final" | "postponed" | "canceled";

export interface EspnTeamRef {
  id: number;
  abbr: string;
  name: string;
}

export interface EspnGame {
  id: number;
  season: number;
  seasonType: number;
  startAt: Date;
  home: EspnTeamRef;
  away: EspnTeamRef;
  neutral: boolean;
  status: GameStatus;
  homeScore: number | null;
  awayScore: number | null;
  periods: number | null;
}

export interface EspnTeamBox {
  teamId: number;
  home: boolean;
  pts: number;
  fgm2: number;
  fga2: number;
  fgm3: number;
  fga3: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  tov: number;
}

export interface EspnPlayerLine {
  playerId: number;
  name: string;
  position: string | null;
  teamId: number;
  starter: boolean;
  minutes: number;
  pts: number;
  fgm2: number;
  fga2: number;
  fgm3: number;
  fga3: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  ast: number;
  tov: number;
  dnp: boolean;
  dnpReason: string | null;
}

export interface EspnOdds {
  book: string;
  /** null när boken inte prissatt marknaden. */
  ml: { home: number; away: number } | null;
  /** line = hemmalagets handicap (−5,5 = hemma favorit). */
  spread: { line: number; home: number; away: number } | null;
  total: { line: number; over: number; under: number } | null;
}

export interface EspnSummary {
  game: EspnGame;
  teams: EspnTeamBox[];
  players: EspnPlayerLine[];
  odds: EspnOdds | null;
}

export interface EspnInjury {
  playerId: number;
  playerName: string;
  teamId: number | null;
  status: string;
  detail: string | null;
  reportedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Hjälpare
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const int = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** "4-9" → [4, 9]. */
export function madeAttempted(s: unknown): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(String(s ?? "").trim());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** ESPN-minuter: "31", "31:20" eller "--". */
export function parseMinutes(s: unknown): number {
  const str = String(s ?? "").trim();
  const mm = /^(\d+):(\d{1,2})$/.exec(str);
  if (mm) return Number(mm[1]) + Number(mm[2]) / 60;
  const n = parseFloat(str);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** G | F | C ur ESPN:s positionsförkortning (PG, SG, SF, PF, C, G-F …). */
export function simplePosition(abbr: unknown): string | null {
  const a = String(abbr ?? "").toUpperCase();
  if (!a) return null;
  if (a.startsWith("C")) return "C";
  if (a.includes("PG") || a.includes("SG") || a.startsWith("G")) return "G";
  if (a.includes("F")) return "F";
  return null;
}

/** Amerikanska odds → decimalodds. */
export function americanToDecimal(a: unknown): number | null {
  const n = num(a);
  if (n == null || n === 0 || Math.abs(n) < 100) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

function statusOf(t: Any): GameStatus {
  const name = String(t?.name ?? "");
  if (/POSTPONED/.test(name)) return "postponed";
  if (/CANCEL/.test(name)) return "canceled";
  if (t?.state === "post" || t?.completed) return "final";
  if (t?.state === "in") return "live";
  return "scheduled";
}

function teamRef(c: Any): EspnTeamRef {
  return { id: int(c?.team?.id ?? c?.id), abbr: String(c?.team?.abbreviation ?? ""), name: String(c?.team?.displayName ?? c?.team?.name ?? "") };
}

/** En match ur scoreboard-event eller summary-header. */
export function parseGame(event: Any): EspnGame | null {
  const comp = event?.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c: Any) => c.homeAway === "home");
  const away = comp.competitors?.find((c: Any) => c.homeAway === "away");
  if (!home || !away) return null;
  const st = event.status?.type ?? comp.status?.type;
  const status = statusOf(st);
  const hasScore = status === "final" || status === "live";
  const periods = num(comp.status?.period ?? event.status?.period) ?? (home.linescores?.length || null);
  return {
    id: int(event.id ?? comp.id),
    season: int(event.season?.year),
    seasonType: int(event.season?.type ?? comp.type?.id ?? 2),
    startAt: new Date(event.date ?? comp.date),
    home: teamRef(home),
    away: teamRef(away),
    neutral: !!comp.neutralSite,
    status,
    homeScore: hasScore ? int(home.score) : null,
    awayScore: hasScore ? int(away.score) : null,
    periods: status === "final" ? periods : null,
  };
}

export function parseScoreboard(json: Any): EspnGame[] {
  return ((json?.events ?? []) as Any[]).map(parseGame).filter((g): g is EspnGame => !!g && g.id > 0);
}

function teamBox(t: Any, pts: number): EspnTeamBox {
  const stat = (n: string) => (t.statistics ?? []).find((s: Any) => s.name === n)?.displayValue;
  const [fgm, fga] = madeAttempted(stat("fieldGoalsMade-fieldGoalsAttempted"));
  const [fgm3, fga3] = madeAttempted(stat("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
  const [ftm, fta] = madeAttempted(stat("freeThrowsMade-freeThrowsAttempted"));
  return {
    teamId: int(t.team?.id),
    home: t.homeAway === "home",
    pts,
    fgm2: fgm - fgm3,
    fga2: fga - fga3,
    fgm3,
    fga3,
    ftm,
    fta,
    oreb: int(stat("offensiveRebounds")),
    dreb: int(stat("defensiveRebounds")),
    tov: int(stat("totalTurnovers") ?? stat("turnovers")),
  };
}

function playerLines(group: Any): EspnPlayerLine[] {
  const teamId = int(group?.team?.id);
  const st = group?.statistics?.[0];
  if (!st) return [];
  const keys: string[] = st.keys ?? [];
  const idx = (k: string) => keys.indexOf(k);
  const out: EspnPlayerLine[] = [];
  for (const a of (st.athletes ?? []) as Any[]) {
    const id = int(a.athlete?.id);
    if (!id) continue;
    const s: string[] = a.stats ?? [];
    const get = (k: string) => (idx(k) >= 0 ? s[idx(k)] : undefined);
    const [fgm, fga] = madeAttempted(get("fieldGoalsMade-fieldGoalsAttempted"));
    const [fgm3, fga3] = madeAttempted(get("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
    const [ftm, fta] = madeAttempted(get("freeThrowsMade-freeThrowsAttempted"));
    const minutes = parseMinutes(get("minutes"));
    const dnp = !!a.didNotPlay || s.length === 0;
    out.push({
      playerId: id,
      name: String(a.athlete?.displayName ?? ""),
      position: simplePosition(a.athlete?.position?.abbreviation),
      teamId,
      starter: !!a.starter,
      minutes: dnp ? 0 : minutes,
      pts: int(get("points")),
      fgm2: fgm - fgm3,
      fga2: fga - fga3,
      fgm3,
      fga3,
      ftm,
      fta,
      oreb: int(get("offensiveRebounds")),
      dreb: int(get("defensiveRebounds")),
      ast: int(get("assists")),
      tov: int(get("turnovers")),
      dnp,
      dnpReason: dnp ? (a.reason ? String(a.reason) : null) : null,
    });
  }
  return out;
}

/** DraftKings (eller ESPN:s förstaval) ur pickcenter. */
export function parsePickcenter(pc: Any): EspnOdds | null {
  const list = (Array.isArray(pc) ? pc : []) as Any[];
  if (!list.length) return null;
  const p = [...list].sort((a, b) => int(a?.provider?.priority ?? 99) - int(b?.provider?.priority ?? 99))[0];
  const book = String(p?.provider?.name ?? "espn").toLowerCase().replace(/\s+/g, "");
  const h = p.homeTeamOdds ?? {};
  const a = p.awayTeamOdds ?? {};
  const mlH = americanToDecimal(h.moneyLine);
  const mlA = americanToDecimal(a.moneyLine);
  const ml = mlH && mlA ? { home: mlH, away: mlA } : null;

  let spread: EspnOdds["spread"] = null;
  const sp = num(p.spread);
  if (sp != null) {
    const abs = Math.abs(sp);
    const line = abs === 0 ? 0 : h.favorite === true ? -abs : a.favorite === true ? abs : sp;
    const ph = americanToDecimal(h.spreadOdds ?? -110);
    const pa = americanToDecimal(a.spreadOdds ?? -110);
    if (ph && pa) spread = { line, home: ph, away: pa };
  }

  let total: EspnOdds["total"] = null;
  const ou = num(p.overUnder);
  if (ou != null && ou > 0) {
    const po = americanToDecimal(p.overOdds ?? -110);
    const pu = americanToDecimal(p.underOdds ?? -110);
    if (po && pu) total = { line: ou, over: po, under: pu };
  }
  if (!ml && !spread && !total) return null;
  return { book, ml, spread, total };
}

export function parseSummary(json: Any, eventId: number): EspnSummary | null {
  const header = json?.header;
  const game = parseGame({ ...header, id: header?.id ?? eventId, date: header?.competitions?.[0]?.date, status: header?.competitions?.[0]?.status });
  if (!game) return null;
  const box = json?.boxscore ?? {};
  const teams: EspnTeamBox[] = ((box.teams ?? []) as Any[]).map((t) =>
    teamBox(t, t.homeAway === "home" ? game.homeScore ?? 0 : game.awayScore ?? 0)
  );
  const players = ((box.players ?? []) as Any[]).flatMap(playerLines);
  return { game, teams, players, odds: parsePickcenter(json?.pickcenter) };
}

export function parseInjuries(json: Any): EspnInjury[] {
  const out: EspnInjury[] = [];
  for (const team of (json?.injuries ?? []) as Any[]) {
    const teamId = int(team.id) || null;
    for (const i of (team.injuries ?? []) as Any[]) {
      const href: string = i.athlete?.links?.[0]?.href ?? "";
      const id = int(/\/id\/(\d+)/.exec(href)?.[1] ?? i.athlete?.id);
      if (!id) continue;
      const d = i.details;
      const detail = [d?.type, d?.returnDate ? `åter ${d.returnDate}` : null].filter(Boolean).join(" · ") || i.shortComment || null;
      out.push({
        playerId: id,
        playerName: String(i.athlete?.displayName ?? ""),
        teamId,
        status: String(i.status ?? "Out"),
        detail,
        reportedAt: i.date ? new Date(i.date) : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hämtning
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ESPN_THROTTLE_MS = Number(process.env.NBA_ESPN_THROTTLE_MS) || 350;
let lastFetch = 0;

async function getJson(url: string, attempts = 4): Promise<Any> {
  for (let i = 0; i < attempts; i++) {
    const wait = ESPN_THROTTLE_MS - (Date.now() - lastFetch);
    if (wait > 0) await sleep(wait);
    lastFetch = Date.now();
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`ESPN ${res.status} ${url}`);
    } catch (e) {
      if (i === attempts - 1) throw e;
    }
    await sleep(1500 * Math.pow(2, i));
  }
  throw new Error(`ESPN svarar inte: ${url}`);
}

/** YYYYMMDD i amerikansk östkusttid — ESPN:s speldag. */
export function espnDate(d: Date): string {
  const s = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return s.replace(/-/g, "");
}

export async function fetchScoreboard(date: Date): Promise<EspnGame[]> {
  return parseScoreboard(await getJson(`${BASE}/scoreboard?dates=${espnDate(date)}&limit=50`));
}

export async function fetchSummary(eventId: number): Promise<EspnSummary | null> {
  return parseSummary(await getJson(`${BASE}/summary?event=${eventId}`), eventId);
}

export async function fetchInjuries(): Promise<EspnInjury[]> {
  return parseInjuries(await getJson(`${BASE}/injuries`));
}
