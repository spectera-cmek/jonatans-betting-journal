/**
 * Import closing lines (CLV) from a BetHero CSV export into the journal.
 *
 *   npx tsx scripts/importBetheroClv.ts --file "C:/Users/ompam/Downloads/bets.csv"
 *   npx tsx scripts/importBetheroClv.ts --file bets.csv --confirm
 *   npx tsx scripts/importBetheroClv.ts --file bets.csv --user jonatan --report clv-report.tsv
 *
 * BetHero's "CURRENT FAIR ODDS" is the de-vigged closing line, and its CLV
 * column is exactly odds / current-fair-odds - 1 — the same formula the journal
 * uses on `closingOdds`. So we store CURRENT FAIR ODDS as `closingOdds` and the
 * journal reproduces BetHero's CLV number.
 *
 * Rows where BetHero leaves CLV blank are skipped (no closing line captured);
 * pass --include-blank-clv to import those on the fair-odds column anyway.
 *
 * Dry-run is the default. A confirmed run backs up every affected row first.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BACKUP_DIR = ".claude/backups";

/** BetHero timestamps are Europe/Stockholm wall clock; the DB stores UTC. */
const CSV_UTC_OFFSET_HOURS = 2;

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

// ---------------------------------------------------------------- CSV parsing

interface CsvRow {
  index: number; // 1-based data row, for reporting
  sport: string;
  league: string;
  event: string;
  eventTime: Date | null;
  bet: string;
  book: string;
  stake: number | null;
  odds: number | null;
  clvPct: number | null;
  fairOdds: number | null;
  closingFairOdds: number | null;
  status: string;
  placedAt: Date | null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number(raw.replace("%", "").trim());
  return Number.isFinite(v) ? v : null;
}

/** "2026-07-26 20:35" in Stockholm wall clock -> UTC Date. */
function parseStockholm(raw: string | undefined): Date | null {
  if (!raw?.trim()) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(
    Date.UTC(+y, +mo - 1, +d, +h - CSV_UTC_OFFSET_HOURS, +mi)
  );
}

function loadRows(file: string): CsvRow[] {
  const table = parseCsv(readFileSync(file, "utf8"));
  const header = table[0].map((h) => h.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    sport: col("SPORT"),
    league: col("LEAGUE"),
    event: col("EVENT"),
    time: col("TIME"),
    bet: col("BET"),
    book: col("BOOK"),
    stake: col("STAKE"),
    odds: col("ODDS"),
    clv: col("CLV"),
    fair: col("FAIR ODDS"),
    closing: col("CURRENT FAIR ODDS"),
    status: col("STATUS"),
    placed: col("PLACED"),
  };
  return table.slice(1).map((r, i) => ({
    index: i + 1,
    sport: (r[idx.sport] ?? "").trim(),
    league: (r[idx.league] ?? "").trim(),
    event: (r[idx.event] ?? "").trim(),
    eventTime: parseStockholm(r[idx.time]),
    bet: (r[idx.bet] ?? "").trim(),
    book: (r[idx.book] ?? "").trim(),
    stake: num(r[idx.stake]),
    odds: num(r[idx.odds]),
    clvPct: num(r[idx.clv]),
    fairOdds: num(r[idx.fair]),
    closingFairOdds: num(r[idx.closing]),
    status: (r[idx.status] ?? "").trim(),
    placedAt: parseStockholm(r[idx.placed]),
  }));
}

// ------------------------------------------------------------- text matching

/**
 * Token aliases. Two jobs: initialisms plain prefix matching cannot resolve
 * ("kc" is not a prefix of "kansas"), and the Swedish/Spanish/Portuguese names
 * the journal stores where BetHero writes English.
 */
