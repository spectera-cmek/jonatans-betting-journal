"use client";

import { Topbar } from "@/components/Shell";
import { CashoutCard } from "@/components/CashoutCard";
import { HedgeCard } from "@/components/HedgeCard";
import { AsianHandicapCard } from "@/components/AsianHandicapCard";
import { BonusCard } from "@/components/BonusCard";
import { I, IC } from "@/components/icons";

export default function ToolsPage() {
  return (
    <div>
      <Topbar
        title="Verktyg"
        sub="Kalkylatorer för vardagsbesluten — cashout, hedge, handicap och bonusar"
        icon={<I p={IC.wrench} />}
      />
      <CashoutCard />
      <HedgeCard />
      <AsianHandicapCard />
      <BonusCard />
    </div>
  );
}
