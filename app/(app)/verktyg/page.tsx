"use client";

import { Topbar } from "@/components/Shell";
import { KellyCard } from "@/components/KellyCard";
import { CashoutCard } from "@/components/CashoutCard";
import { HedgeCard } from "@/components/HedgeCard";
import { AsianHandicapCard } from "@/components/AsianHandicapCard";
import { BonusCard } from "@/components/BonusCard";
import { I, IC } from "@/components/icons";
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
        icon={IC.wrench}
      />
      {/* Remount once metrics load so the bankroll prefill picks them up. */}
      <KellyCard key={data ? "ready" : "loading"} defaultBankrollUnits={bankrollU} unit={unit} />
      <CashoutCard />
      <HedgeCard />
      <AsianHandicapCard />
      <BonusCard />
    </div>
  );
}
