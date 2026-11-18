// Lokala jobb: npm-skript som Windows Schemaläggare kör via scripts/run-job.cmd.
// Varje körning lämnar en SyncLog-rad "lokal:<skript>" i huvuddatabasen, så att
// sidorna kan visa hur färsk datan är. Rena funktioner — används av både
// scripts/runJob.ts och appen.

const SUMMARY_MAX = 500;
const NOTIFY_EVERY_MS = 24 * 3600e3;

/** "cs2:update" → "cs2" — avgör loggfilen (.claude/logs/<område>.log). */
export function jobArea(script: string): string {
  return script.split(":")[0];
}

/** SyncLog.kind för ett lokalt jobb. */
export function syncKind(script: string): string {
  return `lokal:${script}`;
}

/** "ok · 42 s" eller "FEL (notis) · exit 1 · 3 s · <felrad>", högst 500 tecken. */
export function runSummary(r: { exitCode: number | null; seconds: number; lastLine: string; notified: boolean }): string {
  const secs = `${Math.round(r.seconds)} s`;
  const text =
    r.exitCode === 0
      ? `ok · ${secs}`
      : [r.notified ? "FEL (notis)" : "FEL", `exit ${r.exitCode ?? "?"}`, secs, r.lastLine].filter(Boolean).join(" · ");
  return text.slice(0, SUMMARY_MAX);
}

/** Högst en notis per jobb och dygn — ett ihållande fel ska inte larma varje timme. */
export function shouldNotify(lastNotifiedAt: Date | null, now: Date): boolean {
  return !lastNotifiedAt || now.getTime() - lastNotifiedAt.getTime() >= NOTIFY_EVERY_MS;
}

/** Rader som inte säger något om felet: npm-brus, stackrader och resten av ett utskrivet felobjekt. */
const NOISE = [
  /^>/, // "> tsx scripts/…"
  /^npm (error|ERR!)( A complete log|$)/,
  /^at /, // stackrad
  /^[{}[\]()]+[,;]?$/, // ensam klammer
  /^\w+: ('.*'|".*"|undefined|null|true|false|-?\d[\d.]*|\[.*\]|\{.*\}),?$/, // "clientVersion: '5.22.0',"
];

/** Sista raden i utskriften som beskriver felet. */
export function lastMeaningfulLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.some((re) => re.test(l)));
  return lines[lines.length - 1] ?? "";
}

/** Timmar utan lyckad körning innan sidan varnar. */
export const STALE_HOURS = 30;

export interface Freshness {
  lastOkAt: string | null;
  lastRunAt: string | null;
  failed: boolean;
  error: string | null;
  /** "" = färskt, "warn" = gammalt eller aldrig kört, "neg" = senaste körningen misslyckades. */
  tone: "" | "warn" | "neg";
  /** Tid sedan senaste lyckade körning: "nyss", "5 h sedan", "3 d sedan", "aldrig". */
  label: string;
}

export function agoLabel(from: Date | null, now: Date): string {
  if (!from) return "aldrig";
  const hours = (now.getTime() - from.getTime()) / 3600e3;
  if (hours < 1) return "nyss";
  if (hours < 48) return `${Math.floor(hours)} h sedan`;
  return `${Math.floor(hours / 24)} d sedan`;
}

/** `rows` = jobbets senaste SyncLog-rader, nyast först. */
export function summarizeFreshness(rows: { ranAt: Date; summary: string }[], now: Date): Freshness {
  const last = rows[0] ?? null;
  const ok = rows.find((r) => r.summary.startsWith("ok")) ?? null;
  const failed = !!last && !last.summary.startsWith("ok");
  const stale = !ok || now.getTime() - ok.ranAt.getTime() > STALE_HOURS * 3600e3;
  return {
    lastOkAt: ok?.ranAt.toISOString() ?? null,
    lastRunAt: last?.ranAt.toISOString() ?? null,
    failed,
    error: failed ? last!.summary : null,
    tone: failed ? "neg" : stale ? "warn" : "",
    label: agoLabel(ok?.ranAt ?? null, now),
  };
}
