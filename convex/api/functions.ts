/**
 * The database half of the REST surface.
 *
 * Every one of these is `internal`: the authorization boundary is the API-key
 * check in `routes.ts`, and these functions take the `userId` it resolved. That
 * is the same arrangement the Clerk-authenticated public functions have with
 * `requireUser`, one layer down — two shells, one core, so "search and send
 * entirely through the API" is true by construction rather than by a parallel
 * implementation that has to be kept honest.
 *
 * Ids arrive as **strings** from a URL path, not as `v.id(...)`. A malformed id
 * therefore has to be handled rather than crash the argument validator, and
 * `resolveId` answers it with the same 404 a stranger's row gets: a client that
 * cannot tell "no such id" from "not yours" cannot enumerate either.
 */

import { v } from "convex/values";
import type { GenericId } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { DataModel, Doc, Id, TableNames } from "../_generated/dataModel";
import { appError } from "../core/errors";
import { confirmDraft, createDraft, draftDigest, requireOwnDraft } from "../drafts";
import { claimSend, retrySend } from "../sends";
import { consume } from "../limits";
import { channel as channelValidator, source as sourceValidator } from "../schema";
import { dispatchSearch, normalizeQuery, sourcesOfSearch } from "../searches";
import {
  apiAttempt,
  apiConnection,
  apiDraft,
  apiSearch,
  apiSend,
  apiSourceRun,
  publicResult,
  toApiAttempt,
  toApiConnection,
  toApiDraft,
  toApiSearch,
  toApiSend,
  toApiSourceRun,
  toPublicResult,
} from "./views";

/** Bound on every list this API returns. */
const LIST_LIMIT = 50;
/** Bound on results per search. Matches what the reactive view reads. */
const RESULT_LIMIT = 200;
/** Bound on the attempt timeline. */
const ATTEMPT_LIMIT = 32;

/**
 * Turn a path segment into a real id, or refuse.
 *
 * `normalizeId` rejects ids that were minted for a different table, so
 * `/sends/{a-draft-id}` is a 404 rather than a confusing internal error.
 */
function resolveId<T extends TableNames>(
  ctx: QueryCtx | MutationCtx,
  table: T,
  raw: string,
): GenericId<T> {
  const id = ctx.db.normalizeId(table, raw);
  if (id === null) throw appError("NOT_FOUND", `No ${table} record with that id.`);
  return id as GenericId<T>;
}

/** Read a row and prove it is the caller's, answering 404 when it is not. */
async function own<T extends keyof DataModel & TableNames>(
  ctx: QueryCtx | MutationCtx,
  table: T,
  id: Id<T>,
  userId: Id<"users">,
): Promise<Doc<T>> {
  const row = await ctx.db.get(table, id);
  if (row === null || (row as { userId?: Id<"users"> }).userId !== userId) {
    throw appError("NOT_FOUND", `No ${table} record with that id.`);
  }
  return row;
}

/* ------------------------------------------------------------------- searches */

/** `POST /searches`. Rate-limited as a fan-out, not as a write. */
export const createSearch = internalMutation({
  args: {
    userId: v.id("users"),
    query: v.string(),
    sources: v.optional(v.array(sourceValidator)),
  },
  returns: v.object({ searchId: v.id("searches") }),
  handler: async (ctx, args) => {
    await consume(ctx, "search", args.userId);
    const searchId = await dispatchSearch(ctx, {
      userId: args.userId,
      query: normalizeQuery(args.query),
      sources: args.sources ?? ["gmail", "slack", "web"],
      // Recorded as `api`, so history shows which searches a script ran.
      origin: "api",
    });
    return { searchId };
  },
});

/**
 * `POST /searches/{id}/rerun`. A **new** search with `rerun_of` set, never an
 * overwrite: history that mutates under you is not history.
 */
export const rerunSearch = internalMutation({
  args: { userId: v.id("users"), searchId: v.string() },
  returns: v.object({ searchId: v.id("searches") }),
  handler: async (ctx, args) => {
    await consume(ctx, "search", args.userId);
    const originalId = resolveId(ctx, "searches", args.searchId);
    const original = await own(ctx, "searches", originalId, args.userId);

    const searchId = await dispatchSearch(ctx, {
      userId: args.userId,
      query: original.query,
      sources: await sourcesOfSearch(ctx, originalId),
      origin: "api",
      rerunOf: originalId,
    });
    return { searchId };
  },
});

export const listSearches = internalQuery({
  args: { userId: v.id("users") },
  returns: v.array(apiSearch),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("searches")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(LIST_LIMIT);
    return rows.map(toApiSearch);
  },
});

