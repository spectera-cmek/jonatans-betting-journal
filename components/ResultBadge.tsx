"use client";

import { krShort, uFmt } from "@/lib/format";
import { I, IC } from "./icons";

// Maps internal outcome -> Aurora badge. For settled win/loss it shows the P/L
// value (in units) colored and prefixed with a status glyph; for open/push it
// shows a pill.

/** Leading glyph + colour class for an unsettled or void outcome. */
function StatusPill({ outcome }: { outcome: string }) {
  if (outcome === "pending") {
    return (
      <span className="ap-badge open">
        <I p={IC.clock} size={12} />
        Öppen
      </span>
    );
  }
  return (
    <span className="ap-badge push">
      <I p={IC.minusCircle} size={12} />
      {outcome === "push" ? "Push" : "Void"}
    </span>
  );
}

export function ResultBadge({
  outcome,
  profitUnits,
}: {
  outcome: string;
  profitUnits: number | null;
}) {
  if (outcome === "pending") return <StatusPill outcome={outcome} />;
  if (outcome === "push" || outcome === "void") return <StatusPill outcome={outcome} />;
  const pos = outcome === "win" || outcome === "half_win";
  return (
    <span className={"ap-badge " + (pos ? "won" : "lost")}>
      <I p={pos ? IC.checkCircle : IC.closeCircle} size={12} />
      <span className="ap-res">{uFmt(profitUnits, true)}</span>
    </span>
  );
}

// kr-denominated variant for money displays
export function ResultBadgeKr({ outcome, profitKr }: { outcome: string; profitKr: number | null }) {
  if (outcome === "pending") return <StatusPill outcome={outcome} />;
  if (outcome === "push" || outcome === "void") return <StatusPill outcome={outcome} />;
  const pos = outcome === "win" || outcome === "half_win";
  return (
    <span className={"ap-badge " + (pos ? "won" : "lost")}>
      <I p={pos ? IC.checkCircle : IC.closeCircle} size={12} />
      <span className="ap-res">{krShort(profitKr, true)}</span>
    </span>
  );
}
