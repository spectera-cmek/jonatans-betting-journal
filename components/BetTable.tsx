"use client";

import { useMemo, useState } from "react";
import type { BetDTO } from "@/lib/types";
import { STATUS_PILL, OUTCOMES } from "@/lib/constants";
import { fmtDate, fmtOdds, fmtStake, fmtUnits, fmtPct, signClass } from "@/lib/format";
import { SettleButtons } from "./SettleButtons";
import { api } from "@/lib/fetcher";

type Filter = "all" | "pending" | "settled";

export function BetTable({
  bets,
  onChanged,
}: {
  bets: BetDTO[];
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sportFilter, setSportFilter] = useState<string>("all");
  const [q, setQ] = useState("");

  const sports = useMemo(
    () => Array.from(new Set(bets.map((b) => b.sport).filter(Boolean))) as string[],
    [bets]
  );

  const filtered = useMemo(() => {
    return bets.filter((b) => {
      if (filter === "pending" && b.outcome !== "pending") return false;
      if (filter === "settled" && b.outcome === "pending") return false;
      if (sportFilter !== "all" && b.sport !== sportFilter) return false;
      if (q) {
        const hay = `${b.event} ${b.selection} ${b.league ?? ""} ${b.bookmaker ?? ""}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [bets, filter, sportFilter, q]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-card p-0.5">
          {(["all", "pending", "settled"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                filter === f ? "bg-band text-text-hi" : "text-text-mid hover:text-text-hi"
              }`}
            >
              {f === "all" ? "Alla" : f === "pending" ? "Öppna" : "Avgjorda"}
            </button>
          ))}
        </div>

        <select
          value={sportFilter}
          onChange={(e) => setSportFilter(e.target.value)}
          className="rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-text-hi"
        >
          <option value="all">Alla sporter</option>
          {sports.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Sök event, val, bookmaker…"
          className="flex-1 min-w-[180px] rounded-lg border border-line bg-card px-3 py-1.5 text-xs text-text-hi outline-none focus:border-accent-blue"
        />

        <span className="tnum text-xs text-text-lo">{filtered.length} bets</span>
      </div>

      {/* Desktop / tablet: full table (horizontal scroll if needed) */}
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-hero lg:block">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-hero text-[10px] font-semibold uppercase tracking-[0.12em] text-pos/55">
              <Th>Placed</Th>
              <Th center>Sport</Th>
              <Th left>Event</Th>
              <Th left>Selection</Th>
              <Th left>Market</Th>
              <Th right>Line</Th>
              <Th right>Odds</Th>
              <Th right>Stake</Th>
              <Th center>Book</Th>
              <Th center>Source</Th>
              <Th center>Status</Th>
              <Th right>P/L</Th>
              <Th right>CLV</Th>
              <Th center> </Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => (
              <BetRow key={b.id} bet={b} onChanged={onChanged} />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-sm text-text-lo">
                  Inga bets matchar filtret.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per bet, tap-friendly actions always visible */}
      <div className="flex flex-col gap-2.5 lg:hidden">
        {filtered.map((b) => (
          <BetCard key={b.id} bet={b} onChanged={onChanged} />
        ))}
        {filtered.length === 0 && (
          <div className="rounded-xl border border-line bg-hero px-4 py-12 text-center text-sm text-text-lo">
            Inga bets matchar filtret.
          </div>
        )}
      </div>
    </div>
  );
}

function BetCard({ bet, onChanged }: { bet: BetDTO; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const pill = STATUS_PILL[bet.outcome] ?? STATUS_PILL.pending;

  const del = async () => {
    if (!confirm(`Ta bort betet "${bet.event}"?`)) return;
    await api.del(`/api/bets/${bet.id}`);
    onChanged();
  };

  const changeOutcome = async (outcome: string) => {
    await api.post(`/api/bets/${bet.id}/settle`, { outcome });
    setEditing(false);
    onChanged();
  };

  return (
    <div className="rounded-xl border border-line bg-hero p-3.5 text-text-hi">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="tnum text-xs text-text-mid">{fmtDate(bet.eventAt ?? bet.placedAt)}</span>
        {editing ? (
          <select
            autoFocus
            defaultValue={bet.outcome}
            onChange={(e) => changeOutcome(e.target.value)}
            onBlur={() => setEditing(false)}
            className="rounded-md border border-line bg-card px-2 py-1 text-xs text-text-hi"
          >
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className={`inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${pill.ring} ${pill.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
            {pill.label}
          </button>
        )}
      </div>

      <div className="font-medium leading-tight">{bet.event}</div>
      {bet.league && <div className="text-[11px] text-text-lo">{bet.league}</div>}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="font-semibold">{bet.selection || "—"}</span>
        <span className="rounded bg-band px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-mid">
          {marketLabel(bet.market)}
        </span>
        {bet.sport && (
          <span className="rounded bg-band px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-mid ring-1 ring-line">
            {bet.sport}
          </span>
        )}
      </div>

      <div className="mt-2.5 grid grid-cols-4 gap-2 border-t border-line-subtle/60 pt-2.5 text-center">
        <CardStat label="Odds" value={fmtOdds(bet.odds)} />
        <CardStat label="Insats" value={fmtStake(bet.stakeUnits)} />
        <CardStat
          label="P/L"
          value={bet.outcome === "pending" ? "—" : fmtUnits(bet.profitUnits, false)}
          cls={bet.outcome === "pending" ? "text-text-lo" : signClass(bet.profitUnits)}
        />
        <CardStat
          label="CLV"
          value={bet.clvPct == null ? "—" : fmtPct(bet.clvPct, false)}
          cls={bet.clvPct == null ? "text-text-lo" : signClass(bet.clvPct)}
        />
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5">
        {bet.outcome === "pending" && <SettleButtons betId={bet.id} onDone={onChanged} />}
        <button
          onClick={del}
          className="rounded-md px-2.5 py-1 text-xs text-text-lo ring-1 ring-line hover:bg-neg/20 hover:text-neg"
        >
          Ta bort
        </button>
      </div>
    </div>
  );
}

function CardStat({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-text-lo">{label}</div>
      <div className={`tnum text-sm font-semibold ${cls ?? "text-text-hi"}`}>{value}</div>
    </div>
  );
}

function BetRow({ bet, onChanged }: { bet: BetDTO; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const pill = STATUS_PILL[bet.outcome] ?? STATUS_PILL.pending;

  const del = async () => {
    if (!confirm(`Ta bort betet "${bet.event}"?`)) return;
    await api.del(`/api/bets/${bet.id}`);
    onChanged();
  };

  const changeOutcome = async (outcome: string) => {
    await api.post(`/api/bets/${bet.id}/settle`, { outcome });
    setEditing(false);
    onChanged();
  };

  const source = bet.externalRef ? "API" : "MANUAL";

  return (
    <tr className="group border-b border-line-subtle/60 text-text-hi transition-colors last:border-0 hover:bg-band/50">
      {/* PLACED */}
      <td className="tnum whitespace-nowrap px-4 py-3 text-left text-xs text-text-mid">
        {fmtDate(bet.eventAt ?? bet.placedAt)}
      </td>

      {/* SPORT */}
      <td className="px-3 py-3 text-center">
        {bet.sport ? (
          <span className="rounded-md bg-band px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-mid ring-1 ring-line">
            {bet.sport}
          </span>
        ) : (
          <span className="text-text-lo">—</span>
        )}
      </td>

      {/* EVENT */}
      <td className="px-3 py-3 text-left">
        <div className="font-medium text-text-hi">{bet.event}</div>
        {bet.league && <div className="text-[11px] text-text-lo">{bet.league}</div>}
      </td>

      {/* SELECTION */}
      <td className="px-3 py-3 text-left font-semibold text-text-hi">
        {bet.selection || "—"}
      </td>

      {/* MARKET */}
      <td className="px-3 py-3 text-left text-xs uppercase tracking-wide text-text-mid">
        {marketLabel(bet.market)}
      </td>

      {/* LINE */}
      <td className="tnum px-3 py-3 text-right text-text-mid">
        {bet.line == null ? "—" : bet.line}
      </td>

      {/* ODDS */}
      <td className="tnum px-3 py-3 text-right font-semibold text-text-hi">
        {fmtOdds(bet.odds)}
      </td>

      {/* STAKE */}
      <td className="tnum px-3 py-3 text-right text-text-mid">{fmtStake(bet.stakeUnits)}</td>

      {/* BOOK */}
      <td className="px-3 py-3">
        <div className="flex justify-center">
          <BookChip name={bet.bookmaker} />
        </div>
      </td>

      {/* SOURCE */}
      <td className="px-3 py-3 text-center">
        <span
          className={`text-[10px] font-bold uppercase tracking-wider ${
            source === "API" ? "text-pos/80" : "text-text-lo"
          }`}
        >
          {source}
        </span>
      </td>

      {/* STATUS */}
      <td className="px-3 py-3 text-center">
        {editing ? (
          <select
            autoFocus
            defaultValue={bet.outcome}
            onChange={(e) => changeOutcome(e.target.value)}
            onBlur={() => setEditing(false)}
            className="rounded-md border border-line bg-card px-2 py-1 text-xs text-text-hi"
          >
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Klicka för att ändra"
            className={`inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${pill.ring} ${pill.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
            {pill.label}
          </button>
        )}
      </td>

      {/* P/L */}
      <td className={`tnum px-3 py-3 text-right font-bold ${signClass(bet.profitUnits)}`}>
        {bet.outcome === "pending" ? <span className="text-text-lo">—</span> : fmtUnits(bet.profitUnits, false)}
      </td>

      {/* CLV */}
      <td className={`tnum px-3 py-3 text-right ${signClass(bet.clvPct)}`}>
        {bet.clvPct == null ? <span className="text-text-lo">—</span> : fmtPct(bet.clvPct, false)}
      </td>

      {/* ACTIONS */}
      <td className="px-3 py-3">
        <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          {bet.outcome === "pending" && <SettleButtons betId={bet.id} onDone={onChanged} />}
          <button
            onClick={del}
            title="Ta bort"
            className="h-7 w-7 rounded-md text-text-lo hover:bg-neg/20 hover:text-neg"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}

function BookChip({ name }: { name: string | null }) {
  if (!name) return <span className="text-text-lo">—</span>;
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={name}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent-blue/30 to-accent-purple/20 text-[11px] font-bold text-text-hi ring-1 ring-line">
        {initial}
      </span>
    </span>
  );
}

function marketLabel(market: string): string {
  switch (market) {
    case "h2h":
      return "H2H / ML";
    case "totals":
      return "Totals";
    case "spreads":
      return "Spread";
    default:
      return market || "Other";
  }
}

function Th({
  children,
  left,
  right,
  center,
}: {
  children: React.ReactNode;
  left?: boolean;
  right?: boolean;
  center?: boolean;
}) {
  const align = left ? "text-left" : right ? "text-right" : center ? "text-center" : "text-left";
  return <th className={`px-3 py-3 font-semibold ${align}`}>{children}</th>;
}
