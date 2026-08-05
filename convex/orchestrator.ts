/**
 * The fan-out worker.
 *
 * One `runSource` action per source-connection, scheduled independently by
 * `searches.run`. That is the whole concurrency design, and it is structural
 * rather than cooperative: two Gmail accounts, a Slack workspace and web search
 * are four separate Convex actions with four separate isolates, transactions and
 * failure domains. A slow source cannot block a fast one because there is
 * nothing shared to block on, and a source that crashes takes down its own row
 * and nothing else.
 *
 * Three rules the rest of the file exists to keep:
 *
 *  1. **A source's terminal state is written in exactly one mutation.** Results,
 *     status, counts, duration and the parent search's completion check all land
 *     together, so a subscriber never sees "succeeded with zero results" or a
 *     half-written batch flicker past.
 *
 *  2. **Only `transient` is retried.** `retryTransient` enforces it; a revoked
 *     grant or a bad request surfaces immediately, because retrying either one is
 *     just a slower way to show the same error.
 *
 *  3. **Something always writes the terminal state.** If a worker dies between
 *     `begin` and `complete`, `sweepSearch` (scheduled at the deadline) and the
 *     5-minute cron behind it force the row to `failed`. The UI cannot spin
 *     forever, because "forever" is not a state anything can leave it in.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { resolveToken } from "./connections";
import { maybeInjectFailure } from "./core/faults";
import { retryTransient } from "./core/http";
import { scoreResult } from "./core/rank";
import { redactError } from "./core/redact";
import { ADAPTERS, requiresGrant } from "./core/registry";
import { AdapterError, toAdapterError } from "./core/types";
import { errorKind as errorKindValidator, source as sourceValidator } from "./schema";

/** Per-source budget. Every attempt gets its own; the sweeper's deadline is
 *  derived from it so the two can never disagree. */
export const SOURCE_DEADLINE_MS = 20_000;

/** Attempts per source. Only transient failures consume more than one. */
export const MAX_ATTEMPTS = 3;

/**
 * Results kept per source.
 *
 * Also the transaction budget: `completeSourceRun` writes every row in one
 * mutation, so the cap is what guarantees that mutation fits. Twenty per source
 * is more than a human reads in a merged list anyway.
 */
export const RESULTS_PER_SOURCE = 20;

/** When the watchdog runs. Past the last attempt's deadline plus a margin, so it
 *  only ever fires on a worker that genuinely stopped reporting. */
export const SWEEP_DELAY_MS = 25_000;

/** How old a still-`running` search must be before the cron backstop sweeps it.
 *  Comfortably past every deadline above, so it never races a live worker. */
const STUCK_SEARCH_AFTER_MS = 90_000;

/** The row shape the action hands back for storage. Provider-shaped fields have
 *  already been normalised by the adapter; scoring and sequencing happen in the
 *  mutation, where the parent search (and therefore the query) is readable. */
const adapterResult = v.object({
  id: v.string(),
  title: v.string(),
  snippet: v.string(),
  author: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  url: v.string(),
  externalId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  replyTo: v.optional(v.string()),
  context: v.optional(v.string()),
  unread: v.optional(v.boolean()),
});

/* ------------------------------------------------------------------- helpers */

/**
 * Flip the parent search to `complete` once no sibling is still working.
 *
 * Called from every terminal path rather than by the last worker "knowing" it is
 * last: workers finish concurrently and none of them can tell. Re-reading the
 * siblings inside the same transaction as the status write is what makes the
 * check race-free.
 */
async function settleSearchIfDone(
  ctx: MutationCtx,
  searchId: Id<"searches">,
): Promise<void> {
  const siblings = await ctx.db
    .query("searchSources")
    .withIndex("by_search", (q) => q.eq("searchId", searchId))
    .take(50);

  if (siblings.some((s) => s.status === "pending" || s.status === "running")) return;

  const search = await ctx.db.get("searches", searchId);
  if (search === null || search.status === "complete") return;

  await ctx.db.patch("searches", searchId, {
    status: "complete",
    completedAt: Date.now(),
  });
}

