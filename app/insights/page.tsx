"use client";

import { Topbar } from "@/components/Shell";
import { Card } from "@/components/ui";
import { HBar } from "@/components/charts";
import { useTheme } from "@/components/ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { uFmt, krShort, krFmt, pctFmt, dateShort } from "@/lib/format";

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function monthLabel(ym?: string): string {
  if (!ym) return "—";
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="ap-card">
      <span className="ap-label">{label}</span>
      <div className="ap-num ap-kpi-val"><span className={tone || ""}>{value}</span></div>
      {sub && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export default function InsightsPage() {
  const { cc } = useTheme();
  const { data, loading } = useMetrics();
  const unit = data?.settings.unitValue ?? 100;
  const ins = data?.insights;

  const streakValue = !ins || ins.streaks.currentType === "none"
    ? "—"
    : `${ins.streaks.current} ${ins.streaks.currentType === "win" ? "vinster" : "förluster"}`;
  const streakTone = ins?.streaks.currentType === "win" ? "pos" : ins?.streaks.currentType === "loss" ? "neg" : "";

  const mom = ins?.monthCurrent;
  const momPrev = ins?.monthPrevious;
  const momDelta = mom && momPrev ? mom.profitUnits - momPrev.profitUnits : null;

  const weekdays = ins?.byWeekday ?? [];
  const maxWd = Math.max(1, ...weekdays.map((w) => Math.abs(w.profitUnits)));

  return (
    <div>
      <Topbar title="Insikter" sub="Din form, dina rekord och dina mönster" />

      {loading && <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--dim2)" }}>Laddar…</div>}

      {!loading && (
        <>
          <div className="ap-kpi-row">
            <Tile label="Nuvarande svit" value={streakValue} tone={streakTone} sub={ins?.streaks.currentType === "none" ? "ingen data" : "i rad"} />
            <Tile label="Längsta vinstsvit" value={ins ? `${ins.streaks.longestWin}` : "—"} tone="pos" sub="i rad" />
            <Tile label="Längsta förlustsvit" value={ins ? `${ins.streaks.longestLoss}` : "—"} tone="neg" sub="i rad" />
            <Tile label="Snittinsats" value={ins?.avgStakeUnits != null ? `${ins.avgStakeUnits.toFixed(2)}U` : "—"} sub={ins?.avgStakeUnits != null ? krFmt(ins.avgStakeUnits * unit) : undefined} />
          </div>

          <div className="ap-grid ap-three" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 12 }}>
            <Card>
              <span className="ap-label">Bästa dag 🟢</span>
              {ins?.best ? (
                <>
                  <div className="ap-num" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
                    <span className="pos">{krShort(ins.best.profitUnits * unit, true)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>{dateShort(ins.best.date)} · {ins.best.bets} bets · {uFmt(ins.best.profitUnits, true)}</div>
                </>
              ) : <div style={{ color: "var(--dim2)", fontSize: 13, marginTop: 10 }}>Ingen data</div>}
            </Card>

            <Card>
              <span className="ap-label">Sämsta dag 🔴</span>
              {ins?.worst ? (
                <>
                  <div className="ap-num" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
                    <span className="neg">{krShort(ins.worst.profitUnits * unit, true)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>{dateShort(ins.worst.date)} · {ins.worst.bets} bets · {uFmt(ins.worst.profitUnits, true)}</div>
                </>
              ) : <div style={{ color: "var(--dim2)", fontSize: 13, marginTop: 10 }}>Ingen data</div>}
            </Card>

            <Card>
              <span className="ap-label">Den här månaden</span>
              {mom ? (
                <>
                  <div className="ap-num" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
                    <span className={mom.profitUnits >= 0 ? "pos" : "neg"}>{krShort(mom.profitUnits * unit, true)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 6 }}>
                    {monthLabel(mom.month)} · {mom.bets} bets
                    {momDelta != null && (
                      <> · <span className={momDelta >= 0 ? "pos" : "neg"}>{momDelta >= 0 ? "▲" : "▼"} {uFmt(Math.abs(momDelta))}</span> vs {monthLabel(momPrev?.month)}</>
                    )}
                  </div>
                </>
              ) : <div style={{ color: "var(--dim2)", fontSize: 13, marginTop: 10 }}>Ingen data</div>}
            </Card>
          </div>

          <Card>
            <span className="ap-label">P/L per veckodag</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
              {weekdays.every((w) => w.bets === 0) && <span style={{ color: "var(--dim2)", fontSize: 13 }}>Ingen data</span>}
              {weekdays.map((w) => (
                w.bets > 0 && (
                  <div key={w.weekday}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                      <span>{WEEKDAYS[w.weekday]} <span style={{ color: "var(--dim2)", fontSize: 12 }}>· {w.bets} bets</span></span>
                      <span className="ap-num" style={{ fontWeight: 600 }}>
                        <em className={w.profitUnits >= 0 ? "pos" : "neg"} style={{ fontStyle: "normal" }}>{krShort(w.profitUnits * unit, true)}</em>
                        <span style={{ color: "var(--dim2)", marginLeft: 8 }}>{pctFmt(w.roiPct, true)}</span>
                      </span>
                    </div>
                    <HBar pct={Math.max((Math.abs(w.profitUnits) / maxWd) * 100, 3)} color={w.profitUnits >= 0 ? cc.acc : cc.red} track={cc.grid} h={7} />
                  </div>
                )
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
