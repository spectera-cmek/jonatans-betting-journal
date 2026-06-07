// Display helpers. All math is in units; format to currency/percent here.

export function fmtUnits(n: number | null | undefined, withArrow = true): string {
  if (n == null) return "—";
  const v = Math.abs(n).toFixed(2);
  if (n > 0) return `${withArrow ? "▲ " : ""}+${v}U`;
  if (n < 0) return `${withArrow ? "▼ " : ""}-${v}U`;
  return `0.00U`;
}

export function fmtCurrency(
  n: number | null | undefined,
  currency = "kr",
  withArrow = true
): string {
  if (n == null) return "—";
  const v = Math.round(Math.abs(n)).toLocaleString("sv-SE");
  if (n > 0) return `${withArrow ? "▲ " : ""}+${v} ${currency}`;
  if (n < 0) return `${withArrow ? "▼ " : ""}-${v} ${currency}`;
  return `0 ${currency}`;
}

export function fmtPct(
  n: number | null | undefined,
  withArrow = true,
  digits = 1
): string {
  if (n == null) return "—";
  const v = Math.abs(n).toFixed(digits);
  if (n > 0) return `${withArrow ? "▲ " : ""}+${v}%`;
  if (n < 0) return `${withArrow ? "▼ " : ""}-${v}%`;
  return `0.0%`;
}

export function fmtOdds(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toFixed(2);
}

export function fmtStake(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}U`;
}

export function fmtMoney(n: number | null | undefined, currency = "kr"): string {
  if (n == null) return "—";
  return `${Math.round(n).toLocaleString("sv-SE")} ${currency}`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("sv-SE");
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Tailwind text-color class for a signed value (legacy callers). */
export function signClass(n: number | null | undefined): string {
  if (n == null || n === 0) return "text-text-mid";
  return n > 0 ? "text-pos" : "text-neg";
}

/* ---------- Aurora-style formatters (sv-SE, signed) ---------- */

// "+18 420 kr" / "−1 500 kr"
export function krFmt(n: number | null | undefined, sign = false): string {
  if (n == null) return "—";
  const s = Math.round(Math.abs(n)).toLocaleString("sv-SE");
  return (n < 0 ? "−" : sign ? "+" : "") + s + " kr";
}

// "+1,9k" / "−800" — compact
export function krShort(n: number | null | undefined, sign = false): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  let s: string;
  if (a >= 1000) s = (a / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 }) + "k";
  else s = a.toLocaleString("sv-SE");
  return (n < 0 ? "−" : sign ? "+" : "") + s;
}

// "+92,1u"
export function uFmt(n: number | null | undefined, sign = false): string {
  if (n == null) return "—";
  return (
    (n < 0 ? "−" : sign ? "+" : "") +
    Math.abs(n).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) +
    "u"
  );
}

// "+7,8%"
export function pctFmt(n: number | null | undefined, sign = false): string {
  if (n == null) return "—";
  return (
    (n < 0 ? "−" : sign ? "+" : "") +
    Math.abs(n).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) +
    "%"
  );
}

// 2-letter sport tag for compact table cells.
const SPORT_TAGS: Record<string, string> = {
  Fotboll: "FB",
  Football: "FB",
  Ishockey: "IH",
  "Ice Hockey": "IH",
  Tennis: "TN",
  Basket: "BK",
  Basketball: "BK",
  "American Football": "AF",
  Baseball: "BB",
  MMA: "MMA",
  Boxing: "BX",
  Esports: "ES",
  "Horse Racing": "HR",
  Golf: "GO",
  Cricket: "CR",
  Övrigt: "ÖV",
  Other: "ÖV",
};
export function sportTag(sport: string | null | undefined): string {
  if (!sport) return "—";
  return SPORT_TAGS[sport] || sport.slice(0, 2).toUpperCase();
}

// Short date like "30 maj" from an ISO string / Date.
const MONTHS_SV = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
export function dateShort(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getDate()} ${MONTHS_SV[date.getMonth()]}`;
}
