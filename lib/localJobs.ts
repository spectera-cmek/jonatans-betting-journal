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

/** Sista icke-tomma raden som inte är npm:s eget brus ("> tsx …"). */
export function lastMeaningfulLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(">") && !/^npm (error|ERR!)( A complete log|$)/.test(l));
  return lines[lines.length - 1] ?? "";
}
