"use client";

// Quick search: Ctrl/⌘K (or "/" when not typing) opens a box that jumps to any
// page or runs a global action. With thirteen destinations it is the fastest
// way around, and it is the same list the side panel shows — lib/nav.ts.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { useDialog } from "@/lib/useDialog";
import { NAV_GROUPS, SETTINGS_NAV } from "@/lib/nav";
import { CMD, emit, useCommand } from "@/lib/commands";
import { useTheme } from "./ThemeProvider";
import { I, IC } from "./icons";

interface Entry {
  id: string;
  group: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Extra words the search should match besides label and hint. */
  words?: string;
  run: () => void;
}

/** Lower-case and strip diacritics, so "oversikt" finds "Översikt". */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function CommandPalette() {
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);
  const dialogRef = useDialog<HTMLDivElement>(open, close);

  // A fresh box every time it opens. Reset here, in the same update that opens
  // it — not in an effect afterwards, which would land after (and undo) an arrow
  // key pressed straight after the shortcut.
  const openFresh = useCallback(() => {
    setQuery("");
    setSel(0);
    setOpen(true);
  }, []);

  useCommand(CMD.palette, openFresh);

  // Latest open state for the document listener, without re-subscribing.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (openRef.current) setOpen(false);
        else openFresh();
      } else if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(document.activeElement)) {
        // Not while another dialog is up — "/" there belongs to that dialog.
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        openFresh();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openFresh]);

  const entries = useMemo<Entry[]>(() => {
    const go = (href: string) => () => router.push(href);
    const actions: Entry[] = [
      { id: "a-add", group: "Åtgärder", label: "Logga bet", hint: "Nytt spel", icon: IC.plus, words: "ny lägg till spel bet add", run: () => emit(CMD.addBet) },
      { id: "a-sync", group: "Åtgärder", label: "Synka", hint: "Rättning + CLV", icon: IC.refresh, words: "sync rätta stängningsodds uppdatera", run: () => emit(CMD.sync) },
      {
        id: "a-mode",
        group: "Åtgärder",
        label: mode === "dark" ? "Byt till ljust läge" : "Byt till mörkt läge",
        hint: "Utseende",
        icon: mode === "dark" ? IC.sun : IC.moon,
        words: "tema theme dark light mörkt ljust",
        run: () => setMode(mode === "dark" ? "light" : "dark"),
      },
    ];
    const pages: Entry[] = [
      ...NAV_GROUPS.flatMap((g) =>
        g.items.map((n) => ({ id: "p-" + n.href, group: g.label, label: n.label, hint: n.desc, icon: n.icon, words: g.label, run: go(n.href) }))
      ),
      { id: "p-" + SETTINGS_NAV.href, group: "Konto", label: SETTINGS_NAV.label, hint: SETTINGS_NAV.desc, icon: SETTINGS_NAV.icon, words: "settings konto", run: go(SETTINGS_NAV.href) },
    ];
    return [...pages, ...actions];
  }, [router, mode, setMode]);

  const results = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    const scored: { e: Entry; score: number }[] = [];
    for (const e of entries) {
      const label = fold(e.label);
      const hay = label + " " + fold(e.hint) + " " + fold(e.words ?? "");
      if (!terms.every((t) => hay.includes(t))) continue;
      // A label that starts with the query outranks one that merely contains it,
      // which outranks a match in the description.
      const score = label.startsWith(terms[0]) ? 0 : label.includes(terms[0]) ? 1 : 2;
      scored.push({ e, score });
    }
    return scored.sort((a, b) => a.score - b.score).map((x) => x.e);
  }, [entries, query]);

  // Keep the highlighted row inside the list and inside the viewport.
  useEffect(() => {
    if (sel >= results.length) setSel(Math.max(0, results.length - 1));
  }, [results.length, sel]);
  useEffect(() => {
    listRef.current?.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  if (!open) return null;

  const run = (e: Entry | undefined) => {
    if (!e) return;
    close();
    e.run();
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setSel((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setSel((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (ev.key === "Home") {
      ev.preventDefault();
      setSel(0);
    } else if (ev.key === "End") {
      ev.preventDefault();
      setSel(Math.max(0, results.length - 1));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      run(results[sel]);
    }
  };

  // Group headings only while browsing; a typed query gives one ranked list.
  const grouped = query.trim() === "";

  return (
    <div className="ap-cmdk-overlay" onClick={close}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="ap-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Sök eller hoppa till"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="ap-cmdk-input">
          <I p={IC.search} size={17} />
          <input
            // Focused as it mounts, so typing and arrows work from the first key.
            autoFocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[sel] ? `${listId}-${results[sel].id}` : undefined}
            aria-autocomplete="list"
            aria-label="Sök sida eller åtgärd"
            placeholder="Sök sida eller åtgärd…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
          />
          <kbd className="ap-kbd">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} className="ap-cmdk-list" role="listbox" aria-label="Träffar">
          {results.length === 0 && <div className="ap-cmdk-empty">Inget matchar ”{query}”.</div>}
          {results.map((e, i) => (
            <div key={e.id} role="presentation">
              {grouped && (i === 0 || results[i - 1].group !== e.group) && (
                <div className="ap-cmdk-group" role="presentation">{e.group}</div>
              )}
              <button
                type="button"
                id={`${listId}-${e.id}`}
                role="option"
                aria-selected={i === sel}
                tabIndex={-1}
                className={"ap-cmdk-item" + (i === sel ? " is-sel" : "")}
                onMouseMove={() => setSel(i)}
                onClick={() => run(e)}
              >
                <I p={e.icon} size={16} />
                <span>{e.label}</span>
                <small>{e.hint}</small>
              </button>
            </div>
          ))}
        </div>

        <div className="ap-cmdk-foot" aria-hidden="true">
          <span><kbd className="ap-kbd">↑</kbd><kbd className="ap-kbd">↓</kbd> välj</span>
          <span><kbd className="ap-kbd">↵</kbd> öppna</span>
          <span><kbd className="ap-kbd">Esc</kbd> stäng</span>
        </div>
      </div>
    </div>
  );
}
