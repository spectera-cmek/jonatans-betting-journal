"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/**
 * Modal-dialog behaviour for a hand-rolled overlay: Escape closes, Tab is kept
 * inside the dialog, the page behind stops scrolling, and focus returns to
 * whatever opened it. Attach the returned ref to the dialog element (which
 * should carry role="dialog" aria-modal="true" and tabIndex={-1}).
 *
 * Focus only moves into the dialog if nothing inside it has focus already, so a
 * dialog that focuses its own first field keeps doing so.
 */
export function useDialog<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  // Latest onClose without re-running the effect: callers pass inline arrows,
  // and re-running would steal focus back to the dialog root on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) el.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        // An inner control (inline editor, open <select>) may own Escape.
        if (e.defaultPrevented) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!el.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  return ref;
}
