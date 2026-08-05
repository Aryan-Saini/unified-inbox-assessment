"use client";

/**
 * LIVE search driver — the real fan-out behind the same interface the mock had.
 *
 * `useMockSearch.ts` is deliberately still in the tree as the reference
 * implementation: this hook returns the identical tuple
 * (`phase, query, runs, results, working, elapsed, run, reset`), so no component
 * below it changed. Everything provider-shaped is absorbed here, and there are
 * exactly three translations worth knowing about:
 *
 *  1. **Rows are per connection; the UI is per source.** The backend runs one
 *     worker per Gmail account and per Slack workspace, because "the second
 *     account's grant is dead" has to be expressible. The source strip has one
 *     entry per connector, so the rows are folded with worst-status-wins — a
 *     degraded account is never averaged away by a healthy sibling.
 *
 *  2. **Time is formatted here, not stored.** The backend stores ISO timestamps;
 *     the mock pre-formatted its ages as strings. `formatAge` plus the minute
 *     clock reproduces the mock's strings without a `Date.now()` in render.
 *
 *  3. **`elapsed` is anchored on `search.createdAt`,** not on when this component
 *     mounted, so reopening a running search shows the real elapsed time instead
 *     of restarting the stopwatch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { formatAge } from "./format";
import { useClockMinute } from "./useClock";
import type { Source, SourceRun, SourceRunStatus, UiResult } from "./types";

export type Phase = "idle" | "active";

const SOURCES: Source[] = ["gmail", "slack", "web"];

/**
 * The demo panel's controls, unchanged from the mock hook so the settings UI did
 * not have to move. Each one maps to a fault the *backend* injects, and the
 * backend ignores all of them unless `ALLOW_FAULT_INJECTION=true` — a demo flag
 * in a client build cannot break a real search.
 */
export interface DemoOptions {
  /** Hold the web adapter back, to show partial results streaming in. */
  slowWebSource: boolean;
  /** Make Slack come back as a revoked grant instead of results. */
  slackNeedsReconnect: boolean;
  /** Make Gmail fail transiently, so the backoff-then-give-up path is visible. */
  gmailTransientFailure: boolean;
}

export const DEFAULT_DEMO: DemoOptions = {
  slowWebSource: true,
  slackNeedsReconnect: false,
  gmailTransientFailure: false,
};

/** How long the "slow source" demo holds web back. Long enough that Gmail and
 *  Slack are visibly readable first, short enough not to test anyone's patience. */
const SLOW_WEB_MS = 3600;

interface DemoArgs {
  delayMs?: Record<string, number>;
  injectFailure?: Record<string, "transient" | "permanent" | "needs_reconnect" | "unknown">;
}

function toDemoArgs(demo: DemoOptions): DemoArgs | undefined {
  const delayMs: Record<string, number> = {};
  const injectFailure: DemoArgs["injectFailure"] = {};

  if (demo.slowWebSource) delayMs.web = SLOW_WEB_MS;
  if (demo.slackNeedsReconnect) injectFailure.slack = "needs_reconnect";
  if (demo.gmailTransientFailure) injectFailure.gmail = "transient";

  const args: DemoArgs = {};
  if (Object.keys(delayMs).length > 0) args.delayMs = delayMs;
  if (Object.keys(injectFailure).length > 0) args.injectFailure = injectFailure;
  return args.delayMs === undefined && args.injectFailure === undefined
    ? undefined
    : args;
}

/**
 * Which status a connector reports when its accounts disagree.
 *
 * Ordered by how much it matters to the person reading it: a revoked grant is
 * the one thing they can act on, so it wins over everything, and a still-running
 * sibling wins over a finished one so the strip keeps spinning until the source
 * is genuinely done.
 */
const STATUS_RANK: Record<SourceRunStatus, number> = {
  needs_reconnect: 5,
  failed: 4,
  running: 3,
  pending: 2,
  succeeded: 1,
};

interface WatchSourceRow {
  source: Source;
  label: string;
  status: SourceRunStatus;
  errorKind?: "transient" | "permanent" | "needs_reconnect" | "unknown";
  errorMessage?: string;
  resultCount: number;
  durationMs?: number;
}

