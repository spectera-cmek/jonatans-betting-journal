"use client";

// Rättning — the whole open queue in one place. The suggestion engine
// (lib/gradingQueue) has always been able to grade any league from ESPN's
// scoreboards; until now only the VM 2026 page ever asked it. Everything here
// is a view over /api/settlements/suggestions.

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Topbar } from "@/components/Shell";
import { Card, Empty } from "@/components/ui";
import { StatTile } from "@/components/stats";
import {
  GradingRow,
  READINESS_HINTS,
  READINESS_LABELS,
  READINESS_ORDER,
  countByReadiness,
} from "@/components/GradingQueue";
import { I, IC } from "@/components/icons";
import { api } from "@/lib/fetcher";
import { revalidateAll, useSettings } from "@/lib/useData";
import { krFmt } from "@/lib/format";
import type { GradingReadiness, GradingSuggestion } from "@/lib/gradingQueue";
import type { SettleTarget } from "@/components/SettlementDialog";

const SettlementDialog = dynamic(
  () => import("@/components/SettlementDialog").then((m) => m.SettlementDialog),
  { ssr: false }
);

// The bulk endpoint caps each call at 100 ids.
const CHUNK = 100;

interface ApplyResult {
  settled: number;
  requested: number;
  details: string[];
}

export default function RattningPage() {
  const { data: settings } = useSettings();
  const unit = settings?.unitValue ?? 100;

  const [suggestions, setSuggestions] = useState<GradingSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<GradingReadiness | "alla">("alla");
  const [league, setLeague] = useState("");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [settling, setSettling] = useState<SettleTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSuggestions(await api.get<GradingSuggestion[]>("/api/settlements/suggestions?limit=300"));
    } catch (cause) {
      setError((cause as Error).message);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => countByReadiness(suggestions), [suggestions]);
  const leagues = useMemo(
    () =>
      Array.from(new Set(suggestions.map((s) => s.league).filter(Boolean) as string[])).sort((a, b) =>
        a.localeCompare(b, "sv")
      ),
    [suggestions]
  );

  const visible = useMemo(
    () =>
      suggestions.filter(
        (s) => (filter === "alla" || s.readiness === filter) && (!league || s.league === league)
      ),
    [suggestions, filter, league]
  );

  // Only ready rows can be bulk-applied, so the selection never leaves that set.
  const selectableIds = useMemo(
    () => visible.filter((s) => s.readiness === "ready").map((s) => s.betId),
    [visible]
  );
  const selectedVisible = selectableIds.filter((id) => selected.has(id));
  const stakeSelected = useMemo(
    () =>
      suggestions
        .filter((s) => selected.has(s.betId))
        .reduce((sum, s) => sum + s.stakeUnits, 0),
    [suggestions, selected]
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = selectableIds.every((id) => next.has(id));
      for (const id of selectableIds) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const apply = async (ids: string[]) => {
    if (!ids.length) return;
    const label = ids.length === 1 ? "detta spel" : `${ids.length} spel`;
    if (!confirm(`Rätta ${label} från hämtade ESPN-resultat?`)) return;
    setApplying(true);
    setResult(null);
    try {
      const total: ApplyResult = { settled: 0, requested: 0, details: [] };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const res = await api.post<ApplyResult>("/api/settlements/suggestions", {
          ids: ids.slice(i, i + CHUNK),
        });
        total.settled += res.settled;
        total.requested += res.requested;
        total.details.push(...res.details);
      }
      setResult(total);
      setSelected(new Set());
      // Dashboard, bets list and metrics all move when bets get settled.
      revalidateAll();
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const openManual = (id: string) => {
    const item = suggestions.find((s) => s.betId === id);
    if (item) {
      setSettling({ id: item.betId, event: item.event, selection: item.selection, outcome: "pending" });
    }
  };

  return (
    <div>
      <Topbar
        title="Rättning"
        sub={
          loading
            ? "Kontrollerar resultat…"
            : `${suggestions.length} öppna spel · ${counts.ready} klara att rätta`
        }
        icon={IC.zap}
        accent="sky"
        actions={
          <button className="ap-btn ghost" onClick={load} disabled={loading || applying}>
            <I p={IC.refresh} size={14} /> Uppdatera
          </button>
        }
      />

      <div className="ap-kpi-row">
        {READINESS_ORDER.map((key) => (
          <StatTile
            key={key}
            label={READINESS_LABELS[key]}
            value={String(counts[key])}
            sub={key === "ready" ? "kontrollerade mot ESPN" : undefined}
            hint={READINESS_HINTS[key]}
            tone={key === "ready" ? "pos" : undefined}
            icon={
              key === "ready"
                ? IC.checkCircle
                : key === "waiting"
                  ? IC.clock
                  : key === "manual"
                    ? IC.alert
                    : IC.helpCircle
            }
            accent={key === "waiting" ? "sky" : key === "manual" ? "amber" : undefined}
          />
        ))}
      </div>

      {error && (
        <Card style={{ marginBottom: 12, borderColor: "var(--red)" }}>
          <span className="neg" style={{ fontSize: 13 }}>{error}</span>
        </Card>
      )}

      {result && (
        <Card style={{ marginBottom: 12 }}>
          <span className="ap-label">Senaste rättning</span>
          <div style={{ fontSize: 13, marginTop: 10 }}>
            <b className="ap-num pos">{result.settled}</b> av {result.requested} spel rättades.
          </div>
          {result.details.length > 0 && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--dim)", fontSize: 12, lineHeight: 1.6 }}>
              {result.details.slice(0, 12).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card style={{ padding: 0 }}>
        <div className="ap-card-head">
          <span className="ap-card-title">
            <span className="ap-chip-icon is-sm is-sky" aria-hidden="true">
              <I p={IC.ticket} size={13} />
            </span>
            Kön
            <span className="ap-count-badge">{visible.length}</span>
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {leagues.length > 1 && (
              <div className="ap-select" style={{ minWidth: 150 }}>
                <select value={league} onChange={(e) => setLeague(e.target.value)}>
                  <option value="">Alla ligor</option>
                  {leagues.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="ap-seg">
              <button className={filter === "alla" ? "is-active" : ""} onClick={() => setFilter("alla")}>
                Alla
              </button>
              {READINESS_ORDER.map((key) => (
                <button
                  key={key}
                  className={filter === key ? "is-active" : ""}
                  onClick={() => setFilter(key)}
                >
                  {READINESS_LABELS[key]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {selectableIds.length > 0 && (
          <div className="ap-queue-bar">
            <button className="ap-btn ghost" onClick={toggleAll}>
              {selectableIds.every((id) => selected.has(id)) ? "Avmarkera alla" : `Markera alla klara (${selectableIds.length})`}
            </button>
            <span style={{ color: "var(--dim)", fontSize: 12.5 }}>
              {selectedVisible.length > 0
                ? `${selectedVisible.length} valda · ${krFmt(stakeSelected * unit)} i insats`
                : "Kryssa i de spel du vill rätta"}
            </span>
            <button
              className="ap-btn"
              disabled={applying || selectedVisible.length === 0}
              onClick={() => apply(selectedVisible)}
            >
              <I p={IC.zap} size={14} />
              {applying ? "Rättar…" : `Rätta valda (${selectedVisible.length})`}
            </button>
          </div>
        )}

        {loading ? (
          <div className="ap-panel-empty">Kontrollerar resultat mot ESPN…</div>
        ) : visible.length === 0 ? (
          <Empty
            icon={IC.checkCircle}
            title={suggestions.length === 0 ? "Inga öppna spel" : "Inget i den här vyn"}
            hint={
              suggestions.length === 0
                ? "Allt är avgjort. Kön fylls på när du loggar nya spel."
                : "Byt filter eller liga för att se resten av kön."
            }
          />
        ) : (
          <div className="ap-queue">
            {visible.map((item) => (
              <GradingRow
                key={item.betId}
                item={item}
                selected={selected.has(item.betId)}
                onToggle={toggle}
                onApply={apply}
                onManual={openManual}
                showStake
              />
            ))}
          </div>
        )}
      </Card>

      {settling && (
        <SettlementDialog
          bet={settling}
          onClose={() => setSettling(null)}
          onChanged={() => {
            revalidateAll();
            load();
          }}
        />
      )}
    </div>
  );
}
