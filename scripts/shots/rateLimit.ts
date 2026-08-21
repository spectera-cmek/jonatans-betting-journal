/**
 * Anropstakt mot TheStatsAPI.
 *
 * Kontogränsen är 120 req/min, dvs. ett anrop var 500:e ms. Marginalen nedan
 * är medveten: nätverksjitter kan annars klumpa ihop anrop och trigga 429 i
 * slutet av en minut, mitt i en körning som tar en kvart.
 */
import { TheStatsApiError } from "../../lib/theStatsApi";

/** 550 ms ⇒ ~109 req/min, under gränsen på 120. */
export const THROTTLE_MS = Number(process.env.SHOTS_THROTTLE_MS) || 550;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anrop som är värda att försöka igen: takt och tillfälliga serverfel. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof TheStatsApiError)) return false;
  return err.statusCode === 429 || err.statusCode >= 500;
}

/**
 * Kör `fn` med exponentiell backoff på 429/5xx. 404 och 401 är permanenta och
 * kastas vidare direkt — att försöka igen skulle bara bränna kvot.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const wait = 2000 * Math.pow(2, i); // 2s, 4s, 8s
      const code = err instanceof TheStatsApiError ? err.statusCode : "?";
      console.warn(`    ${code} — väntar ${wait / 1000}s och försöker igen (${i + 1}/${attempts - 1})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}
