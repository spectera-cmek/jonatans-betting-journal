// Notiser till mobilen via ntfy (NTFY_TOPIC, valfri NTFY_URL).

export interface NtfyMessage {
  title: string;
  message: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

/** Skickar en notis. false utan anrop när NTFY_TOPIC saknas eller anropet misslyckas. */
export async function sendNtfy(n: NtfyMessage): Promise<boolean> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  try {
    const res = await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title: n.title, message: n.message, priority: n.priority ?? 4, ...(n.tags ? { tags: n.tags } : {}), ...(n.click ? { click: n.click } : {}) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