const ALIASES: Record<string, string> = {
  // US franchise shorthands
  kc: "kansas city",
  ny: "new york",
  nyc: "new york",
  la: "los angeles",
  sf: "san francisco",
  tb: "tampa bay",
  sd: "san diego",
  stl: "st louis",
  ne: "new england",
  gs: "golden state",
  gsw: "golden state",
  nyy: "new york yankees",
  nym: "new york mets",
  cws: "chicago white sox",
  // Countries — the journal logs World Cup bets with Swedish names
  frankrike: "france",
  francia: "france",
  spanien: "spain",
  espana: "spain",
  sverige: "sweden",
  brasilien: "brazil",
  brasil: "brazil",
  norge: "norway",
  danmark: "denmark",
  tyskland: "germany",
  belgien: "belgium",
  schweiz: "switzerland",
  suiza: "switzerland",
  kanada: "canada",
  sydafrika: "south africa",
  marocko: "morocco",
  marruecos: "morocco",
  mexiko: "mexico",
  inglaterra: "england",
  japan: "japan",
  osterrike: "austria",
  slovakien: "slovakia",
  kroatien: "croatia",
  egypten: "egypt",
  egito: "egypt",
  jordanien: "jordan",
  irland: "ireland",
  nordmakedonien: "north macedonia",
  makedonien: "macedonia",
  luxemburgo: "luxembourg",
  algeriet: "algeria",
  argelia: "algeria",
  kongo: "congo",
  kap: "cape",
  verde: "verde",
  equador: "ecuador",
  portugal: "portugal",
  senegal: "senegal",
  ghana: "ghana",
  tromso: "tromso",
  // Market vocabulary — English (BetHero) -> Swedish (journal)
  cards: "kort",
  card: "kort",
  corners: "hornor",
  corner: "hornor",
  hornor: "hornor",
  horna: "hornor",
  goals: "mal",
  goal: "mal",
  shots: "skott",
  shot: "skott",
  points: "poang",
  rebounds: "returer",
  assists: "assist",
  hits: "traffar",
  runs: "runs",
  aces: "ess",
  games: "game",
  threes: "treor",
  bases: "baser",
  strikeouts: "strikeouts",
  outs: "outs",
  handicap: "handikapp",
  moneyline: "matchvinnare",
  dnb: "draw no bet",
  yes: "ja",
  no: "nej",
  ja: "ja",
  nej: "nej",
  over: "over",
  ov: "over",
  ovr: "over",
  under: "under",
  half: "halvlek",
  halvlek: "halvlek",
  bada: "both",
  lagen: "teams",
  both: "both",
  teams: "teams",
  score: "mal",
  vinnare: "matchvinnare",
  vinner: "matchvinnare",
};

const STOP = new Set([
  "vs",
  "v",
  "the",
  "fc",
  "sc",
  "cf",
  "afc",
  "club",
  "att",
  "vinna",
  "match",
  "de",
  "of",
  "total",
  "player",
  "team",
  "and",
  "women",
  "men",
  "singles",
]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "a")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of norm(s).split(" ")) {
    const t = raw.replace(/\.$/, "");
    if (!t || STOP.has(t)) continue;
    const alias = ALIASES[t];
    if (alias) out.push(...alias.split(" "));
    else out.push(t);
  }
  return out;
}

function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 3 && long.startsWith(short)) return true;
  // Tolerate one-character OCR noise on longer words ("tabasco" / "tabacco").
  if (short.length >= 5 && Math.abs(a.length - b.length) <= 1) {
    return levenshtein(a, b) <= 1;
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Symmetric token overlap, 0..1. */
function tokenScore(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const used = new Set<number>();
  let hits = 0;
  for (const ta of A) {
    for (let j = 0; j < B.length; j++) {
      if (used.has(j)) continue;
      if (tokenMatch(ta, B[j])) {
        used.add(j);
        hits++;
        break;
      }
    }
  }
  return (2 * hits) / (A.length + B.length);
}

/** Character-bigram Dice coefficient, 0..1 — robust to OCR noise. */
function diceScore(a: string, b: string): number {
  const grams = (s: string) => {
    const t = norm(s).replace(/ /g, "");
    const g = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) {
      const k = t.slice(i, i + 2);
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of A.values()) sizeA += n;
  for (const n of B.values()) sizeB += n;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) ?? 0);
  if (!sizeA || !sizeB) return 0;
  return (2 * inter) / (sizeA + sizeB);
}

/** Handicap/total line stated in a bet description, if any. */
function extractLine(text: string): number | null {
  const t = norm(text);
  const m = [...t.matchAll(/(?:over|under|\+|-)\s*(\d+(?:\.\d+)?)/g)];
  if (m.length) return Number(m[m.length - 1][1]);
  const any = [...t.matchAll(/(\d+(?:\.\d+)?)/g)];
  return any.length ? Number(any[any.length - 1][1]) : null;
}

/**
 * Which side of the line the bet is on. "Över 4.5 kort" and "Under 4.5 kort"
 * otherwise look near-identical to every other signal, so a disagreement here
 * has to veto the match.
 */
function extractDirection(text: string): "over" | "under" | null {
  const t = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  // "14+ skott" is an over; "+1.5" and "-1.5" are the two handicap sides.
  const over = /\bover\b/.test(t) || /\d\+/.test(t) || /\s\+\d/.test(t);
  const under = /\bunder\b/.test(t) || /\s-\d/.test(t);
  if (over === under) return null;
  return over ? "over" : "under";
}

