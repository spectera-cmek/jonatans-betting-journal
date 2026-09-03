"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./fetcher";
import type { Metrics, BankrollPoint, Breakdown, OpenRisk, DrawdownInfo } from "./betting";
import type { Insights } from "./insights";
import type { DisciplineRuleSet } from "./disciplineRules";
import type { TiltStatus } from "./tilt";
import type { WeeklyReport, MonthlyReport } from "./weekly";
import type { BetListDTO, SettingsDTO } from "./types";
import type { WorldCupData } from "./worldCup";

export interface MonthRow {
  month: string;
  bets: number;
  profitUnits: number;
  roiPct: number | null;
  stakedUnits: number;
  winRatePct?: number | null;
  // CLV per month — verified series first, then the unverified one, plus how
  // many bets that month carried any closing price at all (coverage).
  clvPct?: number | null;
  clvSampleSize?: number;
  clvUnverifiedPct?: number | null;
  clvUnverifiedSampleSize?: number;
  clvAnySampleSize?: number;
}

export interface LeaderboardEntry {
  id: string;
  event: string;
  selection: string;
  sport: string | null;
  league: string | null;
  marketCategory: string | null;
  marketScope: string | null;
  eventKind: string;
  tournamentStage: string | null;
  bookmaker: string | null;
  eventAt: string;
  odds: number;
  stakeUnits: number;
  profitUnits: number;
  roiPct: number | null;
}

/** One pending bet in the dashboard "Öppna spel" panel (soonest event first). */
export interface OpenBetRow {
  id: string;
  event: string;
  selection: string;
  sport: string | null;
  league: string | null;
  marketCategory?: string | null;
  marketScope?: string | null;
  eventKind?: string | null;
  tournamentStage?: string | null;
  bookmaker: string | null;
  betType: string;
  odds: number;
  stakeUnits: number;
  closingOdds: number | null;
  clvPct: number | null;
  eventAt: string | null;
  placedAt: string;
}

export interface MetricsResponse {
  username: string;
  metrics: Metrics;
  insights: Insights;
  disciplineRules: DisciplineRuleSet;
  openRisk: OpenRisk;
  drawdown: DrawdownInfo;
  /** Metrics per selectable period ("all" | "1y" | "90d" | "30d" | "7d"). */
  periodMetrics: Record<string, Metrics & { drawdown: DrawdownInfo }>;
  tilt: TiltStatus;
  weekly: WeeklyReport;
  monthlyReport: MonthlyReport;
  openBets: OpenBetRow[];
  bankroll: BankrollPoint[];
  bySport: Breakdown[];
  byLeague: Breakdown[];
  byMarket: Breakdown[];
  byMarketDetail: Breakdown[];
  byScope: Breakdown[];
  byBookmaker: Breakdown[];
  byYear: Breakdown[];
  byBetType: Breakdown[];
  byMonth: MonthRow[];
  monthly: MonthRow[];
  oddsBands: Breakdown[];
  hallOfFame: LeaderboardEntry[];
  biggestL: LeaderboardEntry[];
  settings: { unitValue: number; currency: string; startingBankrollUnits: number };
}

// Stale-while-revalidate: last good response per URL, shared across pages for
// the lifetime of the tab. A page mount renders the cached data instantly and
// refreshes it in the background, so navigation never shows a spinner twice.
const cache = new Map<string, unknown>();

// In-flight requests keyed by URL. Several components legitimately read the same
// endpoint on one screen: the nav's BankrollStrip and the page body both call
// useMetrics, and useMetrics/useBets each pull settings. Without this every hook
// instance fired its own round trip (the dashboard cost 2x /api/metrics and
// 3x /api/settings per load). Joiners now share one response.
const inflight = new Map<string, Promise<unknown>>();

function sharedGet<T>(url: string): Promise<T> {
  const pending = inflight.get(url) as Promise<T> | undefined;
  if (pending) return pending;
  const p: Promise<T> = api.get<T>(url).finally(() => {
    // Only clear our own entry — revalidateAll() may already have replaced it.
    if (inflight.get(url) === p) inflight.delete(url);
  });
  inflight.set(url, p);
  return p;
}

// Every mounted hook registers its reloader here so a global action (the top-nav
// "Logga bet" / "Synka", which live outside any data page) can refresh whatever
// the current page is showing.
const reloaders = new Set<() => void>();