/** `GET /searches/{id}` — the search and every source's status, which is how a
 *  polling client learns that two of five accounts have already answered. */
export const getSearch = internalQuery({
  args: { userId: v.id("users"), searchId: v.string() },
  returns: v.object({ search: apiSearch, sources: v.array(apiSourceRun) }),
  handler: async (ctx, args) => {
    const searchId = resolveId(ctx, "searches", args.searchId);
    const search = await own(ctx, "searches", searchId, args.userId);

    const sources = await ctx.db
      .query("searchSources")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .take(LIST_LIMIT);

    return { search: toApiSearch(search), sources: sources.map(toApiSourceRun) };
  },
});

/**
 * `GET /searches/{id}/results`.
 *
 * `rank` is the default because an API consumer has no scroll position to
 * protect — it wants the best results first. `arrival` exists because a client
 * polling a running search wants append-only order, which re-ranking would
 * break.
 */
export const getResults = internalQuery({
  args: {
    userId: v.id("users"),
    searchId: v.string(),
    order: v.union(v.literal("rank"), v.literal("arrival")),
  },
  returns: v.object({
    search_id: v.id("searches"),
    status: v.union(v.literal("running"), v.literal("complete")),
    order: v.union(v.literal("rank"), v.literal("arrival")),
    /** True while at least one source is still working: the results are partial. */
    partial: v.boolean(),
    count: v.number(),
    results: v.array(publicResult),
  }),
  handler: async (ctx, args) => {
    const searchId = resolveId(ctx, "searches", args.searchId);
    const search = await own(ctx, "searches", searchId, args.userId);

    const rows = await ctx.db
      .query("searchResults")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .take(RESULT_LIMIT);

    // `score` was computed at write time by `core/rank.ts`; ranking here is just
    // a sort, with arrival order as the tie-break so the output is deterministic
    // rather than merely sorted.
    const ordered = [...rows].sort((a, b) =>
      args.order === "arrival" ? a.seq - b.seq : b.score - a.score || a.seq - b.seq,
    );

    return {
      search_id: searchId,
      status: search.status,
      order: args.order,
      partial: search.status === "running",
      count: ordered.length,
      // The projection, and the reason this route is worth a test: seven fields,
      // no enrichment, whatever the table grows.
      results: ordered.map(toPublicResult),
    };
  },
});

/* --------------------------------------------------------------------- drafts */

/** `POST /drafts`. Creating a draft is the only way a message comes to exist. */
export const createDraftForApi = internalMutation({
  args: {
    userId: v.id("users"),
    channel: channelValidator,
    connectionId: v.string(),
    to: v.string(),
    subject: v.optional(v.string()),
    body: v.string(),
    idempotencyKey: v.optional(v.string()),
    replyToResultId: v.optional(v.string()),
  },
  returns: v.object({ draft: apiDraft, reused: v.boolean() }),
  handler: async (ctx, args) => {
    await consume(ctx, "restWrite", args.userId);

    const connectionId = resolveId(ctx, "connections", args.connectionId);

    // Replying to a result carries the thread over, which is what makes an API
    // reply land in the same conversation a UI reply would.
    let replyToResultId: Id<"searchResults"> | undefined;
    let replyToExternalId: string | undefined;
    let threadId: string | undefined;
    if (args.replyToResultId !== undefined) {
      replyToResultId = resolveId(ctx, "searchResults", args.replyToResultId);
      const result = await own(ctx, "searchResults", replyToResultId, args.userId);
      replyToExternalId = result.externalId;
      threadId = result.threadId;
    }

    const { draft, reused } = await createDraft(ctx, {
      userId: args.userId,
      channel: args.channel,
      connectionId,
      to: args.to,
      subject: args.subject,
      body: args.body,
      idempotencyKey: args.idempotencyKey,
      replyToResultId,
      replyToExternalId,
      threadId,
    });

    const row = await own(ctx, "drafts", draft.id, args.userId);
    return { draft: toApiDraft(row, await draftDigest(row)), reused };
  },
});

/** `GET /drafts/{id}` — including the digest `confirm` will demand back. */
export const getDraft = internalQuery({
  args: { userId: v.id("users"), draftId: v.string() },
  returns: apiDraft,
  handler: async (ctx, args) => {
    const draftId = resolveId(ctx, "drafts", args.draftId);
    const draft = await own(ctx, "drafts", draftId, args.userId);
    return toApiDraft(draft, await draftDigest(draft));
  },
});