/**
 * Force every unfinished source of a search to `failed`.
 *
 * Classified `transient` because that is the honest reading: the worker vanished,
 * which says nothing about the provider, and a re-run is the correct response.
 */
async function forceFailStalledSources(
  ctx: MutationCtx,
  searchId: Id<"searches">,
): Promise<number> {
  const rows = await ctx.db
    .query("searchSources")
    .withIndex("by_search", (q) => q.eq("searchId", searchId))
    .take(50);

  const now = Date.now();
  let swept = 0;

  for (const row of rows) {
    if (row.status !== "pending" && row.status !== "running") continue;
    swept += 1;
    await ctx.db.patch("searchSources", row._id, {
      status: "failed",
      errorKind: "transient",
      errorMessage: `The worker for ${row.label} did not report within ${Math.round(SWEEP_DELAY_MS / 1000)}s. Nothing was lost — re-run the search to try this source again.`,
      finishedAt: now,
      durationMs: row.startedAt === undefined ? undefined : now - row.startedAt,
    });
  }

  if (swept > 0) await settleSearchIfDone(ctx, searchId);
  return swept;
}

/* ------------------------------------------------------------------ mutations */

/**
 * Claim a source row for this attempt.
 *
 * Returns `null` when there is nothing to do — the row was swept, or a duplicate
 * schedule fired — which is the action's signal to exit without touching a
 * provider. Bumping `attemptCount` here rather than after the call means an
 * attempt that dies mid-flight is still counted.
 */
