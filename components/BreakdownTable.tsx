import { fmtUnits, fmtPct, fmtOdds, signClass } from "@/lib/format";

interface Row {
  key: string;
  bets: number;
  profitUnits: number;
  roiPct: number | null;
  avgOdds?: number | null;
}

export function BreakdownTable({
  rows,
  labelHeader,
  showAvgOdds = false,
  emptyText = "Ingen data än.",
}: {
  rows: Row[];
  labelHeader: string;
  showAvgOdds?: boolean;
  emptyText?: string;
}) {
  if (!rows.length) {
    return <div className="px-1 py-6 text-sm text-text-lo">{emptyText}</div>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-[10px] uppercase tracking-wider text-text-mid">
            <th className="px-4 py-2.5 text-left font-semibold">{labelHeader}</th>
            <th className="px-3 py-2.5 text-right font-semibold">Bets</th>
            {showAvgOdds && (
              <th className="px-3 py-2.5 text-right font-semibold">Avg Odds</th>
            )}
            <th className="px-3 py-2.5 text-right font-semibold">Profit</th>
            <th className="px-4 py-2.5 text-right font-semibold">ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.key}
              className={`border-b border-line-subtle last:border-0 ${
                i % 2 === 1 ? "bg-band/40" : ""
              }`}
            >
              <td className="px-4 py-2.5 text-left text-text-hi">{r.key}</td>
              <td className="tnum px-3 py-2.5 text-right text-text-mid">{r.bets}</td>
              {showAvgOdds && (
                <td className="tnum px-3 py-2.5 text-right text-text-mid">
                  {fmtOdds(r.avgOdds)}
                </td>
              )}
              <td className={`tnum px-3 py-2.5 text-right font-semibold ${signClass(r.profitUnits)}`}>
                {fmtUnits(r.profitUnits, false)}
              </td>
              <td className={`tnum px-4 py-2.5 text-right font-semibold ${signClass(r.roiPct)}`}>
                {fmtPct(r.roiPct, false)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