/** `POST /drafts/{id}/confirm`. */
export const confirmDraftForApi = internalMutation({
  args: { userId: v.id("users"), draftId: v.string(), reviewedHash: v.string() },
  returns: apiDraft,
  handler: async (ctx, args) => {
    await consume(ctx, "restWrite", args.userId);
    const draftId = resolveId(ctx, "drafts", args.draftId);
    await confirmDraft(ctx, {
      userId: args.userId,
      draftId,
      reviewedHash: args.reviewedHash,
    });
    const draft = await own(ctx, "drafts", draftId, args.userId);
    return toApiDraft(draft, await draftDigest(draft));
  },
});

/**
 * `POST /drafts/{id}/send`.
 *
 * The extra hoop over the UI path is `acknowledgedDestination`: the caller has to
 * write down where this is going, in the recipient's exact stored form, in the
 * request that sends it. A confirmed draft plus a blind `POST` is not enough.
 * That is the API's share of the confirm friction — the criterion says the
 * *system* must make accidental sends hard, and an agent driving the REST API is
 * exactly the caller most likely to fire one.
 *
 * The check is `!==` on the stored recipient, with no trimming or case folding,
 * because "verbatim" is the only version of this rule that cannot be argued with.
 */
export const claimForApi = internalMutation({
  args: {
    userId: v.id("users"),
    draftId: v.string(),
    acknowledgedDestination: v.string(),
  },
  returns: v.object({
    sendId: v.id("sends"),
    claimed: v.boolean(),
    send: apiSend,
  }),
  handler: async (ctx, args) => {
    await consume(ctx, "restWrite", args.userId);
    const draftId = resolveId(ctx, "drafts", args.draftId);
    const draft = await requireOwnDraft(ctx, args.userId, draftId);

    if (args.acknowledgedDestination !== draft.to) {
      throw appError(
        "DESTINATION_NOT_ACKNOWLEDGED",
        `acknowledged_destination must match the draft's recipient exactly. This draft is addressed to ${draft.to}.`,
      );
    }

    const { sendId, claimed } = await claimSend(ctx, { userId: args.userId, draftId });
    const send = await own(ctx, "sends", sendId, args.userId);
    return { sendId, claimed, send: toApiSend(send) };
  },
});

/* ---------------------------------------------------------------------- sends */

export const listSends = internalQuery({
  args: { userId: v.id("users") },
  returns: v.array(apiSend),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("sends")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(LIST_LIMIT);
    return rows.map(toApiSend);
  },
});

/** `GET /sends/{id}` — the send plus every attempt, which is the whole story:
 *  what was tried, when, how it failed, and whether a retry is even legal. */
export const getSend = internalQuery({
  args: { userId: v.id("users"), sendId: v.string() },
  returns: v.object({ send: apiSend, attempts: v.array(apiAttempt) }),
  handler: async (ctx, args) => {
    const sendId = resolveId(ctx, "sends", args.sendId);
    const send = await own(ctx, "sends", sendId, args.userId);

    const attempts = await ctx.db
      .query("sendAttempts")
      .withIndex("by_send", (q) => q.eq("sendId", sendId))
      .take(ATTEMPT_LIMIT);

    return {
      send: toApiSend(send),
      attempts: attempts
        .sort((a, b) => a.attemptNumber - b.attemptNumber || a.startedAt - b.startedAt)
        .map(toApiAttempt),
    };
  },
});

/** `GET /sends/{id}` without the attempts, for the send route's bounded poll. */
export const sendStatus = internalQuery({
  args: { userId: v.id("users"), sendId: v.id("sends") },
  returns: v.union(v.null(), apiSend),
  handler: async (ctx, args) => {
    const send = await ctx.db.get("sends", args.sendId);
    if (send === null || send.userId !== args.userId) return null;
    return toApiSend(send);
  },
});

export const retryForApi = internalMutation({
  args: { userId: v.id("users"), sendId: v.string() },
  returns: v.object({
    retried: v.boolean(),
    reason: v.optional(v.string()),
    send: apiSend,
  }),
  handler: async (ctx, args) => {
    await consume(ctx, "restWrite", args.userId);
    const sendId = resolveId(ctx, "sends", args.sendId);
    const outcome = await retrySend(ctx, { userId: args.userId, sendId });
    const send = await own(ctx, "sends", sendId, args.userId);
    return { retried: outcome.retried, reason: outcome.reason, send: toApiSend(send) };
  },
});

/* ---------------------------------------------------------------- connections */

/** `GET /connections`. What an agent needs to pick a `connection_id` to send on. */
export const listConnections = internalQuery({
  args: { userId: v.id("users") },
  returns: v.array(apiConnection),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("connections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(100);
    return rows.sort((a, b) => a.createdAt - b.createdAt).map(toApiConnection);
  },
});
