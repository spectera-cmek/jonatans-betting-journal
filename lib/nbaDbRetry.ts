// Försök igen vid tillfälliga databasfel: Neon stänger långa eller vilande
// anslutningar (P1017), nätet hackar, poolen är full. Andra fel kastas direkt.

/** Prisma-koder för fel som går över av sig själva. */
const TRANSIENT_DB = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

export function isTransientDb(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && TRANSIENT_DB.has(code)) return true;
  return /closed the connection|connection reset|ECONNRESET|Can't reach database|timed out/i.test(e instanceof Error ? e.message : String(e));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kör `fn` och försöker igen vid tillfälliga databasfel med ny anslutning.
 * Väntar `waits` sekunder mellan försöken (standard 5 → 15 → 30 → 60).
 */
export async function withDbRetry<T>(
  db: { $disconnect(): Promise<void> },
  fn: () => Promise<T>,
  opts: { label?: string; log?: (m: string) => void; waits?: number[] } = {}
): Promise<T> {
  const waits = opts.waits ?? [5, 15, 30, 60];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientDb(e) || i >= waits.length) throw e;
      opts.log?.(`${opts.label ? `${opts.label}: ` : ""}databasen kopplade ner — försöker igen om ${waits[i]} s (${i + 1}/${waits.length})`);
      await db.$disconnect().catch(() => null);
      await sleep(waits[i] * 1000);
    }
  }
}
