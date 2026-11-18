"use client";

import { useEffect, useState } from "react";
import { InlineStat } from "@/components/stats";
import { api } from "@/lib/fetcher";
import type { Freshness as FreshnessData } from "@/lib/localJobs";

/** När sidans schemalagda jobb senast lyckades. Gul efter 30 h, röd när senaste körningen fallerade. */
export function Freshness({ job }: { job: string }) {
  const [data, setData] = useState<FreshnessData | null>(null);
  useEffect(() => {
    api
      .get<FreshnessData>(`/api/freshness?job=${encodeURIComponent(job)}`)
      .then(setData)
      .catch(() => setData(null));
  }, [job]);
  if (!data) return null;
  const title = data.failed
    ? `Senaste körningen misslyckades: ${data.error}`
    : data.lastOkAt
      ? `Senast uppdaterad ${new Date(data.lastOkAt).toLocaleString("sv-SE")}`
      : "Jobbet har aldrig körts";
  return (
    <span title={title}>
      <InlineStat label={data.failed ? "Uppdaterad · fel" : "Uppdaterad"} value={data.label} tone={data.tone} />
    </span>
  );
}
