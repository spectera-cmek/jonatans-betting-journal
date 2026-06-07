"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./fetcher";
import type { Metrics, BankrollPoint, Breakdown } from "./betting";
import type { Insights } from "./insights";
import type { BetDTO, SettingsDTO } from "./types";

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
  metrics: Metrics;
  insights: Insights;
  bankroll: BankrollPoint[];
  bySport: Breakdown[];
  byLeague: Breakdown[];
  byMarket: Breakdown[];
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

export function useMetrics() {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, s] = await Promise.all([
        api.get<MetricsResponse>("/api/metrics"),
        api.get<SettingsDTO>("/api/settings"),
      ]);
      setData(m);
      setSettings(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { data, settings, loading, reload: load };
}

export function useBets() {
  const [bets, setBets] = useState<BetDTO[]>([]);
  const [settings, setSettings] = useState<SettingsDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, s] = await Promise.all([
        api.get<BetDTO[]>("/api/bets"),
        api.get<SettingsDTO>("/api/settings"),
      ]);
      setBets(b);
      setSettings(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { bets, settings, loading, reload: load };
}
