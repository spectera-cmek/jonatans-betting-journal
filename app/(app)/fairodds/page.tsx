"use client";

import { Topbar } from "@/components/Shell";
import { SkeletonCard } from "@/components/ui";
import { FairOddsCalculator } from "@/components/FairOddsCalculator";
import { I, IC } from "@/components/icons";
import { useMetrics } from "@/lib/useData";

export default function FairOddsPage() {
  const { data, loading } = useMetrics();
  const unit = data?.settings.unitValue ?? 100;
  // Bankroll for the Kelly suggestion: starting bankroll + realised P/L.
  const bankrollU = (data?.settings.startingBankrollUnits ?? 100) + (data?.metrics.profitUnits ?? 0);

  return (
    <div>
      <Topbar
        title="Fair odds"
        sub="Vad borde specialspelet kosta — och är oddset du fått värt det?"
        icon={IC.percent}
      />
      {loading && !data && (
        <>
          <SkeletonCard />
          <div style={{ marginTop: 12 }}>
            <SkeletonCard />
          </div>
        </>
      )}
      {data && <FairOddsCalculator defaultBankrollUnits={bankrollU} unit={unit} />}
    </div>
  );
}
