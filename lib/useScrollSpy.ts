"use client";

import { useEffect, useState } from "react";

/**
 * Which of the given section ids is the one currently being read: the last one
 * whose top has passed the offset line under the sticky bars. Drives the active
 * state of a page's anchor tabs. Recomputed on scroll, throttled to one frame.
 */
export function useScrollSpy(ids: string[], offset = 120): string {
  const [active, setActive] = useState(ids[0] ?? "");
  const key = ids.join("|");

  useEffect(() => {
    const list = key.split("|").filter(Boolean);
    let raf = 0;
    const measure = () => {
      raf = 0;
      let cur = list[0] ?? "";
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - offset <= 0) cur = id;
      }
      // At the very bottom the last section may be too short to reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        cur = list[list.length - 1] ?? cur;
      }
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, offset]);

  return active;
}
