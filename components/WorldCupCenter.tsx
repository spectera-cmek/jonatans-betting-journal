"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "./Shell";
import { AddBetModal, type BetPrefill } from "./AddBetModal";
import { SettlementDialog } from "./SettlementDialog";
import { BetTags } from "./BetTags";
import { Card, Empty, SkeletonCard } from "./ui";
import { StatTile, BreakdownCard } from "./stats";
import { InteractiveLineChart } from "./charts";
import { ResultBadgeKr } from "./ResultBadge";
import { I, IC } from "./icons";
import { useBets, useWorldCup } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import {
  bankrollSeries,
  breakdownBy,
  computeMetrics,
  openRisk,
} from "@/lib/betting";
import {
  dateShort,
  krFmt,
  krShort,
  pctFmt,
  uFmt,
} from "@/lib/format";
import {
  findWorldCupMatchesForBet,
  type WorldCupGroup,
  type WorldCupMatch,
} from "@/lib/worldCup";
import {
  TOURNAMENT_STAGE_LABELS,
  TOURNAMENT_STAGES,
  VM_2026_LEAGUE,
  type TournamentStage,
} from "@/lib/betTaxonomy";
import type { BetListDTO } from "@/lib/types";
import type { GradingSuggestion } from "@/lib/gradingQueue";

type Tab = "overview" | "matches" | "groups" | "bracket" | "bets";

const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Översikt" },
  { value: "matches", label: "Matcher" },
  { value: "groups", label: "Grupper" },
  { value: "bracket", label: "Slutspel" },
  { value: "bets", label: "Mina bets" },
];

function Team({
  team,
  score,
}: {
  team: WorldCupMatch["home"];
  score: number | null;
}) {
  return (
    <div className="ap-wc-team">
      {team.logo ? <img src={team.logo} alt="" width={24} height={24} /> : <span />}
      <span>{team.name}</span>
      <b className="ap-num">{score ?? "–"}</b>
    </div>
  );
}