function aggregate(rows: WatchSourceRow[]): SourceRun[] {
  return SOURCES.flatMap((source): SourceRun[] => {
    const own = rows.filter((row) => row.source === source);
    if (own.length === 0) return [];

    const worst = own.reduce((a, b) =>
      STATUS_RANK[b.status] > STATUS_RANK[a.status] ? b : a,
    );
    const durations = own
      .map((row) => row.durationMs)
      .filter((ms): ms is number => ms !== undefined);

    return [
      {
        source,
        // One account shows its own name; several collapse to a count, because
        // three addresses in a source pill is unreadable and the connections
        // screen is where per-account detail belongs.
        label: own.length === 1 ? own[0].label : `${own.length} accounts`,
        status: worst.status,
        resultCount: own.reduce((total, row) => total + row.resultCount, 0),
        // The slowest account is how long the *source* took, which is what the
        // reader is timing.
        durationMs: durations.length === 0 ? undefined : Math.max(...durations),
        errorKind: worst.errorKind,
        errorMessage:
          own.length === 1 || worst.errorMessage === undefined
            ? worst.errorMessage
            : `${worst.label}: ${worst.errorMessage}`,
      },
    ];
  });
}

const pending = (source: Source): SourceRun => ({
  source,
  label: "…",
  status: "pending",
  resultCount: 0,
});

export interface UseSearch {
  phase: Phase;
  query: string;
  runs: SourceRun[];
  results: UiResult[];
  working: boolean;
  elapsed: number;
  /** Dispatch a new search. Returns immediately; results stream in. */
  run: (query: string, enabled?: Source[], demoOverride?: DemoOptions) => void;
  reset: () => void;
  /** The search being watched, so callers can archive or rerun it. */
  searchId: Id<"searches"> | null;
  /**
   * Subscribe to an existing search from history — reads, never re-executes.
   * The known query is passed in so the docked layout does not fall back to the
   * hero state for the frame before the subscription's first response.
   */
  open: (searchId: Id<"searches">, query?: string) => void;
  /** Re-ask the same question as a NEW search, preserving the old one. */
  rerun: (demoOverride?: DemoOptions) => void;
  /**
   * `rerun`, but for a search that is not the one being watched — the history
   * sidebar's re-run button. Query and sources come from the history row, so
   * the optimistic strip is right before the server answers.
   */
  rerunFrom: (searchId: Id<"searches">, query: string, sources: Source[]) => void;
}