export const beginSourceRun = internalMutation({
  args: { searchSourceId: v.id("searchSources") },
  returns: v.union(
    v.null(),
    v.object({
      searchId: v.id("searches"),
      userId: v.id("users"),
      query: v.string(),
      source: sourceValidator,
      connectionId: v.optional(v.id("connections")),
      label: v.string(),
      attemptCount: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("searchSources", args.searchSourceId);
    if (row === null) return null;
    if (row.status !== "pending" && row.status !== "running") return null;

    const search = await ctx.db.get("searches", row.searchId);
    if (search === null) return null;

    const attemptCount = row.attemptCount + 1;
    await ctx.db.patch("searchSources", args.searchSourceId, {
      status: "running",
      startedAt: row.startedAt ?? Date.now(),
      attemptCount,
    });

    return {
      searchId: row.searchId,
      userId: row.userId,
      query: search.query,
      source: row.source,
      connectionId: row.connectionId,
      label: row.label,
      attemptCount,
    };
  },
});

/**
 * Record a transient failure that is about to be retried.
 *
 * Written mid-run so the live UI shows "attempt 2 of 3" while it is happening
 * rather than only in the post-mortem. Best-effort by design: the terminal
 * mutation writes the authoritative count, so a lost update here self-heals.
 */
export const recordRetry = internalMutation({
  args: {
    searchSourceId: v.id("searchSources"),
    attemptCount: v.number(),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("searchSources", args.searchSourceId);
    if (row === null || row.status !== "running") return null;

    await ctx.db.patch("searchSources", args.searchSourceId, {
      attemptCount: Math.max(row.attemptCount, args.attemptCount),
      errorKind: "transient",
      errorMessage: redactError(args.errorMessage),
    });
    return null;
  },
});

/**
 * Commit a successful source run: results, status, counts and the parent
 * search's completion, in one transaction.
 */
export const completeSourceRun = internalMutation({
  args: {
    searchSourceId: v.id("searchSources"),
    attemptCount: v.number(),
    durationMs: v.number(),
    results: v.array(adapterResult),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("searchSources", args.searchSourceId);
    if (row === null) return null;

    const search = await ctx.db.get("searches", row.searchId);
    if (search === null) return null;

    const now = Date.now();

    // `seq` is the arrival order the UI appends by. Seeded from the parent's
    // running count — which this mutation also advances — so it stays monotonic
    // across concurrently-finishing sources without a second read.
    const base = search.resultCount;

    for (const [index, result] of args.results.entries()) {
      await ctx.db.insert("searchResults", {
        searchId: row.searchId,
        userId: row.userId,
        source: row.source,
        externalId: result.externalId ?? result.id,
        title: result.title,
        snippet: result.snippet,
        author: result.author,
        timestamp: result.timestamp,
        url: result.url,
        seq: base + index,
        score: scoreResult(
          {
            title: result.title,
            snippet: result.snippet,
            timestamp: result.timestamp,
            source: row.source,
          },
          search.query,
          now,
        ),
        connectionId: row.connectionId,
        threadId: result.threadId,
        replyTo: result.replyTo,
        context: result.context,
        unread: result.unread,
      });
    }

    await ctx.db.patch("searchSources", args.searchSourceId, {
      status: "succeeded",
      errorKind: undefined,
      errorMessage: undefined,
      attemptCount: args.attemptCount,
      resultCount: args.results.length,
      finishedAt: now,
      durationMs: args.durationMs,
    });

    await ctx.db.patch("searches", row.searchId, {
      resultCount: base + args.results.length,
    });

    // A successful provider call is the only honest definition of "last used",
    // so it is stamped here rather than when a token is handed out.
    if (row.connectionId !== undefined) {
      const connection = await ctx.db.get("connections", row.connectionId);
      if (connection !== null) {
        await ctx.db.patch("connections", row.connectionId, { lastUsedAt: now });
      }
    }

    await settleSearchIfDone(ctx, row.searchId);
    return null;
  },
});

/**
 * Commit a failed source run.
 *
 * `needs_reconnect` is its own terminal status rather than a `failed` with a
 * kind attached, because the UI's response to it is a different button. When the
 * failure came from a grant, the connection row is flipped too — otherwise the
 * search would keep re-discovering the same dead grant and the connections
 * screen would keep claiming everything is fine.
 */
export const failSourceRun = internalMutation({
  args: {
    searchSourceId: v.id("searchSources"),
    kind: errorKindValidator,
    message: v.string(),
    attemptCount: v.number(),
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("searchSources", args.searchSourceId);
    if (row === null) return null;

    const now = Date.now();
    const message = redactError(args.message);

    await ctx.db.patch("searchSources", args.searchSourceId, {
      status: args.kind === "needs_reconnect" ? "needs_reconnect" : "failed",
      errorKind: args.kind,
      errorMessage: message,
      attemptCount: args.attemptCount,
      resultCount: 0,
      finishedAt: now,
      durationMs: args.durationMs,
    });

    if (args.kind === "needs_reconnect" && row.connectionId !== undefined) {
      const connection = await ctx.db.get("connections", row.connectionId);
      // `resolveToken` already marks a dead *refresh* token revoked. This covers
      // the other door: a 401 or a missing scope on the search call itself.
      if (connection !== null && connection.status !== "revoked") {
        await ctx.db.patch("connections", row.connectionId, {
          status: "revoked",
          statusReason: message,
          lastErrorAt: now,
          updatedAt: now,
        });
      }
    }

    await settleSearchIfDone(ctx, row.searchId);
    return null;
  },
});

/** Watchdog for one search, scheduled at dispatch time. */
export const sweepSearch = internalMutation({
  args: { searchId: v.id("searches") },
  returns: v.object({ swept: v.number() }),
  handler: async (ctx, args) => {
    return { swept: await forceFailStalledSources(ctx, args.searchId) };
  },
});

/**
 * Cron backstop, in case a scheduled `sweepSearch` never ran at all (a deploy
 * mid-fan-out, say). Belt and braces on purpose: "the spinner never stops" is
 * the one failure this system is least able to explain to a user.
 */
export const sweepStuckSearches = internalMutation({
  args: {},
  returns: v.object({ searches: v.number(), sources: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - STUCK_SEARCH_AFTER_MS;
    const stuck = await ctx.db
      .query("searches")
      .withIndex("by_status_created", (q) =>
        q.eq("status", "running").lt("createdAt", cutoff),
      )
      .take(25);

    let sources = 0;
    let searches = 0;
    for (const search of stuck) {
      // A seeded search that is still `running` is a fixture illustrating the
      // mid-flight state, not a fan-out whose workers died. Settling it would
      // erase the example.
      if (search.isSeed) continue;
      searches += 1;
      sources += await forceFailStalledSources(ctx, search._id);
      // A search whose sources are all terminal but which never flipped is
      // stuck for a different reason; settle it either way.
      await settleSearchIfDone(ctx, search._id);
    }

    return { searches, sources };
  },
});

/* --------------------------------------------------------------------- worker */

/**
 * One source, start to finish. Scheduled once per source-connection.
 *
 * Never throws: every exit path writes a terminal row, because an action that
 * throws leaves the UI with a `running` source and no explanation.
 */
export const runSource = internalAction({
  args: {
    searchSourceId: v.id("searchSources"),
    /** Demo affordance: hold this source back to show partial results. */
    artificialDelayMs: v.optional(v.number()),
    /** Demo affordance: make this source fail a specific way. */
    injectFailure: v.optional(errorKindValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const begin = await ctx.runMutation(internal.orchestrator.beginSourceRun, {
      searchSourceId: args.searchSourceId,
    });
    // Already terminal: swept, or a duplicate schedule. Not an error, and
    // deliberately not a provider call.
    if (begin === null) return null;

    const startedAt = Date.now();
    let attemptCount = begin.attemptCount;

    try {
      let accessToken: string | undefined;
      let externalAccountId: string | undefined;

      if (requiresGrant(begin.source)) {
        if (begin.connectionId === undefined) {
          throw AdapterError.permanent(
            `${begin.source} was dispatched without a connection, so there is no grant to search with.`,
          );
        }
        // The only door to a credential. Refresh, leasing and revocation
        // detection all happen behind it; this worker just gets a string.
        const token = await resolveToken(ctx, begin.connectionId);
        accessToken = token.accessToken;
        externalAccountId = token.externalAccountId;
      }

      const adapter = ADAPTERS[begin.source];

      const results = await retryTransient(
        async () => {
          // Injected before the call, not inside the adapter: the adapters stay
          // honest implementations and the fault lives with the orchestration.
          maybeInjectFailure(args.injectFailure);

          return await adapter.search(begin.query, {
            accessToken,
            externalAccountId,
            limit: RESULTS_PER_SOURCE,
            // A fresh deadline per attempt: a retry that inherited the first
            // attempt's clock would be cut off before it could help.
            signal: AbortSignal.timeout(SOURCE_DEADLINE_MS),
            artificialDelayMs: args.artificialDelayMs,
          });
        },
        {
          maxAttempts: MAX_ATTEMPTS,
          onRetry: (attempt, error) => {
            attemptCount = begin.attemptCount + attempt;
            // Fire-and-forget: `onRetry` is synchronous, and the terminal
            // mutation writes the authoritative count regardless.
            void ctx
              .runMutation(internal.orchestrator.recordRetry, {
                searchSourceId: args.searchSourceId,
                attemptCount,
                errorMessage: `${error.message} — retrying (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`,
              })
              .catch(() => undefined);
          },
        },
      );

      await ctx.runMutation(internal.orchestrator.completeSourceRun, {
        searchSourceId: args.searchSourceId,
        attemptCount,
        durationMs: Date.now() - startedAt,
        results: results.slice(0, RESULTS_PER_SOURCE).map((result) => ({
          id: result.id,
          title: result.title,
          snippet: result.snippet,
          author: result.author,
          timestamp: result.timestamp,
          url: result.url,
          externalId: result.externalId,
          threadId: result.threadId,
          replyTo: result.replyTo,
          context: result.context,
          unread: result.unread,
        })),
      });
    } catch (err) {
      const error = toAdapterError(err);
      await ctx.runMutation(internal.orchestrator.failSourceRun, {
        searchSourceId: args.searchSourceId,
        kind: error.kind,
        // The provider's own words, plus its body when it sent one. Redaction
        // happens in the mutation, at the point of storage.
        message:
          error.detail === undefined
            ? error.message
            : `${error.message} — ${error.detail}`,
        attemptCount,
        durationMs: Date.now() - startedAt,
      });
    }

    return null;
  },
});
