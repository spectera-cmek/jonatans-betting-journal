"use client";

import { krShort, uFmt } from "@/lib/format";

// Maps internal outcome -> Aurora badge. For settled win/loss it shows the P/L
// value (in units) colored; for open/push it shows a pill.
export function ResultBadge({
  outcome,
  profitUnits,
}: {
  outcome: string;
  profitUnits: number | null;
}) {
  if (outcome === "pending") return <span className="ap-badge open">Öppen</span>;
  if (outcome === "push" || outcome === "void")
    return <span className="ap-badge push">{outcome === "push" ? "Push" : "Void"}</span>;
  const pos = outcome === "win" || outcome === "half_win";
  return <span className={"ap-res " + (pos ? "pos" : "neg")}>{uFmt(profitUnits, true)}</span>;
}

// kr-denominated variant for money displays
export function ResultBadgeKr({ outcome, profitKr }: { outcome: string; profitKr: number | null }) {
  if (outcome === "pending") return <span className="ap-badge open">Öppen</span>;
  if (outcome === "push" || outcome === "void")
    return <span className="ap-badge push">{outcome === "push" ? "Push" : "Void"}</span>;
  const pos = outcome === "win" || outcome === "half_win";
  return <span className={"ap-res " + (pos ? "pos" : "neg")}>{krShort(profitKr, true)}</span>;
}
