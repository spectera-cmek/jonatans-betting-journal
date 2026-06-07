"use client";

import { useState } from "react";
import { api } from "@/lib/fetcher";

const quick = [
  { outcome: "win", label: "W", cls: "hover:bg-pos/20 hover:text-pos" },
  { outcome: "loss", label: "L", cls: "hover:bg-neg/20 hover:text-neg" },
  { outcome: "push", label: "P", cls: "hover:bg-accent-amber/20 hover:text-accent-amber" },
  { outcome: "void", label: "V", cls: "hover:bg-text-mid/20 hover:text-text-mid" },
];

export function SettleButtons({ betId, onDone }: { betId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  const settle = async (outcome: string) => {
    setBusy(true);
    try {
      await api.post(`/api/bets/${betId}/settle`, { outcome });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-1">
      {quick.map((q) => (
        <button
          key={q.outcome}
          disabled={busy}
          onClick={() => settle(q.outcome)}
          title={q.outcome}
          className={`h-7 w-7 rounded-md border border-line bg-hero text-xs font-bold text-text-mid transition-colors disabled:opacity-50 ${q.cls}`}
        >
          {q.label}
        </button>
      ))}
    </div>
  );
}
