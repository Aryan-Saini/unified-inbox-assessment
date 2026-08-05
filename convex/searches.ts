/**
 * Searches: dispatch, and the reactive view of a fan-out in progress.
 *
 * The interesting decision here is that a search is dispatched **per connection,
 * not per source**. Two Gmail accounts and three Slack workspaces are five
 * independent workers with five independent rows, five statuses and five error
 * messages — so "Gmail worked but the second account's grant is dead" is
 * expressible, which it would not be if a source were the unit of work. The UI
 * folds the rows back into per-source strips (`useSearch.ts`); the truth
 * underneath stays per-account.
 *
 * Everything a client needs while the fan-out runs comes from one reactive query,
 * `watch`. There is no polling and no SSE: Convex pushes the new rows as each
 * worker commits, which is what makes partial results fall out of the design
 * rather than being bolted onto it.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { webSourceLabel } from "./adapters/web";
import { appError } from "./core/errors";
import { faultInjectionEnabled } from "./core/faults";
import type { Source } from "./core/types";
import { consume } from "./limits";
import { SWEEP_DELAY_MS } from "./orchestrator";
import { errorKind as errorKindValidator, source as sourceValidator } from "./schema";
import { optionalUser, requireUser } from "./users";

const ALL_SOURCES: Source[] = ["gmail", "slack", "web"];

/** Longest query we will accept. Providers reject far longer strings anyway, and
 *  an unbounded one is a cheap way to bloat every row that quotes it. */
const MAX_QUERY_LENGTH = 512;

/** How many searches the sidebar shows. Bounded, per the Convex guidelines. */
const HISTORY_LIMIT = 50;

/**
 * Demo controls. Honoured only when the deployment sets
 * `ALLOW_FAULT_INJECTION=true`, and silently ignored otherwise — a demo flag
 * left in a client build must not be able to break a real search.
 *
 * Keyed by source name. `v.record` cannot take literal keys, so the key type is
 * `string` and unknown keys are simply never looked up — a wrong key is inert
 * rather than an error, which is the right failure mode for a demo control.
 */
const demoOptions = v.object({
  /** Hold a source back this long before it does any work. */
  delayMs: v.optional(v.record(v.string(), v.number())),
  /** Make a source fail this way instead of returning results. */
  injectFailure: v.optional(v.record(v.string(), errorKindValidator)),
});

const searchStatus = v.union(v.literal("running"), v.literal("complete"));

const sourceRunStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("needs_reconnect"),
);

const searchView = v.object({
  id: v.id("searches"),
  query: v.string(),
  status: searchStatus,
  origin: v.union(v.literal("ui"), v.literal("api"), v.literal("seed")),
  resultCount: v.number(),
  archived: v.boolean(),
  isSeed: v.boolean(),
  rerunOf: v.optional(v.id("searches")),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
});

const sourceRunView = v.object({
  id: v.id("searchSources"),
  source: sourceValidator,
  connectionId: v.optional(v.id("connections")),
  label: v.string(),
  status: sourceRunStatus,
  errorKind: v.optional(errorKindValidator),
  errorMessage: v.optional(v.string()),
  attemptCount: v.number(),
  resultCount: v.number(),
  durationMs: v.optional(v.number()),
});

const resultView = v.object({
  id: v.id("searchResults"),
  source: sourceValidator,
  externalId: v.string(),
  title: v.string(),
  snippet: v.string(),
  author: v.optional(v.string()),
  timestamp: v.optional(v.string()),
  url: v.string(),
  seq: v.number(),
  score: v.number(),
  connectionId: v.optional(v.id("connections")),
  threadId: v.optional(v.string()),
  replyTo: v.optional(v.string()),
  context: v.optional(v.string()),
  unread: v.optional(v.boolean()),
});

/* -------------------------------------------------------------------- dispatch */

/**
 * Trim and bound a query string. Exported so the REST shell rejects the same
 * inputs the UI does, with the same message — two validators would eventually
 * disagree, and the one that disagreed by accepting would be the bug.
 */
export function normalizeQuery(raw: string): string {
  const query = raw.trim();
  if (query === "") throw appError("BAD_REQUEST", "A search needs a query.");
  if (query.length > MAX_QUERY_LENGTH) {
    throw appError(
      "BAD_REQUEST",
      `A query cannot be longer than ${MAX_QUERY_LENGTH} characters.`,
    );
  }
  return query;
}

/** The sources a rerun should re-ask, taken from the original's own runs. */
export async function sourcesOfSearch(
  ctx: MutationCtx,
  searchId: Id<"searches">,
): Promise<Source[]> {
  const rows = await ctx.db
    .query("searchSources")
    .withIndex("by_search", (q) => q.eq("searchId", searchId))
    .take(50);
  const sources = [...new Set(rows.map((row) => row.source))];
  return sources.length > 0 ? sources : ALL_SOURCES;
}

