"use client";

/**
 * MOCK search driver.
 *
 * Stands in for the real fan-out: one query, three adapters running
 * concurrently, each landing whenever it lands. Everything a component reads
 * from here — `runs`, `results`, `phase` — is shaped like what the Convex
 * `searches` / `searchSources` / `searchResults` subscription would push, so
 * replacing this hook with the live subscription is a one-file change.
 *
 * Two things it deliberately gets right, because they are what the UI has to
 * prove: results are appended in *arrival* order (a fast source is never held
 * behind a slow one), and a source that fails stays visible with its own
 * status instead of vanishing from the header.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCE_LABEL, SOURCES, resultsFor } from "./mock-data";
import type { Source, SourceRun, UiResult } from "./types";

export type Phase = "idle" | "active";

/** Toggles from the (mock) demo panel, so the failure paths are reachable. */
export interface DemoOptions {
  /** Hold the web adapter back, to show partial results streaming in. */
  slowWebSource: boolean;
  /** Make Slack come back as a revoked grant instead of results. */
  slackNeedsReconnect: boolean;
  /** Make Gmail fail transiently, with a retry affordance. */
  gmailTransientFailure: boolean;
}

export const DEFAULT_DEMO: DemoOptions = {
  slowWebSource: true,
  slackNeedsReconnect: false,
  gmailTransientFailure: false,
};

/** What the caller learns once every adapter has reported. */
export interface RunSummary {
  returned: Source[];
  degraded: boolean;
  resultCount: number;
}

/** How long each mock adapter takes. Web is the deliberate slow one. */
function latencyFor(source: Source, demo: DemoOptions): number {
  if (source === "gmail") return 620;
  if (source === "slack") return 1150;
  return demo.slowWebSource ? 3600 : 1500;
}

const START_DELAY = 90;
/** Gap between rows of the same source, so a batch reads as a stream. */
const ROW_STAGGER = 90;

const pending = (source: Source): SourceRun => ({
  source,
  label: SOURCE_LABEL[source],
  status: "pending",
  resultCount: 0,
});

export function useMockSearch(
  demo: DemoOptions,
  /**
   * Fired from the last adapter's completion — an event, not an effect. Pass a
   * stable (`useCallback`) function: it is a dependency of `run`.
   */
  onSettled?: (summary: RunSummary) => void,
) {
  const [query, setQuery] = useState("");
  const [runs, setRuns] = useState<SourceRun[]>(() => SOURCES.map(pending));
  const [results, setResults] = useState<UiResult[]>([]);
  /** Ticks while anything is in flight, to drive the live elapsed counters. */
  const [elapsed, setElapsed] = useState(0);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const startedAt = useRef(0);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const after = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const patch = useCallback((source: Source, next: Partial<SourceRun>) => {
    setRuns((prev) =>
      prev.map((r) => (r.source === source ? { ...r, ...next } : r)),
    );
  }, []);

  const run = useCallback(
    /**
     * `enabled` is the set of sources the user has switched on in the source
     * bar. A disabled source is never dispatched, so it does not appear in
     * `runs` at all — an excluded source and a source that returned nothing are
     * different outcomes and must not look alike.
     */
    (nextQuery: string, enabled: Source[] = SOURCES) => {
      const q = nextQuery.trim();
      if (q.length === 0) return;

      const active = SOURCES.filter((s) => enabled.includes(s));
      if (active.length === 0) return;

      clearTimers();
      startedAt.current = performance.now();
      setElapsed(0);
      setQuery(q);
      setResults([]);
      setRuns(active.map(pending));

      // Tallied outside React so the summary is exact at the moment the last
      // adapter reports, with no dependency on a render having happened.
      const summary: RunSummary = {
        returned: [],
        degraded: false,
        resultCount: 0,
      };
      let outstanding = active.length;
      const settle = () => {
        outstanding -= 1;
        if (outstanding === 0) onSettled?.(summary);
      };

      for (const source of active) {
        const took = latencyFor(source, demo);

        after(START_DELAY, () => patch(source, { status: "running" }));

        after(START_DELAY + took, () => {
          // A revoked grant is its own outcome, not a generic failure: the UI
          // routes it to reconnect rather than to retry.
          if (source === "slack" && demo.slackNeedsReconnect) {
            patch(source, {
              status: "needs_reconnect",
              durationMs: took,
              errorKind: "needs_reconnect",
              errorMessage:
                "token_revoked — the Slack grant for Northwind HQ was revoked. Reconnect to restore it; the connection identity is preserved.",
            });
            summary.degraded = true;
            settle();
            return;
          }

          if (source === "gmail" && demo.gmailTransientFailure) {
            patch(source, {
              status: "failed",
              durationMs: took,
              errorKind: "transient",
              errorMessage:
                "429 rateLimitExceeded — retried 3 times with backoff (0.5s, 1s, 2s) and still rate limited. Safe to re-run.",
            });
            summary.degraded = true;
            settle();
            return;
          }

          const found = resultsFor(source, q);
          patch(source, {
            status: "succeeded",
            durationMs: took,
            resultCount: found.length,
          });
          summary.returned.push(source);
          summary.resultCount += found.length;

          // Append, never re-sort: rows arriving late must not shuffle rows the
          // reader is already looking at.
          found.forEach((item, i) => {
            after(i * ROW_STAGGER, () => setResults((prev) => [...prev, item]));
          });
          settle();
        });
      }
    },
    [after, clearTimers, demo, patch, onSettled],
  );

  const reset = useCallback(() => {
    clearTimers();
    setQuery("");
    setResults([]);
    setRuns(SOURCES.map(pending));
  }, [clearTimers]);

  // Both derived, so there is no state machine to keep in sync with itself.
  const phase: Phase = query.length === 0 ? "idle" : "active";
  const working =
    phase === "active" &&
    runs.some((r) => r.status === "pending" || r.status === "running");

  useEffect(() => {
    if (!working) return;
    const id = setInterval(
      () => setElapsed(Math.round(performance.now() - startedAt.current)),
      100,
    );
    return () => clearInterval(id);
  }, [working]);

  return { phase, query, runs, results, working, elapsed, run, reset };
}
