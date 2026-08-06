"use client";

import { useCallback, useSyncExternalStore } from "react";
import { SOURCES } from "./mock-data";
import type { Source } from "./types";

const KEY = "unified-inbox:enabled-sources";

function parse(raw: string | null): Source[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    // Filter through SOURCES rather than trusting the stored array: a stale
    // preference must not be able to resurrect a connector the app has dropped,
    // and this pins the order too.
    const kept = SOURCES.filter((s) => value.includes(s));
    return kept.length > 0 ? kept : null;
  } catch {
    return null;
  }
}

/**
 * The preference lives outside React, in `localStorage`, so it is read through
 * `useSyncExternalStore` — the same shape `useClockMinute` uses. Reading it in
 * an effect instead would render the default first and then correct itself, a
 * visible flash of "web is on" for someone who turned web off.
 *
 * `snapshot` is memoised because the store must hand back a stable reference
 * until the value actually changes.
 */
let snapshot: Source[] = SOURCES;
let raw: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab writing the same key is the same preference changing.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): Source[] {
  const next = window.localStorage.getItem(KEY);
  if (next !== raw) {
    raw = next;
    snapshot = parse(next) ?? SOURCES;
  }
  return snapshot;
}

function getServerSnapshot(): Source[] {
  return SOURCES;
}

/** Which connectors a search fans out to, remembered across reloads. */
export function useEnabledSources() {
  const enabled = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setEnabled = useCallback(
    (update: Source[] | ((prev: Source[]) => Source[])) => {
      const next =
        typeof update === "function" ? update(getSnapshot()) : update;
      window.localStorage.setItem(KEY, JSON.stringify(next));
      for (const listener of listeners) listener();
    },
    [],
  );

  return [enabled, setEnabled] as const;
}
