import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Every source the adapter registry can fan out to. */
export const source = v.union(
  v.literal("gmail"),
  v.literal("slack"),
  v.literal("web"),
);

/** Sources you can send *through*. The web adapter is read-only. */
export const channel = v.union(v.literal("gmail"), v.literal("slack"));

/** Providers that require an OAuth grant. Mirrors `channel` today, but the two
 *  are separate concepts: a future read-only provider would be here and not
 *  in `channel`. */
export const provider = v.union(v.literal("gmail"), v.literal("slack"));

/**
 * How a failure should be treated. This drives every retry decision in the
 * system, so it is stored rather than re-derived: the operator sees the same
 * classification the retry loop acted on.
 *
 *  transient       — flaky network, 5xx, rate limit. Auto-retried with backoff.
 *  permanent       — invalid recipient, bad request, quota exhausted. Never
 *                    auto-retried; a human decides.
 *  needs_reconnect — the grant is revoked or expired. Routed to reconnect
 *                    rather than surfaced as a generic failure.
 *  unknown         — the call left in-flight (timeout, crash) with no
 *                    confirmation either way. Never auto-retried, because a
 *                    blind retry here is exactly how you double-send.
 */
export const errorKind = v.union(
  v.literal("transient"),
  v.literal("permanent"),
  v.literal("needs_reconnect"),
  v.literal("unknown"),
);

export const connectionStatus = v.union(
  v.literal("active"),
  v.literal("expired"),
  v.literal("errored"),
  v.literal("revoked"),
);

