import { fmtMoney } from "@/lib/format";

export function Hero({
  title,
  subtitle,
  bankrollUnits,
  unitValue,
  currency,
}: {
  title: string;
  subtitle?: string;
  bankrollUnits?: number;
  unitValue?: number;
  currency?: string;
}) {
  return (
    <div className="relative overflow-hidden border-b border-line bg-hero">
      <div className="absolute inset-0 bg-gradient-to-br from-pos/5 via-transparent to-accent-blue/5" />
      <div className="relative flex items-end justify-between px-8 py-7">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-text-mid">
            <span className="live-dot text-pos">●</span>
            Sports Betting Tracker
          </div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-text-hi">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-text-mid">{subtitle}</p>}
        </div>

        {bankrollUnits !== undefined && (
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-mid">
              Current Bankroll
            </div>
            <div className="tnum mt-1 text-2xl font-bold text-text-hi">
              {bankrollUnits.toFixed(2)}U
            </div>
            {unitValue !== undefined && (
              <div className="tnum text-xs text-text-lo">
                {fmtMoney(bankrollUnits * unitValue, currency)}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="h-[3px] w-full bg-gradient-to-r from-pos via-accent-blue to-accent-purple" />
    </div>
  );
}