const SPORT_ALIAS: Record<string, string> = {
  soccer: "football",
  "e-sports": "esports",
  esports: "esports",
  "ice hockey": "ice hockey",
  mma: "mma",
};

function normSport(s: string | null | undefined): string {
  const t = norm(s ?? "");
  return SPORT_ALIAS[t] ?? t;
}

function normBook(s: string | null | undefined): string {
  return norm(s ?? "")
    .replace(/\bse\b/g, "")
    .replace(/casino|betting|sport(sbook)?/g, "")
    .replace(/\s+/g, "")
    .replace("dbbet", "dbet")
    .replace("veraandjohn", "verajohn")
    // The journal writes Vera&John with the Swedish "och".
    .replace("veraochjohn", "verajohn")
    .replace("vera john", "verajohn")
    .trim();
}

// ------------------------------------------------------------------ matching

interface DbBet {
  id: string;
  placedAt: Date;
  eventAt: Date | null;
  sport: string | null;
  league: string | null;
  event: string;
  marketCategory: string | null;
  selection: string;
  line: number | null;
  odds: number;
  stakeUnits: number;
  bookmaker: string | null;
  closingOdds: number | null;
  betType: string;
  outcome: string;
  notes: string | null;
}

interface Scored {
  row: CsvRow;
  bet: DbBet;
  score: number;
  parts: string;
  flags: string[];
}

/** Same price, allowing for rounding on either side (1.909 vs 1.91). */
function oddsSame(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.012 || Math.abs(a - b) / Math.max(a, b) <= 0.006;
}

function oddsNear(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) <= 0.05;
}