/** Read one key out of a demo record without trusting the key to be present. */
function demoValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export interface DispatchArgs {
  userId: Id<"users">;
  query: string;
  sources: Source[];
  origin: Doc<"searches">["origin"];
  rerunOf?: Id<"searches">;
  demo?: {
    delayMs?: Record<string, number>;
    injectFailure?: Record<string, Doc<"searchSources">["errorKind"]>;
  };
}

/**
 * Create a search and schedule its workers.
 *
 * A plain function rather than a mutation so `run` and `rerun` share one code
 * path — a second dispatcher that drifted from this one would be the easiest
 * possible way to make reruns behave subtly differently from runs.
 */
export async function dispatchSearch(
  ctx: MutationCtx,
  args: DispatchArgs,
): Promise<Id<"searches">> {
  const now = Date.now();
  const demo = faultInjectionEnabled() ? args.demo : undefined;

  const searchId = await ctx.db.insert("searches", {
    userId: args.userId,
    query: args.query,
    status: "running",
    origin: args.origin,
    rerunOf: args.rerunOf,
    resultCount: 0,
    isSeed: false,
    createdAt: now,
  });

  const connections = await ctx.db
    .query("connections")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .take(100);

  interface Target {
    source: Source;
    label: string;
    connectionId?: Id<"connections">;
  }
  const targets: Target[] = [];

  for (const source of ALL_SOURCES) {
    if (!args.sources.includes(source)) continue;

    if (source === "web") {
      targets.push({ source, label: webSourceLabel() });
      continue;
    }

    // `enabled`, not `status === "active"`: a broken account the user has left
    // switched on keeps reporting its error, which is how a revoked grant stays
    // visible (and reconnectable) instead of quietly vanishing from the fan-out.
    // A disconnected account is `enabled: false` and so drops out here.
    for (const connection of connections) {
      if (connection.provider !== source || !connection.enabled) continue;
      targets.push({
        source,
        label: connection.label,
        connectionId: connection._id,
      });
    }
  }

  for (const target of targets) {
    const searchSourceId = await ctx.db.insert("searchSources", {
      searchId,
      userId: args.userId,
      source: target.source,
      connectionId: target.connectionId,
      // Denormalised so history still reads correctly after a connection is
      // relabelled or disconnected.
      label: target.label,
      status: "pending",
      attemptCount: 0,
      resultCount: 0,
    });

    // One independent action per source-connection. `runAfter(0)` rather than a
    // loop inside one action: separate scheduled functions are separate failure
    // domains, and that is the entire concurrency guarantee.
    await ctx.scheduler.runAfter(0, internal.orchestrator.runSource, {
      searchSourceId,
      artificialDelayMs: demoValue(demo?.delayMs, target.source),
      injectFailure: demoValue(demo?.injectFailure, target.source),
    });
  }

  if (targets.length === 0) {
    // Nothing to wait for. Completing immediately is better than leaving a
    // `running` search with no workers for the sweeper to find in 25 seconds.
    await ctx.db.patch("searches", searchId, {
      status: "complete",
      completedAt: now,
    });
    return searchId;
  }

  // The watchdog. Scheduled at dispatch time, so it exists even if every worker
  // dies before writing anything.
  await ctx.scheduler.runAfter(SWEEP_DELAY_MS, internal.orchestrator.sweepSearch, {
    searchId,
  });

  return searchId;
}

/* ---------------------------------------------------------------- public API */

/**
 * Start a fan-out. Returns as soon as the workers are scheduled — the results
 * arrive through `watch`, which is the point.
 */
export const run = mutation({
  args: {
    query: v.string(),
    /** Restrict the fan-out. Omitted means every source. */
    sources: v.optional(v.array(sourceValidator)),
    demo: v.optional(demoOptions),
  },
  returns: v.object({ searchId: v.id("searches") }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    // Before any work: one search is up to five provider calls, and the quota it
    // spends belongs to the user's real accounts.
    await consume(ctx, "search", user._id);

    const query = normalizeQuery(args.query);

    const searchId = await dispatchSearch(ctx, {
      userId: user._id,
      query,
      sources: args.sources ?? ALL_SOURCES,
      origin: "ui",
      demo: args.demo,
    });

    return { searchId };
  },
});

/**
 * Re-run an earlier search as a **new** search.
 *
 * Deliberately not "run it again in place": overwriting the old rows would
 * destroy the history the sidebar exists to show, and would make "this search
 * found 14 results at 09:12" unverifiable ten minutes later. `rerunOf` keeps the
 * lineage.
 */
export const rerun = mutation({
  args: { searchId: v.id("searches"), demo: v.optional(demoOptions) },
  returns: v.object({ searchId: v.id("searches") }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await consume(ctx, "search", user._id);

    const original = await ctx.db.get("searches", args.searchId);
    if (original === null || original.userId !== user._id) {
      throw appError("NOT_FOUND", "That search does not exist.");
    }

    // The original's source list, not today's connections: a rerun re-asks the
    // same question, and which accounts answer it is settled by dispatch.
    const searchId = await dispatchSearch(ctx, {
      userId: user._id,
      query: original.query,
      sources: await sourcesOfSearch(ctx, args.searchId),
      origin: "ui",
      rerunOf: original._id,
      demo: args.demo,
    });

    return { searchId };
  },
});

