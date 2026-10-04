// Delade bitar för /api/cs2/*: urvalsparametrar och svaret när databasen
// saknas (då svarar rutterna tomt med en flagga i stället för att Prisma kastar).

import { NextResponse } from "next/server";
import { DEFAULT_WINDOW, type SampleWindow } from "./profiles";

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = raw == null ? NaN : Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** ?maps=10&months=6 → docens SAMPLE SIZE. */
export function windowFrom(url: URL): SampleWindow {
  return {
    maps: clampInt(url.searchParams.get("maps"), DEFAULT_WINDOW.maps, 1, 100),
    months: clampInt(url.searchParams.get("months"), DEFAULT_WINDOW.months, 1, 24),
  };
}

export function idParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function noCs2Db() {
  return NextResponse.json({ dbConfigured: false });
}

export const CS2_NO_STORE = { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120" } };
