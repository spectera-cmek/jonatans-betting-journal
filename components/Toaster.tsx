"use client";

import { useEffect, useRef, useState } from "react";
import { onToast, type Toast } from "@/lib/toast";
import { I, IC } from "./icons";

const LEAVE_MS = 170;
type Shown = Toast & { leaving?: boolean };

/** Renders toasts raised anywhere with toast(...). Mounted once in the app layout. */
export function Toaster() {
  const [items, setItems] = useState<Shown[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = (id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), LEAVE_MS);
  };

  useEffect(() => {
    const map = timers.current;
    const off = onToast((t) => {
      // Keep at most three on screen; the oldest steps aside.
      setItems((list) => [...list.slice(-2), t]);
      const ms = t.duration ?? (t.action ? 6000 : 4000);
      map.set(t.id, setTimeout(() => dismiss(t.id), ms));
    });
    return () => {
      off();
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  return (
    <div className="ap-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={"ap-toast" + (t.tone ? ` is-${t.tone}` : "") + (t.leaving ? " is-leaving" : "")}
          onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
          onMouseLeave={() => {
            if (!t.leaving) timers.current.set(t.id, setTimeout(() => dismiss(t.id), 2000));
          }}
        >
          <span className="ap-toast-icon" aria-hidden="true">
            <I p={t.tone === "neg" ? IC.closeCircle : t.tone === "pos" ? IC.checkCircle : IC.check} size={16} />
          </span>
          <span className="ap-toast-text">
            <strong>{t.title}</strong>
            {t.detail && <span title={t.detail}>{t.detail}</span>}
          </span>
          {t.action && (
            <button
              className="ap-toast-action"
              onClick={async () => {
                dismiss(t.id);
                await t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