/** Soft-hide a search from the sidebar. The row and its results are kept. */
export const setArchived = mutation({
  args: { searchId: v.id("searches"), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const search = await ctx.db.get("searches", args.searchId);
    if (search === null || search.userId !== user._id) {
      throw new Error("That search does not exist.");
    }

    await ctx.db.patch("searches", args.searchId, {
      archivedAt: args.archived ? Date.now() : undefined,
    });
    return null;
  },
});

/**
 * The live view of one search: the search, every source run, every result so far.
 *
 * One query rather than three so a subscriber cannot render a torn state — new
 * results with a stale source status, for instance, which is exactly what makes
 * a streaming list look broken.
 *
 * Results come back in `seq` (arrival) order. Re-sorting by score on the way out
 * would shuffle rows under the reader's cursor as later sources land; the score
 * is on every row for the consumers that want ranking instead.
 */
export const watch = query({
  args: { searchId: v.id("searches") },
  returns: v.union(
    v.null(),
    v.object({
      search: searchView,
      sources: v.array(sourceRunView),
      results: v.array(resultView),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await optionalUser(ctx);
    if (user === null) return null;

    const search = await ctx.db.get("searches", args.searchId);
    // Not-found and not-yours are the same answer: distinguishing them confirms
    // the existence of someone else's search.
    if (search === null || search.userId !== user._id) return null;

    const sources = await ctx.db
      .query("searchSources")
      .withIndex("by_search", (q) => q.eq("searchId", args.searchId))
      .take(50);

    const results = await ctx.db
      .query("searchResults")
      .withIndex("by_search", (q) => q.eq("searchId", args.searchId))
      .take(200);

    return {
      search: {
        id: search._id,
        query: search.query,
        status: search.status,
        origin: search.origin,
        resultCount: search.resultCount,
        archived: search.archivedAt !== undefined,
        isSeed: search.isSeed,
        rerunOf: search.rerunOf,
        createdAt: search.createdAt,
        completedAt: search.completedAt,
      },
      sources: sources
        .sort((a, b) => ALL_SOURCES.indexOf(a.source) - ALL_SOURCES.indexOf(b.source))
        .map((row) => ({
          id: row._id,
          source: row.source,
          connectionId: row.connectionId,
          label: row.label,
          status: row.status,
          errorKind: row.errorKind,
          errorMessage: row.errorMessage,
          attemptCount: row.attemptCount,
          resultCount: row.resultCount,
          durationMs: row.durationMs,
        })),
      results: results
        .sort((a, b) => a.seq - b.seq)
        .map((row) => ({
          id: row._id,
          source: row.source,
          externalId: row.externalId,
          title: row.title,
          snippet: row.snippet,
          author: row.author,
          timestamp: row.timestamp,
          url: row.url,
          seq: row.seq,
          score: row.score,
          connectionId: row.connectionId,
          threadId: row.threadId,
          replyTo: row.replyTo,
          context: row.context,
          unread: row.unread,
        })),
    };
  },
});

/**
 * The sidebar's history: newest first, bounded, with each row's outcome summary.
 *
 * The per-search source read is what lets a settled row say "gmail, slack" and
 * flag a degraded run. It costs one small indexed read per search, which is why
 * the list is capped rather than paginated — fifty rows is more history than the
 * sidebar can show anyway.
 */
export const history = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("searches"),
      query: v.string(),
      status: searchStatus,
      resultCount: v.number(),
      /** Sources that actually returned results, for the row's badge list. */
      sources: v.array(sourceValidator),
      /** True when a source ended `failed` or `needs_reconnect`. */
      degraded: v.boolean(),
      archived: v.boolean(),
      isSeed: v.boolean(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const user = await optionalUser(ctx);
    if (user === null) return [];

    const searches = await ctx.db
      .query("searches")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(HISTORY_LIMIT);

    const rows = [];
    for (const search of searches) {
      const sources = await ctx.db
        .query("searchSources")
        .withIndex("by_search", (q) => q.eq("searchId", search._id))
        .take(50);

      rows.push({
        id: search._id,
        query: search.query,
        status: search.status,
        resultCount: search.resultCount,
        sources: [
          ...new Set(
            sources.filter((s) => s.status === "succeeded").map((s) => s.source),
          ),
        ],
        degraded: sources.some(
          (s) => s.status === "failed" || s.status === "needs_reconnect",
        ),
        archived: search.archivedAt !== undefined,
        isSeed: search.isSeed,
        createdAt: search.createdAt,
      });
    }

    return rows;
  },
});
