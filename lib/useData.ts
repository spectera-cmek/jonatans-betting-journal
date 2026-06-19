"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./fetcher";
import type { Metrics, BankrollPoint, Breakdown, OpenRisk, DrawdownInfo } from "./betting";
import type { Insights } from "./insights";
import type { TiltStatus } from "./tilt";
import type { WeeklyReport } from "./weekly";
import type { BetListDTO, SettingsDTO } from "./types";

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
  bookmaker: string | null;
  eventAt: string;
  odds: number;
  stakeUnits: number;
  profitUnits: number;
  roiPct: number | null;
}

export interface MetricsResponse {
  username: string;
  metrics: Metrics;
  insights: Insights;
  openRisk: OpenRisk;
  drawdown: DrawdownInfo;
  tilt: TiltStatus;
  weekly: WeeklyReport;
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

function useCachedGet<T>(url: string) {
  const [data, setData] = useState<T | null>(() => (cache.get(url) as T) ?? null);
  const [loading, setLoading] = useState(!cache.has(url));

  const load = useCallback(async () => {
    if (!cache.has(url)) setLoading(true);
    try {
      const d = await api.get<T>(url);
      cache.set(url, d);
      setData(d);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, reload: load };
}

export function useMetrics() {
  const m = useCachedGet<MetricsResponse>("/api/metrics");
  const s = useCachedGet<SettingsDTO>("/api/settings");
  const reload = useCallback(() => {
    m.reload();
    s.reload();
  }, [m.reload, s.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: m.data, settings: s.data, loading: m.loading || s.loading, reload };
}

export function useBets() {
  const b = useCachedGet<BetListDTO[]>("/api/bets?fields=list");
  const s = useCachedGet<SettingsDTO>("/api/settings");
  const reload = useCallback(() => {
    b.reload();
    s.reload();
  }, [b.reload, s.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return { bets: b.data ?? [], settings: s.data, loading: b.loading || s.loading, reload };
}
