"use client";

// A tiny window-event bus for the global actions. The quick search, the status
// bar and keyboard shortcuts live in different parts of the tree from the
// components that own the behaviour (the add-bet dialog, the sync button), so
// they ask for an action by name instead of threading callbacks through the
// layout.

import { useEffect, useRef } from "react";

export const CMD = {
  /** Open the "Logga bet" dialog. */
  addBet: "bj:add-bet",
  /** Run a full sync (settling + closing odds). */
  sync: "bj:sync",
  /** Open the quick search. */
  palette: "bj:palette",
} as const;

export type Command = (typeof CMD)[keyof typeof CMD];

export function emit(cmd: Command) {
  window.dispatchEvent(new Event(cmd));
}

/** Run `handler` whenever `cmd` is emitted, for as long as the caller is mounted. */
export function useCommand(cmd: Command, handler: () => void) {
  // Latest handler without re-subscribing on every render.
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const on = () => ref.current();
    window.addEventListener(cmd, on);
    return () => window.removeEventListener(cmd, on);
  }, [cmd]);
}
