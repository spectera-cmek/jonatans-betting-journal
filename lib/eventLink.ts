// Lagen ur en event-text. Kopplingen mot The Odds API som filen en gång
// gjorde är borttagen (ingen nyckel); kvar är tolkningen av "Hemma vs Borta".

import { splitTeams } from "./categorize";

/** Parse home/away from an event string. "@" = away @ home; "vs" = home vs away. */
export function parseHomeAway(event: string): { home: string; away: string } | null {
  const e = event.trim();
  if (!e) return null;
  if (/ @ /.test(e)) {
    const [away, home] = splitTeams(e);
    if (away && home) return { home, away };
  }
  if (/ vs /i.test(e) || / v /.test(e)) {
    const [home, away] = splitTeams(e);
    if (home && away) return { home, away };
  }
  // "Home – Away" (en-dash from event search UI)
  if (/[–—]/.test(e)) {
    const [home, away] = e.split(/[–—]/).map((s) => s.trim());
    if (home && away) return { home, away };
  }
  return null;
}
