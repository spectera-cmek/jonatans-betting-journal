// Timezone-correct day/week helpers. The app's "day" is the Swedish calendar
// day regardless of where the server runs (Vercel = UTC), so boundaries are
// computed in Europe/Stockholm via Intl. Pure & dependency-free.

const TZ = "Europe/Stockholm";

// One Intl.DateTimeFormat per timezone, built once. `toLocaleDateString` with a
// timeZone option constructs a fresh formatter internally on every call (~59 us);
// reusing the instance is ~27x cheaper and yields the identical string. This is
// the hot path of the metrics aggregations — weekly/monthly/tilt call dayIso
// once per bet, so it runs ~50k times per /api/metrics request.
const dayFmts = new Map<string, Intl.DateTimeFormat>();
function dayFmt(tz: string): Intl.DateTimeFormat {
  let f = dayFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("sv-SE", { timeZone: tz });
    dayFmts.set(tz, f);
  }
  return f;
}

/** ISO day (YYYY-MM-DD) for a timestamp, in Swedish local time. */
export function dayIso(d: Date | string | number, tz: string = TZ): string {
  // The sv-SE locale formats dates as YYYY-MM-DD.
  return dayFmt(tz).format(typeof d === "number" ? d : new Date(d));
}

/** Epoch ms for an ISO day string at UTC noon — cheap numeric window bounds. */
export function isoDayToUtcNoon(iso: string): number {
  return Date.parse(iso + "T12:00:00Z");
}

/** Monday-first weekday index (0–6) of an ISO day string. */
export function weekdayIdx(iso: string): number {
  // Anchor at UTC noon so DST shifts can't move the date.
  const d = new Date(iso + "T12:00:00Z");
  return (d.getUTCDay() + 6) % 7;
}

/** Add n days to an ISO day string. */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface WeekWindow {
  start: string; // Monday, inclusive
  end: string; // Sunday, inclusive
}

/** Monday–Sunday window containing the given time (Swedish calendar). */
export function weekOf(d: Date | string | number, tz: string = TZ): WeekWindow {
  const day = dayIso(d, tz);
  const start = addDays(day, -weekdayIdx(day));
  return { start, end: addDays(start, 6) };
}

/** First–last day window of the calendar month containing the given time (Swedish calendar). */
export function monthOf(d: Date | string | number, tz: string = TZ): WeekWindow {
  const day = dayIso(d, tz);
  const start = day.slice(0, 7) + "-01";
  // Day 0 of the next month = the last day of this month (UTC noon dodges DST).
  const end = new Date(start + "T12:00:00Z");
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { start, end: end.toISOString().slice(0, 10) };
}

/** ISO 8601 week number of an ISO day string (for display: "v.24"). */
export function isoWeekNo(iso: string): number {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 864e5));
}
