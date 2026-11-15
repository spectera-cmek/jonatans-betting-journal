"use client";

import { Topbar } from "@/components/Shell";
import { KellyCard } from "@/components/KellyCard";
import { CashoutCard } from "@/components/CashoutCard";
import { HedgeCard } from "@/components/HedgeCard";
import { AsianHandicapCard } from "@/components/AsianHandicapCard";
import { BonusCard } from "@/components/BonusCard";
import { useMetrics } from "@/lib/useData";

export default function ToolsPage() {
  const { data } = useMetrics();
  const unit = data?.settings.unitValue ?? 100;
  // Bankroll for the Kelly calculator: starting bankroll + realised P/L.
  const bankrollU = (data?.settings.startingBankrollUnits ?? 100) + (data?.metrics.profitUnits ?? 0);

  return (
    <div>
      <Topbar
        title="Verktyg"
        sub="Kalkylatorer för vardagsbesluten — insats, cashout, hedge, handicap och bonusar"
      />
      {/* Calculators side by side on a ruled board; one column on phones. */}
      <div className="ap-board c2">
        {/* Remount once metrics load so the bankroll prefill picks them up. */}
        <KellyCard key={data ? "ready" : "loading"} defaultBankrollUnits={bankrollU} unit={unit} />
        <CashoutCard />
        <HedgeCard />
        <BonusCard />
        <AsianHandicapCard className="ap-span-all" />
      </div>
    </div>
  );
}
