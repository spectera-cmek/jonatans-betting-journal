// Notiser till mobilen via ntfy (NTFY_TOPIC, valfri NTFY_URL).

export interface NtfyMessage {
  title: string;
  message: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

export type NtfyResult = { ok: true } | { ok: false; error: string };

/**
 * Skickar en notis. Misslyckas den sägs varför ("HTTP 429", "fetch failed"),
 * så att det går att se i loggen; `retries` ger nya försök efter `retryDelayMs`.
 */
export async function sendNtfy(n: NtfyMessage, opts: { retries?: number; retryDelayMs?: number } = {}): Promise<NtfyResult> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return { ok: false, error: "NTFY_TOPIC saknas" };
  const body = JSON.stringify({
    topic,
    title: n.title,
    message: n.message,
    priority: n.priority ?? 4,
    ...(n.tags ? { tags: n.tags } : {}),
    ...(n.click ? { click: n.click } : {}),
  });
  let error = "";
  for (let attempt = 0; attempt <= (opts.retries ?? 0); attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 5000));
    try {
      const res = await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) return { ok: true };
      error = `HTTP ${res.status}`;
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      error = cause ? `${(e as Error).message} (${cause})` : (e as Error).message;
    }
  }
  return { ok: false, error };
}