function hoursApart(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

function scorePair(row: CsvRow, bet: DbBet): Scored | null {
  if (row.odds == null) return null;

  const ref = row.placedAt ?? row.eventTime;
  if (!ref) return null;
  const dtPlaced = hoursApart(bet.placedAt, ref);
  const dtEvent =
    row.eventTime && bet.eventAt ? hoursApart(bet.eventAt, row.eventTime) : Infinity;
  const dt = Math.min(dtPlaced, dtEvent);
  if (dt > 72) return null;

  const flags: string[] = [];
  const bookScore = normBook(row.book) && normBook(row.book) === normBook(bet.bookmaker) ? 1 : 0;
  const stakeScore =
    row.stake != null && Math.abs(row.stake / 100 - bet.stakeUnits) <= 0.011 ? 1 : 0;

  // Odds are the strongest signal, so a mismatch only survives when the ticket
  // is otherwise pinned down (same book, same stake, same minute).
  let oddsScore: number;
  if (oddsSame(row.odds, bet.odds)) oddsScore = 1;
  else if (oddsNear(row.odds, bet.odds)) {
    oddsScore = 0.3;
    flags.push(`odds ${bet.odds} vs bethero ${row.odds}`);
  } else if (bookScore === 1 && stakeScore === 1 && dtPlaced <= 0.75) {
    oddsScore = 0;
    flags.push(`ODDS ${bet.odds} vs bethero ${row.odds}`);
  } else return null;

  const eventScore = Math.max(
    tokenScore(row.event, bet.event),
    diceScore(row.event, bet.event)
  );
  const dbSel = `${bet.marketCategory ?? ""} ${bet.selection}`;
  const selScore = Math.max(tokenScore(row.bet, dbSel), diceScore(row.bet, dbSel));
  // Screenshot imports sometimes garble the event line, so a bet can still be
  // identified by its selection alone — but only on an otherwise perfect ticket.
  if (eventScore < 0.3) {
    const identified =
      oddsScore === 1 && selScore >= 0.55 && bookScore === 1 && stakeScore === 1;
    if (!identified) return null;
  }
  // A price that does not match has to come from the same bookmaker to be
  // believable; market wording alone repeats too easily across a slate. The one
  // exception is a ticket pinned to the same minute and stake, where it is the
  // bookmaker label that is wrong rather than the pairing.
  const sameTicket = stakeScore === 1 && dtPlaced <= 0.25;
  if (oddsScore < 1 && bookScore === 0 && bet.bookmaker && !sameTicket) return null;

  // Lines are compared unsigned: the journal stores handicaps signed (-2) while
  // BetHero writes them in the label. A half-point apart is the same bet stated
  // two ways ("5+ strikeouts" == "Over 4.5").
  const csvLine = extractLine(row.bet);
  const dbLine = bet.line ?? extractLine(bet.selection);
  let lineScore = 0;
  if (csvLine != null && dbLine != null) {
    const gap = Math.abs(Math.abs(csvLine) - Math.abs(dbLine));
    lineScore = gap < 0.001 ? 1 : gap <= 0.5 ? 0.3 : -1;
  }

  // Over vs under on the same line looks identical to every other signal.
  const csvDir = extractDirection(row.bet);
  const dbDir = extractDirection(bet.selection);
  let dirScore = 0;
  if (csvDir && dbDir) {
    if (csvDir === dbDir) dirScore = 0.5;
    else return null;
  }

  const timeScore = dt <= 1 ? 1 : dt <= 6 ? 0.8 : dt <= 26 ? 0.5 : 0.15;
  const sportScore = normSport(row.sport) === normSport(bet.sport) ? 1 : 0;

  // Same event + same price is not enough on its own: the journal often holds
  // several markets on one match at similar odds. When the market wording gives
  // no support, demand two independent confirmations instead.
  if (selScore < 0.25 && lineScore < 1) {
    const corroboration =
      bookScore + stakeScore + (dtPlaced <= 0.15 ? 1 : 0) + (dirScore > 0 ? 1 : 0);
    if (corroboration < 2) return null;
  }

  const score =
    2.0 * oddsScore +
    2.2 * eventScore +
    1.6 * selScore +
    1.0 * lineScore +
    1.0 * dirScore +
    1.0 * timeScore +
    0.6 * bookScore +
    0.5 * stakeScore +
    0.4 * sportScore;

  if (selScore < 0.25) flags.push(`svag marknadsmatch (sel=${selScore.toFixed(2)})`);
  if (lineScore < 0) flags.push(`linje ${dbLine} vs bethero ${csvLine}`);

  const parts = [
    `odds=${oddsScore}`,
    `ev=${eventScore.toFixed(2)}`,
    `sel=${selScore.toFixed(2)}`,
    `line=${lineScore}`,
    `dir=${dirScore}`,
    `dt=${dt.toFixed(1)}h`,
    `book=${bookScore}`,
    `stake=${stakeScore}`,
    `sport=${sportScore}`,
  ].join(" ");
  return { row, bet, score, parts, flags };
}

const MIN_SCORE = 4.8;

async function main() {
  const file = argValue("--file");
  if (!file) {
    console.error('Missing --file "path/to/bets.csv"');
    process.exit(1);
  }
  const confirm = process.argv.includes("--confirm");
  const includeBlankClv = process.argv.includes("--include-blank-clv");
  const overwrite = process.argv.includes("--overwrite");
  const username = (argValue("--user") ?? "jonatan").toLowerCase();
  const reportPath = argValue("--report");

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`No such user: ${username}`);
    process.exit(1);
  }

  const all = loadRows(file);
  const usable = all.filter((r) => {
    if (r.odds == null || r.closingFairOdds == null || r.closingFairOdds <= 1) return false;
    return includeBlankClv || r.clvPct != null;
  });
  console.log(`CSV rows: ${all.length}`);
  console.log(
    `Usable (closing line${includeBlankClv ? "" : " + CLV"} present): ${usable.length}`
  );

  const times = usable
    .map((r) => (r.placedAt ?? r.eventTime)?.getTime())
    .filter((t): t is number => t != null && Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!times.length) {
    console.log("Nothing to match — no usable rows with a placed or event time.");
    return;
  }
  const from = new Date(times[0] - 5 * 86_400_000);
  const to = new Date(times[times.length - 1] + 5 * 86_400_000);

  const bets = (await prisma.bet.findMany({
    where: { userId: user.id, placedAt: { gte: from, lte: to } },
    orderBy: { placedAt: "asc" },
  })) as unknown as DbBet[];
  console.log(`Journal bets in window: ${bets.length}\n`);

  // Score every plausible pair, then assign greedily best-first (1 CSV row : 1 bet).
  const pairs: Scored[] = [];
  for (const row of usable) {
    for (const bet of bets) {
      const s = scorePair(row, bet);
      if (s && s.score >= MIN_SCORE) pairs.push(s);
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const betToRow = new Map<string, Scored>();
  const rowMatched = new Map<number, Scored>();
  for (const p of pairs) {
    if (betToRow.has(p.bet.id) || rowMatched.has(p.row.index)) continue;
    betToRow.set(p.bet.id, p);
    rowMatched.set(p.row.index, p);
  }

  // Sibling pass: the journal sometimes splits one BetHero row into several
  // tickets (same market, same odds, minutes apart). The closing line is a
  // property of the market, so it applies to every one of them.
  const siblings: Scored[] = [];
  for (const bet of bets) {
    if (betToRow.has(bet.id)) continue;
    let best: Scored | null = null;
    for (const p of rowMatched.values()) {
      if (!oddsSame(p.bet.odds, bet.odds)) continue;
      if (hoursApart(p.bet.placedAt, bet.placedAt) > 12) continue;
      if (tokenScore(p.bet.event, bet.event) < 0.75) continue;
      if (tokenScore(p.bet.selection, bet.selection) < 0.75) continue;
      if ((p.bet.line ?? null) !== (bet.line ?? null)) continue;
      const cand: Scored = {
        row: p.row,
        bet,
        score: p.score,
        parts: `sibling of ${p.bet.id}`,
        flags: p.flags,
      };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) {
      siblings.push(best);
      betToRow.set(bet.id, best);
    }
  }

  const applied = [...betToRow.values()];
  const skippedExisting = applied.filter(
    (p) => p.bet.closingOdds != null && !overwrite && p.bet.closingOdds !== p.row.closingFairOdds
  );
  const writes = applied.filter((p) => {
    if (p.bet.closingOdds == null) return true;
    if (p.bet.closingOdds === p.row.closingFairOdds) return false;
    return overwrite;
  });

  const unmatched = usable.filter((r) => !rowMatched.has(r.index));

  const rowOf = (p: Scored) =>
    [
      p.row.index,
      p.score.toFixed(2),
      p.row.event,
      p.row.bet,
      p.row.odds,
      p.row.closingFairOdds,
      (((p.bet.odds / p.row.closingFairOdds!) - 1) * 100).toFixed(2),
      p.bet.id,
      p.bet.event,
      p.bet.selection,
      p.bet.odds,
      p.bet.closingOdds ?? "",
      p.parts,
      p.flags.join("; "),
    ].join("\t");

  const lines: string[] = [];
  lines.push(
    ["csv#", "score", "csv_event", "csv_bet", "odds", "closing", "clv%", "db_id", "db_event", "db_selection", "db_odds", "db_closing_now", "parts", "flags"].join("\t")
  );
  for (const p of applied.sort((a, b) => a.row.index - b.row.index)) lines.push(rowOf(p));

  const flagged = applied.filter((p) => p.flags.length);
  lines.push("");
  lines.push(`FLAGGED FOR REVIEW (${flagged.length})`);
  for (const p of flagged.sort((a, b) => a.row.index - b.row.index)) lines.push(rowOf(p));

  lines.push("");
  lines.push(`UNMATCHED CSV ROWS (${unmatched.length})`);
  for (const r of unmatched) {
    lines.push(
      [r.index, "-", r.event, r.bet, r.odds, r.closingFairOdds, r.clvPct ?? "", r.book, r.placedAt?.toISOString() ?? ""].join("\t")
    );
  }
  const report = lines.join("\n");
  if (reportPath) {
    writeFileSync(reportPath, report, "utf8");
    console.log(`Report written to ${reportPath}`);
  } else {
    console.log(report);
  }

  console.log("");
  console.log(`Matched CSV rows : ${rowMatched.size} / ${usable.length}`);
  console.log(`Bets to update   : ${writes.length} (incl. ${siblings.length} sibling tickets)`);
  console.log(`Already had CLV  : ${applied.length - writes.length}`);
  if (skippedExisting.length)
    console.log(`Kept existing    : ${skippedExisting.length} (pass --overwrite to replace)`);
  console.log(`Unmatched rows   : ${unmatched.length}`);

  if (!confirm) {
    console.log("\nDRY-RUN — nothing written. Re-run with --confirm to apply.");
    return;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${BACKUP_DIR}/bethero-clv-${stamp}.json`;
  writeFileSync(
    backup,
    JSON.stringify(
      writes.map((p) => ({
        id: p.bet.id,
        event: p.bet.event,
        selection: p.bet.selection,
        odds: p.bet.odds,
        previousClosingOdds: p.bet.closingOdds,
        newClosingOdds: p.row.closingFairOdds,
        csvRow: p.row.index,
      })),
      null,
      2
    ),
    "utf8"
  );
  console.log(`\nBackup: ${backup}`);

  let written = 0;
  for (const p of writes) {
    await prisma.bet.update({
      where: { id: p.bet.id },
      data: { closingOdds: p.row.closingFairOdds, closingSource: "bethero_fair" },
    });
    written++;
  }
  console.log(`Updated ${written} bet(s) with closing odds.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
