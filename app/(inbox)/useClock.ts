"use client";

/**
 * The wall clock, as a subscribable external store.
 *
 * Relative labels ("23m ago") need the current time, but reading `Date.now()`
 * during render is impure and, worse, freezes: the label is computed once and
 * then quietly rots. `useSyncExternalStore` is the right shape for this — time is
 * genuinely an external system that changes on its own — and it gives correct SSR
 * behaviour for free through the server snapshot.
 *
 * The snapshot is quantised to the minute for two reasons: `getSnapshot` must
 * return a stable value between notifications or React re-renders forever, and a
 * label that only ever says "23m" has no use for millisecond precision.
 */

import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, MINUTE_MS);
  return () => clearInterval(timer);
}

function getSnapshot(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/**
 * Zero on the server. Nothing time-derived is server-rendered — the data it would
 * describe arrives from a Convex subscription, which is `undefined` during SSR —
 * so a fixed value here keeps the markup deterministic.
 */
function getServerSnapshot(): number {
  return 0;
}

/** Current time, rounded down to the minute, re-rendering once a minute. */
export function useClockMinute(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
