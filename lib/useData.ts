"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./fetcher";
import type { Metrics, BankrollPoint, Breakdown, OpenRisk, DrawdownInfo } from "./betting";
import type { Insights } from "./insights";
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
  openRisk: OpenRisk;
  drawdown: DrawdownInfo;
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
  oddsBands: { label: string; bets: number; profitUnits: number; roiPct: number | null; winRatePct: number | null }[];
  hallOfFame: LeaderboardEntry[];
  biggestL: LeaderboardEntry[];
  settings: { unitValue: number; currency: string; startingBankrollUnits: number };
}

// Stale-while-revalidate: last good response per URL, shared across pages for
// the lifetime of the tab. A page mount renders the cached data instantly and
// refreshes it in the background, so navigation never shows a spinner twice.
const cache = new Map<string, unknown>();

// Every mounted hook registers its reloader here so a global action (the top-nav
// "Logga bet" / "Synka", which live outside any data page) can refresh whatever
// the current page is showing.
const reloaders = new Set<() => void>();

/** Re-fetch every cached endpoint that a mounted hook is currently reading. */
export function revalidateAll() {
  reloaders.forEach((fn) => fn());
}

function useCachedGet<T>(url: string) {
  const [data, setData] = useState<T | null>(() => (cache.get(url) as T) ?? null);
  const [loading, setLoading] = useState(!cache.has(url));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cache.has(url)) setLoading(true);
    try {
      const d = await api.get<T>(url);
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
