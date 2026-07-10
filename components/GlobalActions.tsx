"use client";

import { useEffect, useState } from "react";
import { AddBetModal } from "./AddBetModal";
import { SyncButton } from "./SyncButton";
import { revalidateAll } from "@/lib/useData";
import { api } from "@/lib/fetcher";
import type { SettingsDTO } from "@/lib/types";
import { I, IC } from "./icons";

// The "Synka" + "+ Logga bet" pair lives in the global top nav (per the design),
// so it's available on every page. Saving/syncing broadcasts revalidateAll(),
// which refreshes whatever data the current page has cached.
export function GlobalActions() {
  const [adding, setAdding] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    api
      .get<SettingsDTO>("/api/settings")
      .then((s) => setHasKey(s.hasOddsApiKey ?? false))
      .catch(() => {});
  }, []);

  return (
    <>
      <SyncButton onDone={revalidateAll} />
      <button className="ap-btn" onClick={() => setAdding(true)}>
        <I p={IC.plus} size={15} /> <span className="ap-hide-sm">Logga bet</span>
      </button>
      <AddBetModal open={adding} onClose={() => setAdding(false)} onSaved={revalidateAll} hasOddsApiKey={hasKey} />
    </>
  );
}