export default defineSchema({
  // One row per Clerk user. `clerkUserId` is the stable identity that every
  // connection, search and draft hangs off, so a reconnect never orphans state.
  users: defineTable({
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  }).index("by_clerk_user_id", ["clerkUserId"]),

  /**
   * One row per OAuth grant — a user may hold several per provider (two Gmail
   * accounts, three Slack workspaces).
   *
   * Identity is `(userId, provider, externalAccountId)`, never the row id alone.
   * Reconnect upserts on that triple so the `_id` survives, which is what keeps
   * drafts and history pointing at a live connection after re-granting.
   */
  connections: defineTable({
    userId: v.id("users"),
    provider,
    /** Stable provider-side identity: Gmail address, or `T123:U456` for Slack. */
    externalAccountId: v.string(),
    /** Human label for the UI: the email address or workspace name. */
    label: v.string(),
    accountEmail: v.optional(v.string()),
    teamName: v.optional(v.string()),

    status: connectionStatus,
    /** Why it is not active. Shown verbatim to the operator. */
    statusReason: v.optional(v.string()),

    /**
     * Whether this account participates in a fan-out. Deliberately independent
     * of `status`: a healthy account can be switched off by its owner, and a
     * broken one can stay switched on (it will keep reporting its error).
     */
    enabled: v.boolean(),

    scopes: v.array(v.string()),

    /** AES-GCM ciphertext. Plaintext tokens never touch the database. */
    accessTokenCipher: v.string(),
    refreshTokenCipher: v.optional(v.string()),
    /** Epoch ms. Absent for tokens that do not expire (Slack user tokens). */
    tokenExpiresAt: v.optional(v.number()),

    /**
     * Single-flight refresh lease. Epoch ms until which one worker owns the
     * right to exchange the refresh token; other workers wait and re-read
     * instead of racing the provider (a rotating refresh token would be lost by
     * the loser of that race).
     */
    refreshLockedUntil: v.optional(v.number()),

    lastRefreshedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    lastErrorAt: v.optional(v.number()),

    /** Seeded fixtures are marked so the UI can label them as demo data. */
    isSeed: v.boolean(),
    /**
     * Set when the user removed an account whose history cannot be deleted.
     *
     * `connections.remove` deletes the row outright when nothing points at it.
     * When a draft or send does, the row has to survive to keep the outbox
     * answerable, so it is emptied of tokens and hidden instead — absent from
     * `connections.list`, and so indistinguishable from gone.
     */
    hiddenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_provider_account", [
      "userId",
      "provider",
      "externalAccountId",
    ]),

  /**
   * Short-lived CSRF state for an in-flight OAuth redirect. Also carries the
   * connection being reconnected, so the callback upserts the existing row
   * instead of creating a duplicate.
   */
  oauthStates: defineTable({
    state: v.string(),
    userId: v.id("users"),
    provider,
    /** Set when this is a reconnect rather than a first-time connect. */
    reconnectConnectionId: v.optional(v.id("connections")),
    /** Where to bounce the browser once the callback completes. */
    returnTo: v.optional(v.string()),
    /**
     * The origin `returnTo` is resolved against, fixed when the flow started.
     *
     * Set only when the browser proposed an origin this deployment allows
     * (`resolveAppOrigin`), so the frontend's port can move without the callback
     * losing track of it. Absent means fall back to `APP_BASE_URL`.
     */
    appOrigin: v.optional(v.string()),
    /** PKCE verifier; Google supports it and there is no reason not to use it. */
    codeVerifier: v.optional(v.string()),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  }).index("by_state", ["state"]),

  /** One row per fan-out. Status is derived from its `searchSources` children. */
  searches: defineTable({
    userId: v.id("users"),
    query: v.string(),
    /** `running` until every source has settled, then `complete`. */
    status: v.union(v.literal("running"), v.literal("complete")),
    /** Where the search came from, for history legibility. */
    origin: v.union(v.literal("ui"), v.literal("api"), v.literal("seed")),
    /** Set when this search is a re-run of an earlier one. */
    rerunOf: v.optional(v.id("searches")),
    resultCount: v.number(),
    /** Soft-hide from the sidebar. Set rather than deleted so history is kept. */
    archivedAt: v.optional(v.number()),
    isSeed: v.boolean(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    // The stuck-search cron asks "which searches are still running and old?".
    // Without this index that is a full table scan on a table that only grows.
    .index("by_status_created", ["status", "createdAt"]),

  /**
   * Per-adapter run record — one per source per search. This is the table that
   * makes partial results honest: the UI subscribes to it and can say exactly
   * which sources are still working, which failed, and why.
   */
  searchSources: defineTable({
    searchId: v.id("searches"),
    userId: v.id("users"),
    source,
    /** Absent for `web`, which needs no grant. */
    connectionId: v.optional(v.id("connections")),
    /** Denormalised so history reads correctly even if the connection is gone. */
    label: v.string(),

    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("needs_reconnect"),
    ),
    errorKind: v.optional(errorKind),
    errorMessage: v.optional(v.string()),

    attemptCount: v.number(),
    resultCount: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
  })
    .index("by_search", ["searchId"])
    .index("by_user", ["userId"]),

  /**
   * A normalised result. These columns *are* the public `Result` shape — a
   * consumer renders the list without knowing which adapter produced a row.
   */
  searchResults: defineTable({
    searchId: v.id("searches"),
    userId: v.id("users"),
    source,
    /** Provider-side id: Gmail message id, Slack `ts`, or web result URL hash. */
    externalId: v.string(),
    title: v.string(),
    snippet: v.string(),
    author: v.optional(v.string()),
    /** ISO 8601. Optional because web results often carry no reliable date. */
    timestamp: v.optional(v.string()),
    url: v.string(),

    /**
     * Arrival order within a search, assigned at write time. `_creationTime`
     * is not enough: two results committed in the same mutation share it, and
     * ties are not ordered, so "append, never re-sort" needs an explicit
     * sequence to be stable.
     */
    seq: v.number(),
    /** Merge-layer ranking score. Higher sorts first. */
    score: v.number(),
    /** Lets "reply to this result" resolve which grant to send through. */
    connectionId: v.optional(v.id("connections")),
    /** Provider thread, when replying should stay in-thread. */
    threadId: v.optional(v.string()),

    /* Adapter extras. Enriched columns the UI may render; the REST projection
       strips them so the public `Result` stays exactly the spec's 7 fields. */
    /** Where a reply would go — sender address, or Slack channel id. */
    replyTo: v.optional(v.string()),
    /** Thread/channel context line, e.g. "#deals · 12 replies". */
    context: v.optional(v.string()),
    unread: v.optional(v.boolean()),
  }).index("by_search", ["searchId"]),

  /**
   * A composed but not-yet-sent message. Nothing leaves the system without one.
   *
   * `confirmationHash` is the heart of the confirm gate: it is a digest of the
   * exact payload shown to the user at confirm time. The send re-derives it and
   * refuses if the body changed after confirmation, so "confirm then mutate"
   * cannot smuggle different content out.
   */
  drafts: defineTable({
    userId: v.id("users"),
    channel,
    connectionId: v.id("connections"),
    /** Email address, or Slack channel id. */
    to: v.string(),
    /** Friendly form of `to` for the confirm screen: name or #channel. */
    toLabel: v.optional(v.string()),
    subject: v.optional(v.string()),
    body: v.string(),

    /** Caller-supplied or generated. The dedupe key carried through to `sends`. */
    idempotencyKey: v.string(),

    status: v.union(
      v.literal("draft"),
      v.literal("confirmed"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    /**
     * Bumped on every edit and folded into the confirmation digest. Without it,
     * editing A → B → A would make a stale confirmation of "A" valid again.
     */
    revision: v.number(),
    confirmationHash: v.optional(v.string()),
    confirmedAt: v.optional(v.number()),

    /**
     * Demo affordance: make the next delivery attempt fail this way. Inert
     * unless `ALLOW_FAULT_INJECTION=true`, and every injected failure is
     * recorded with a `[simulated]` prefix.
     */
    injectFailure: v.optional(errorKind),

    /** Set when the draft is a reply to a search result. */
    replyToResultId: v.optional(v.id("searchResults")),
    replyToExternalId: v.optional(v.string()),
    threadId: v.optional(v.string()),

    isSeed: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_idempotency_key", ["userId", "idempotencyKey"]),

  /**
   * The delivery record for a draft. At most one row per
   * `(userId, idempotencyKey)` — that uniqueness, enforced inside a Convex
   * transaction, is what makes a double-tap return the first result instead of
   * sending twice.
   */
  sends: defineTable({
    userId: v.id("users"),
    draftId: v.id("drafts"),
    /** Copied from the draft so the guard survives the draft being edited. */
    idempotencyKey: v.string(),
    channel,
    connectionId: v.id("connections"),
    /** Frozen at claim time; history stays truthful if the draft changes later. */
    to: v.string(),
    subject: v.optional(v.string()),
    body: v.string(),
    /** Provider thread to deliver into, frozen with the rest of the payload. */
    threadId: v.optional(v.string()),
    /** Provider id of the message being replied to, for the threading headers. */
    inReplyTo: v.optional(v.string()),

    status: v.union(
      v.literal("queued"),
      v.literal("in_flight"),
      v.literal("succeeded"),
      v.literal("failed_transient"),
      v.literal("failed_permanent"),
      v.literal("needs_reconnect"),
      v.literal("unknown"),
    ),
    attemptCount: v.number(),
    maxAttempts: v.number(),

    providerMessageId: v.optional(v.string()),
    providerThreadId: v.optional(v.string()),

    lastErrorKind: v.optional(errorKind),
    lastErrorMessage: v.optional(v.string()),
    /** Epoch ms of the next scheduled auto-retry; absent when not retrying. */
    nextRetryAt: v.optional(v.number()),

    /**
     * Copied from the draft at claim time so the injected fault survives
     * retries — the frozen send, not the mutable draft, is what delivery reads.
     */
    injectFailure: v.optional(errorKind),

    isSeed: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_draft", ["draftId"])
    .index("by_user_idempotency_key", ["userId", "idempotencyKey"])
    // The stale-`in_flight` sweeper asks "which sends are in flight and old?".
    // Without this index that question is a full scan of every send ever made.
    .index("by_status_updated", ["status", "updatedAt"]),

  /** One row per delivery attempt, so the detail view can show a real timeline. */
  sendAttempts: defineTable({
    sendId: v.id("sends"),
    userId: v.id("users"),
    attemptNumber: v.number(),
    /** `manual` marks an operator-triggered retry as distinct from backoff. */
    trigger: v.union(
      v.literal("initial"),
      v.literal("auto"),
      v.literal("manual"),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    outcome: v.optional(
      v.union(v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
    ),
    errorKind: v.optional(errorKind),
    /** Full provider error, untruncated. The detail view shows all of it. */
    errorMessage: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    providerMessageId: v.optional(v.string()),
  }).index("by_send", ["sendId"]),

  /**
   * Per-user REST credential. Only the SHA-256 digest is stored; the plaintext
   * key is shown once at creation and is unrecoverable afterwards.
   */
  apiKeys: defineTable({
    userId: v.id("users"),
    name: v.string(),
    hash: v.string(),
    /** First few chars, e.g. `uik_a1b2c3`, so a user can tell keys apart. */
    prefix: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"]),
});