function MatchCard({
  match,
  bets,
  unit,
  onAdd,
  onSettle,
  compact = false,
}: {
  match: WorldCupMatch;
  bets: BetListDTO[];
  unit: number;
  onAdd: (match: WorldCupMatch) => void;
  onSettle: (bet: BetListDTO) => void;
  compact?: boolean;
}) {
  return (
    <div className={`ap-wc-match${compact ? " is-compact" : ""}`}>
      <div className="ap-wc-match-head">
        <span>{dateShort(match.startsAt)} · {new Date(match.startsAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}</span>
        <span className={`ap-wc-status is-${match.status}`}>{match.statusText}</span>
      </div>
      <div className="ap-wc-match-stage">
        {match.group ?? match.stageLabel}{match.venue ? ` · ${match.venue}` : ""}
      </div>
      <Team team={match.home} score={match.homeScore} />
      <Team team={match.away} score={match.awayScore} />
      {match.wentToExtraTime && (
        <div className="ap-wc-warning">Förlängning/straffar — 90-minutersspel granskas manuellt.</div>
      )}
      {bets.length > 0 && (
        <div className="ap-wc-linked-bets">
          {bets.map((bet) => (
            <div key={bet.id}>
              <span>
                <b>{bet.selection}</b>
                <small>{bet.bookmaker ?? "Bookmaker saknas"} · {bet.odds.toFixed(2)}</small>
              </span>
              <span>
                <ResultBadgeKr
                  outcome={bet.outcome}
                  profitKr={(bet.profitUnits ?? 0) * unit}
                />
                {bet.outcome === "pending" && (
                  <button className="ap-link" onClick={() => onSettle(bet)}>Rätta</button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {!compact && (
        <div className="ap-wc-match-actions">
          <span>{bets.length ? `${bets.length} kopplade bets` : "Inga kopplade bets"}</span>
          <button className="ap-btn ghost" onClick={() => onAdd(match)}>
            <I p={IC.plus} size={14} /> Logga bet
          </button>
        </div>
      )}
      {compact && (
        <div className="ap-wc-match-actions is-compact">
          <span>{bets.length ? `${bets.length} kopplade bets` : "Inga kopplade bets"}</span>
        </div>
      )}
    </div>
  );
}

function GroupsView({ groups }: { groups: WorldCupGroup[] }) {
  if (!groups.length) {
    return (
      <Card>
        <Empty title="Gruppställningen är inte tillgänglig" hint="Matcherna och dina bets fungerar fortfarande." />
      </Card>
    );
  }
  return (
    <div className="ap-wc-groups">
      {groups.map((group) => (
        <Card key={group.id} style={{ padding: 0 }}>
          <div className="ap-card-head"><span className="ap-card-title">{group.name}</span></div>
          <div className="ap-wc-table">
            <div><span>#</span><span>Lag</span><span>MS</span><span>V</span><span>O</span><span>F</span><span>+/-</span><b>P</b></div>
            {group.standings.map((row) => (
              <div key={row.team.id || row.team.name}>
                <span>{row.position}</span>
                <span className="ap-wc-table-team">
                  {row.team.logo && <img src={row.team.logo} alt="" width={20} height={20} />}
                  {row.team.name}
                </span>
                <span>{row.played}</span><span>{row.wins}</span><span>{row.draws}</span>
                <span>{row.losses}</span><span>{row.goalDifference}</span><b>{row.points}</b>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function BracketView({
  matches,
  byMatch,
  unit,
  onAdd,
  onSettle,
}: {
  matches: WorldCupMatch[];
  byMatch: Map<string, BetListDTO[]>;
  unit: number;
  onAdd: (match: WorldCupMatch) => void;
  onSettle: (bet: BetListDTO) => void;
}) {
  const stages = TOURNAMENT_STAGES.filter((stage) => stage !== "group");
  return (
    <div className="ap-wc-bracket">
      {stages.map((stage) => {
        const round = matches.filter((match) => match.stage === stage);
        if (!round.length) return null;
        return (
          <section key={stage}>
            <h3>{TOURNAMENT_STAGE_LABELS[stage]}</h3>
            {round.map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                bets={byMatch.get(match.id) ?? []}
                unit={unit}
                onAdd={onAdd}
                onSettle={onSettle}
                compact
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function GradingQueue({
  suggestions,
  loading,
  onApply,
  onManual,
}: {
  suggestions: GradingSuggestion[];
  loading: boolean;
  onApply: (ids: string[]) => void;
  onManual: (id: string) => void;
}) {
  const ready = suggestions.filter((item) => item.readiness === "ready");
  const attention = suggestions.filter((item) => item.readiness === "manual" || item.readiness === "unmatched");
  return (
    <Card style={{ padding: 0 }}>
      <div className="ap-card-head">
        <span className="ap-card-title">Rättningskö</span>
        {ready.length > 0 && (
          <button className="ap-btn" onClick={() => onApply(ready.map((item) => item.betId))}>
            Rätta {ready.length} säkra
          </button>
        )}
      </div>
      {loading ? (
        <div className="ap-wc-panel-empty">Kontrollerar resultat…</div>
      ) : suggestions.length === 0 ? (
        <div className="ap-wc-panel-empty">Inga öppna VM-bets.</div>
      ) : (
        <div className="ap-wc-queue">
          {suggestions.slice(0, 8).map((item) => (
            <div key={item.betId}>
              <span className={`ap-wc-queue-dot is-${item.readiness}`} />
              <span>
                <b>{item.event}</b>
                <small>{item.selection} · {item.reason}</small>
              </span>
              {item.readiness === "ready" ? (
                <button className="ap-link" onClick={() => onApply([item.betId])}>
                  {item.suggestedOutcome}
                </button>
              ) : attention.some((candidate) => candidate.betId === item.betId) ? (
                <button className="ap-link" onClick={() => onManual(item.betId)}>Granska</button>
              ) : (
                <span style={{ color: "var(--dim2)", fontSize: 11.5 }}>Väntar</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function BetsAnalytics({ bets, unit }: { bets: BetListDTO[]; unit: number }) {
  const metrics = useMemo(() => computeMetrics(bets), [bets]);
  const points = useMemo(
    () => bankrollSeries(bets, 0).map((point) => ({ t: Date.parse(point.date), v: point.profitUnits * unit })),
    [bets, unit]
  );
  const byMarket = useMemo(
    () => breakdownBy(bets, (bet) => (bet as BetListDTO).marketCategory, "Okänd"),
    [bets]
  );
  const byScope = useMemo(
    () => breakdownBy(bets, (bet) => (bet as BetListDTO).marketScope, "Okänd"),
    [bets]
  );
  const byBook = useMemo(
    () => breakdownBy(bets, (bet) => (bet as BetListDTO).bookmaker, "Okänd"),
    [bets]
  );

  if (!bets.length) {
    return (
      <Card>
        <Empty title="Inga VM-bets ännu" hint="Logga ett bet direkt från en match eller tagga ett befintligt bet som VM 2026." />
      </Card>
    );
  }
  return (
    <>
      <div className="ap-kpi-row">
        <StatTile label="P/L" value={krFmt(metrics.profitUnits * unit, true)} sub={uFmt(metrics.profitUnits, true)} tone={metrics.profitUnits >= 0 ? "pos" : "neg"} />
        <StatTile label="ROI" value={pctFmt(metrics.roiPct, true)} sub={`${metrics.settledBets} avgjorda`} tone={(metrics.roiPct ?? 0) >= 0 ? "pos" : "neg"} />
        <StatTile label="Win rate" value={pctFmt(metrics.winRatePct)} sub={`${metrics.wins}V · ${metrics.losses}F`} />
        <StatTile label="Omsättning" value={krShort(metrics.stakedUnits * unit)} sub={`${metrics.totalBets} bets`} />
      </div>
      <Card style={{ marginBottom: 12 }}>
        <span className="ap-label">Ackumulerad P/L under VM</span>
        <div style={{ marginTop: 14 }}>
          <InteractiveLineChart points={points} w={780} h={210} stroke="var(--acc)" fill="var(--acc-soft)" grid="var(--line)" formatValue={(value) => krFmt(value, true)} />
        </div>
      </Card>
      <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        <BreakdownCard title="Marknad" rows={byMarket} unit={unit} />
        <BreakdownCard title="Scope" rows={byScope} unit={unit} />
        <BreakdownCard title="Bookmaker" rows={byBook} unit={unit} />
      </div>
    </>
  );
}

export function WorldCupCenter() {
  const { bets, settings, loading: betsLoading, reload: reloadBets } = useBets({ league: VM_2026_LEAGUE });
  const { data, loading: cupLoading, error: cupError, reload: reloadCup } = useWorldCup();
  const [tab, setTab] = useState<Tab>("overview");
  const [stage, setStage] = useState<TournamentStage | "all">("all");
  const [prefill, setPrefill] = useState<BetPrefill | null>(null);
  const [settling, setSettling] = useState<BetListDTO | null>(null);
  const [suggestions, setSuggestions] = useState<GradingSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const unit = settings?.unitValue ?? 100;

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const rows = await api.get<GradingSuggestion[]>(
        `/api/settlements/suggestions?league=${encodeURIComponent(VM_2026_LEAGUE)}`
      );
      setSuggestions(rows);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSuggestions().catch(() => setSuggestions([]));
  }, [loadSuggestions, bets.length]);

  const matches = data?.matches ?? [];
  const byMatch = useMemo(() => {
    const map = new Map<string, BetListDTO[]>();
    for (const bet of bets) {
      for (const match of findWorldCupMatchesForBet(bet, matches)) {
        const group = map.get(match.id) ?? [];
        group.push(bet);
        map.set(match.id, group);
      }
    }
    return map;
  }, [bets, matches]);

  const metrics = useMemo(() => computeMetrics(bets), [bets]);
  const risk = useMemo(() => openRisk(bets), [bets]);
  const upcoming = matches.filter((match) => match.status !== "final").slice(0, 4);
  const filteredMatches = stage === "all" ? matches : matches.filter((match) => match.stage === stage);

  const addForMatch = (match: WorldCupMatch) => {
    setPrefill({
      form: {
        eventAt: match.startsAt.slice(0, 10),
        sport: "Football",
        league: VM_2026_LEAGUE,
        event: `${match.home.name} vs ${match.away.name}`,
        homeTeam: match.home.name,
        awayTeam: match.away.name,
        market: "h2h",
        marketCategory: "Matchvinnare",
        marketScope: "match",
        eventKind: "match",
        tournamentStage: match.stage ?? "",
        selection: match.home.name,
        selectionSide: "home",
        resultProvider: "espn",
        resultEventRef: match.id,
      },
    });
  };

  const applySuggestions = async (ids: string[]) => {
    if (!confirm(`Rätta ${ids.length} bet${ids.length === 1 ? "" : "s"} från de visade ESPN-resultaten?`)) return;
    await api.post("/api/settlements/suggestions", { ids });
    await reloadBets();
    await loadSuggestions();
  };

  const openManual = (id: string) => {
    const bet = bets.find((candidate) => candidate.id === id);
    if (bet) setSettling(bet);
  };

  const loading = betsLoading || cupLoading;
  return (
    <div className="ap-wc">
      <Topbar
        title="VM 2026"
        sub={`${matches.length || 104} matcher · ${bets.length} bets · ${data?.currentStage ? TOURNAMENT_STAGE_LABELS[data.currentStage] : "Fotbolls-VM"}`}
        icon={<I p={IC.trophy} />}
        actions={
          <>
            <button className="ap-btn ghost" onClick={() => { reloadCup(); loadSuggestions(); }}>
              <I p={IC.refresh} size={14} /> Uppdatera
            </button>
            <Link className="ap-btn ghost" href={`/bets?league=${encodeURIComponent(VM_2026_LEAGUE)}`}>Alla VM-bets</Link>
          </>
        }
      />

      {(data?.stale || cupError) && (
        <div className="ap-wc-banner">
          ESPN kunde inte uppdateras just nu. Visar {data?.matches.length ? "senast hämtade turneringsdata" : "dina sparade bets"}.
        </div>
      )}

      <div className="ap-wc-tabs">
        {TABS.map((item) => (
          <button key={item.value} className={tab === item.value ? "is-active" : ""} onClick={() => setTab(item.value)}>
            {item.label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="ap-grid ap-three"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
      ) : tab === "overview" ? (
        <>
          <div className="ap-kpi-row">
            <StatTile label="VM P/L" value={krFmt(metrics.profitUnits * unit, true)} sub={uFmt(metrics.profitUnits, true)} tone={metrics.profitUnits >= 0 ? "pos" : "neg"} />
            <StatTile label="Öppna bets" value={String(metrics.pendingBets)} sub={`${krShort(risk.stakeUnits * unit)} i risk`} />
            <StatTile label="Säkra rättningsförslag" value={String(suggestions.filter((item) => item.readiness === "ready").length)} sub="kontrollerade mot ESPN" />
            <StatTile label="Aktuell fas" value={data?.currentStage ? TOURNAMENT_STAGE_LABELS[data.currentStage] : "—"} sub="11 juni – 19 juli" />
          </div>
          <div className="ap-grid ap-two" style={{ gridTemplateColumns: "1.2fr .8fr" }}>
            <Card style={{ padding: 0 }}>
              <div className="ap-card-head"><span className="ap-card-title">Nästa matcher</span><button className="ap-link" onClick={() => setTab("matches")}>Hela schemat →</button></div>
              <div className="ap-wc-match-list">
                {upcoming.map((match) => (
                  <MatchCard key={match.id} match={match} bets={byMatch.get(match.id) ?? []} unit={unit} onAdd={addForMatch} onSettle={setSettling} />
                ))}
                {!upcoming.length && <div className="ap-wc-panel-empty">Turneringen är färdigspelad.</div>}
              </div>
            </Card>
            <GradingQueue suggestions={suggestions} loading={suggestionsLoading} onApply={applySuggestions} onManual={openManual} />
          </div>
        </>
      ) : tab === "matches" ? (
        <>
          <div className="ap-wc-stage-filter">
            <button className={stage === "all" ? "is-active" : ""} onClick={() => setStage("all")}>Alla</button>
            {TOURNAMENT_STAGES.map((value) => (
              <button key={value} className={stage === value ? "is-active" : ""} onClick={() => setStage(value)}>
                {TOURNAMENT_STAGE_LABELS[value]}
              </button>
            ))}
          </div>
          <div className="ap-wc-matches">
            {filteredMatches.map((match) => (
              <MatchCard key={match.id} match={match} bets={byMatch.get(match.id) ?? []} unit={unit} onAdd={addForMatch} onSettle={setSettling} />
            ))}
          </div>
        </>
      ) : tab === "groups" ? (
        <GroupsView groups={data?.groups ?? []} />
      ) : tab === "bracket" ? (
        <BracketView matches={matches} byMatch={byMatch} unit={unit} onAdd={addForMatch} onSettle={setSettling} />
      ) : (
        <>
          <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <BetTags bet={{ sport: "Football", league: VM_2026_LEAGUE }} />
            <Link href={`/bets?league=${encodeURIComponent(VM_2026_LEAGUE)}`} className="ap-link">Öppna filtrerad betlista →</Link>
          </div>
          <BetsAnalytics bets={bets} unit={unit} />
        </>
      )}

      <AddBetModal
        open={!!prefill}
        prefill={prefill}
        onClose={() => setPrefill(null)}
        onSaved={() => { reloadBets(); loadSuggestions(); }}
        hasOddsApiKey={settings?.hasOddsApiKey ?? false}
      />
      <SettlementDialog
        bet={settling}
        onClose={() => setSettling(null)}
        onChanged={() => { reloadBets(); loadSuggestions(); }}
      />
    </div>
  );
}