/** Re-fetch every cached endpoint that a mounted hook is currently reading. */
export function revalidateAll() {
  // Drop anything in flight first so a refresh can never resolve to pre-save
  // data. The reloaders below run synchronously, so the first one re-creates the
  // request and the rest join it: one round trip per URL, not one per hook.
  inflight.clear();
  reloaders.forEach((fn) => fn());
}

function useCachedGet<T>(url: string) {
  const [data, setData] = useState<T | null>(() => (cache.get(url) as T) ?? null);
  const [loading, setLoading] = useState(!cache.has(url));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cache.has(url)) setLoading(true);
    try {
      const d = await sharedGet<T>(url);
      cache.set(url, d);
      setData(d);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
    reloaders.add(load);
    return () => {
      reloaders.delete(load);
    };
  }, [load]);

  return { data, loading, error, reload: load };
}

/** Settings on their own — shares the cache entry with useMetrics/useBets. */
export function useSettings() {
  return useCachedGet<SettingsDTO>("/api/settings");
}

/** The dashboard's "senaste spel" strip: newest N bets, list projection. */
export function useRecentBets(limit = 7) {
  return useCachedGet<BetListDTO[]>(`/api/bets?limit=${limit}&fields=list`);
}

export function useMetrics() {
  const m = useCachedGet<MetricsResponse>("/api/metrics");
  const s = useCachedGet<SettingsDTO>("/api/settings");
  const reload = useCallback(() => {
    m.reload();
    s.reload();
  }, [m.reload, s.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: m.data, settings: s.data, loading: m.loading || s.loading, error: m.error || s.error, reload };
}

export interface UseBetsOptions {
  league?: string;
  marketCategory?: string;
  marketScope?: string;
  eventKind?: string;
  tournamentStage?: string;
  outcome?: string;
  /** Calendar year of eventAt (falling back to placedAt) — filtered in SQL. */
  year?: string;
}

/** Filters the bets page mirrors into both the URL and the query string. */
export interface BetQuery {
  q?: string;
  sport?: string;
  league?: string;
  bookmaker?: string;
  marketCategory?: string;
  marketScope?: string;
  eventKind?: string;
  tournamentStage?: string;
  res?: string;
  day?: string;
  year?: string;
  month?: string;
  sort?: "asc" | "desc";
}

export interface BetFacets {
  sports: string[];
  leagues: string[];
  bookmakers: string[];
  marketCategories: string[];
  scopes: string[];
  years: string[];
}

export interface PagedBets {
  rows: BetListDTO[];
  total: number;
  metrics: Metrics;
  facets: BetFacets | null;
}

export function betQueryString(query: BetQuery, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ paged: "1" });
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

/**
 * One page of bets plus totals over the whole filtered set. Filtering, sorting
 * and paging all happen in the database — the page used to download every row
 * (5.8 MB on a 10k-bet journal) and do all three in the browser.
 */
export function usePagedBets(query: BetQuery, page: number, pageSize: number) {
  const qs = betQueryString(query, {
    page: String(page),
    pageSize: String(pageSize),
    facets: "1",
  });
  const b = useCachedGet<PagedBets>(`/api/bets?${qs}`);
  const s = useCachedGet<SettingsDTO>("/api/settings");
  const reload = useCallback(() => {
    b.reload();
    s.reload();
  }, [b.reload, s.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    rows: b.data?.rows ?? [],
    total: b.data?.total ?? 0,
    metrics: b.data?.metrics,
    facets: b.data?.facets ?? null,
    settings: s.data,
    loading: b.loading || s.loading,
    error: b.error || s.error,
    reload,
  };
}

export function useBets(options: UseBetsOptions = {}) {
  const params = new URLSearchParams({ fields: "list" });
  for (const [key, value] of Object.entries(options)) {
    if (value) params.set(key, value);
  }
  const b = useCachedGet<BetListDTO[]>(`/api/bets?${params.toString()}`);
  const s = useCachedGet<SettingsDTO>("/api/settings");
  const reload = useCallback(() => {
    b.reload();
    s.reload();
  }, [b.reload, s.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return { bets: b.data ?? [], settings: s.data, loading: b.loading || s.loading, error: b.error || s.error, reload };
}

export function useWorldCup() {
  return useCachedGet<WorldCupData>("/api/vm2026");
}
