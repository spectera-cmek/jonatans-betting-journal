"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { SyncButton } from "./SyncButton";
import { revalidateAll, useSettings } from "@/lib/useData";
import { I, IC } from "./icons";
import { CMD, useCommand } from "@/lib/commands";

// AddBetModal is ~34 kB and this component sits in the global status bar, so a
// static import placed the whole modal in every authenticated route's bundle
// even on pages where it is never opened. Loading it on first open keeps it off
// the critical path. `mounted` stays true afterwards, so the component instance
// lives on across close/reopen just as it did when it was always rendered and
// early-returned null. (The form itself is reset on each open by AddBetModal, as
// before — see its open-effect.)
const AddBetModal = dynamic(() => import("./AddBetModal").then((m) => m.AddBetModal), {
  ssr: false,
});

// The "Synka" + "+ Logga bet" pair lives in the status bar, so it's available on
// every page. The quick search can ask for either one by name (lib/commands). Saving/syncing broadcasts revalidateAll(),
// which refreshes whatever data the current page has cached.
export function GlobalActions() {
  const [adding, setAdding] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Shares the cached /api/settings entry with useMetrics/useBets instead of
  // firing a third request of its own.
  const { data: settings } = useSettings();
  const unit = settings?.unitValue || 100;

  const openAdd = () => {
    setMounted(true);
    setAdding(true);
  };
  useCommand(CMD.addBet, openAdd);

  return (
    <>
      <SyncButton onDone={revalidateAll} />
      <button
        className="ap-btn"
        aria-label="Logga bet"
        aria-haspopup="dialog"
        onClick={openAdd}
      >
        <I p={IC.plus} size={15} /> <span className="ap-hide-sm">Logga bet</span>
      </button>
      {mounted && (
        <AddBetModal
          open={adding}
          onClose={() => setAdding(false)}
          onSaved={revalidateAll}
          unit={unit}
        />
      )}
    </>
  );
}