export function useSearch(demo: DemoOptions): UseSearch {
  const [searchId, setSearchId] = useState<Id<"searches"> | null>(null);
  /** The query as typed, so the docked state has a title before the first
   *  server response arrives. Superseded by the search's own query once it does. */
  const [localQuery, setLocalQuery] = useState("");
  /** Source strip to show while the dispatch mutation is in flight. Without it
   *  the header would be empty for a beat and the run would look lost. */
  const [optimisticRuns, setOptimisticRuns] = useState<SourceRun[]>([]);
  const [elapsed, setElapsed] = useState(0);

  const runMutation = useMutation(api.searches.run);
  const rerunMutation = useMutation(api.searches.rerun);

  const data = useAuthedQuery(
    api.searches.watch,
    searchId === null ? "skip" : { searchId },
  );
  const now = useClockMinute();

  /** Guards against an earlier dispatch resolving after a later one. */
  const dispatch = useRef(0);
  const localStart = useRef(0);

  const beginDispatch = useCallback((query: string, sources: Source[]) => {
    const token = (dispatch.current += 1);
    localStart.current = Date.now();
    setElapsed(0);
    setLocalQuery(query);
    // Drop the old subscription immediately: showing the previous search's
    // results under a new query is worse than showing none.
    setSearchId(null);
    setOptimisticRuns(sources.map(pending));
    return token;
  }, []);

  const land = useCallback((token: number, id: Id<"searches">) => {
    if (dispatch.current !== token) return;
    setSearchId(id);
  }, []);

  /**
   * A dispatch that never landed.
   *
   * Rare — the mutation only writes rows and schedules work — but "the spinner
   * span forever" is the one outcome that must be impossible, so a rejected
   * dispatch drops the optimistic strip and the run reads as finished-with-nothing
   * rather than perpetually in flight.
   */
  const failDispatch = useCallback((token: number, err: unknown) => {
    if (dispatch.current !== token) return;
    console.error("Search dispatch failed", err);
    setOptimisticRuns([]);
  }, []);

  const run = useCallback(
    (nextQuery: string, enabled: Source[] = SOURCES, demoOverride?: DemoOptions) => {
      const query = nextQuery.trim();
      if (query === "") return;
      const sources = enabled.length === 0 ? SOURCES : enabled;

      const token = beginDispatch(query, sources);
      void runMutation({
        query,
        sources,
        demo: toDemoArgs(demoOverride ?? demo),
      })
        .then(({ searchId: id }) => land(token, id))
        .catch((err: unknown) => failDispatch(token, err));
    },
    [beginDispatch, demo, failDispatch, land, runMutation],
  );

  const rerun = useCallback(
    (demoOverride?: DemoOptions) => {
      if (searchId === null) return;
      const previous = searchId;
      const token = beginDispatch(
        data?.search.query ?? localQuery,
        data === undefined || data === null
          ? SOURCES
          : [...new Set(data.sources.map((row) => row.source))],
      );
      void rerunMutation({
        searchId: previous,
        demo: toDemoArgs(demoOverride ?? demo),
      })
        .then(({ searchId: id }) => land(token, id))
        .catch((err: unknown) => failDispatch(token, err));
    },
    [beginDispatch, data, demo, failDispatch, land, localQuery, rerunMutation, searchId],
  );

  const rerunFrom = useCallback(
    (id: Id<"searches">, query: string, sources: Source[]) => {
      const token = beginDispatch(
        query,
        sources.length === 0 ? SOURCES : sources,
      );
      void rerunMutation({ searchId: id, demo: toDemoArgs(demo) })
        .then(({ searchId: newId }) => land(token, newId))
        .catch((err: unknown) => failDispatch(token, err));
    },
    [beginDispatch, demo, failDispatch, land, rerunMutation],
  );

  const open = useCallback((id: Id<"searches">, knownQuery = "") => {
    dispatch.current += 1;
    setOptimisticRuns([]);
    setLocalQuery(knownQuery);
    setSearchId(id);
  }, []);

  const reset = useCallback(() => {
    dispatch.current += 1;
    setSearchId(null);
    setLocalQuery("");
    setOptimisticRuns([]);
    setElapsed(0);
  }, []);

  const runs = useMemo(
    () => (data === undefined || data === null ? optimisticRuns : aggregate(data.sources)),
    [data, optimisticRuns],
  );

  const results = useMemo<UiResult[]>(() => {
    if (data === undefined || data === null) return [];

    // Arrival order, exactly as stored: `watch` returns rows in `seq` order and
    // nothing here re-sorts them, so a late source appends instead of shuffling
    // rows the reader is already looking at.
    return data.results.map((row) => ({
      source: row.source,
      id: row.id,
      title: row.title,
      snippet: row.snippet,
      author: row.author,
      timestamp: row.timestamp,
      url: row.url,
      // Web results carry no trustworthy date, so they get no age label rather
      // than a made-up one.
      age: row.timestamp === undefined ? "" : formatAge(Date.parse(row.timestamp), now),
      context: row.context,
      replyTo: row.replyTo,
      unread: row.unread,
      // What a reply needs beyond the display fields: which grant to send
      // through, and where in the conversation to land.
      connectionId: row.connectionId,
      threadId: row.threadId,
      externalId: row.externalId,
      score: row.score,
    }));
  }, [data, now]);

  const query = data?.search.query ?? localQuery;
  const phase: Phase = query === "" ? "idle" : "active";

  /**
   * `search.status` is authoritative once the subscription is live: the backend
   * flips it to `complete` in the same transaction as the last source's terminal
   * write, so trusting it here cannot disagree with the strip. Before the first
   * response, a dispatch in flight is what counts as working — a search with no
   * dispatch and no data is idle, not stuck.
   */
  const working =
    phase === "active" &&
    (data === undefined
      ? optimisticRuns.length > 0
      : data !== null && data.search.status === "running");

  useEffect(() => {
    if (!working) return;

    // Anchored on the server's own creation time, so the counter is right even
    // for a search opened from history mid-flight.
    const anchor = data?.search.createdAt ?? localStart.current;
    const tick = () => setElapsed(Math.max(0, Date.now() - anchor));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [working, data?.search.createdAt]);

  return {
    phase,
    query,
    runs,
    results,
    working,
    elapsed,
    run,
    reset,
    searchId,
    open,
    rerun,
    rerunFrom,
  };
}
