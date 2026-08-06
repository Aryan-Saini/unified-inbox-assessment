/**
 * Connections: the grant vault, and the token lifecycle built on top of it.
 *
 * Two rules hold this file together.
 *
 * **A connection is identified by `(userId, provider, externalAccountId)`, never
 * by its row id alone.** Reconnecting upserts on that triple, so the `_id`
 * survives a re-grant and every draft, send and search result that points at the
 * connection stays valid. A disconnect is a soft delete for the same reason: the
 * row stays, so history does not develop dangling references.
 *
 * **Nothing outside this file sees a token.** The public queries return no
 * ciphertext, and callers that need to talk to a provider go through
 * `resolveToken`, which hands back a plaintext access token and keeps refresh,
 * leasing and revocation detection to itself. An adapter cannot mishandle a
 * refresh token it is never given.
 */

import { v } from "convex/values";
import { decryptToken, encryptToken, type TokenAad } from "./core/crypto";
import { sleep } from "./core/http";
import { faultInjectionEnabled, INJECTED_PREFIX } from "./core/faults";
import { AdapterError, toAdapterError } from "./core/types";
import * as google from "./oauth/google";
import * as slack from "./oauth/slack";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { connectionStatus, provider as providerValidator } from "./schema";

type Provider = Doc<"connections">["provider"];

/**
 * Refresh this far before the access token actually expires.
 *
 * Refreshing on a 401 works but wastes a provider call and muddies the logs —
 * every genuine 401 then looks like a possible clock-skew artefact. A window
 * wider than any plausible skew means a 401 really does mean "revoked".
 */
const EXPIRY_SKEW_MS = 120_000;

/** How long one worker owns the right to refresh a connection. */
const REFRESH_LEASE_MS = 30_000;

/** Bounded wait for the lease winner, for workers that lost the race. */
const LEASE_POLL_ATTEMPTS = 3;
const LEASE_POLL_INTERVAL_MS = 250;

function aadFor(
  connection: { _id: Id<"connections">; provider: Provider },
  tokenType: TokenAad["tokenType"],
): TokenAad {
  return {
    provider: connection.provider,
    connectionId: connection._id,
    tokenType,
  };
}

async function requireUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not signed in.");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (user === null) throw new Error("Your account is still syncing. Try again in a moment.");
  return user;
}

/**
 * Load a connection and prove it belongs to the caller.
 *
 * Not-found and not-yours give the same error deliberately: telling them apart
 * confirms the existence of another user's row.
 */
async function requireOwnConnection(
  ctx: MutationCtx,
  connectionId: Id<"connections">,
): Promise<Doc<"connections">> {
  const user = await requireUser(ctx);
  const connection = await ctx.db.get("connections", connectionId);
  if (connection === null || connection.userId !== user._id) {
    throw new Error("That connection does not exist.");
  }
  return connection;
}

/* ------------------------------------------------------------------ public API */

/**
 * The caller's connections, with every secret field omitted.
 *
 * The omission is structural rather than a `delete` on the way out: the object
 * literal below lists what a client may see, so adding a sensitive column to the
 * schema later cannot leak it by default.
 */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("connections"),
      provider: providerValidator,
      externalAccountId: v.string(),
      label: v.string(),
      accountEmail: v.optional(v.string()),
      accountName: v.optional(v.string()),
      teamName: v.optional(v.string()),
      status: connectionStatus,
      statusReason: v.optional(v.string()),
      scopes: v.array(v.string()),
      enabled: v.boolean(),
      isSeed: v.boolean(),
      lastUsedAt: v.optional(v.number()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (user === null) return [];

    const rows = await ctx.db
      .query("connections")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(100);

    return rows
      // Removed-but-undeletable rows are gone as far as the UI is concerned.
      .filter((c) => c.hiddenAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({
        id: c._id,
        provider: c.provider,
        externalAccountId: c.externalAccountId,
        label: c.label,
        accountEmail: c.accountEmail,
        accountName: c.accountName,
        teamName: c.teamName,
        status: c.status,
        statusReason: c.statusReason,
        scopes: c.scopes,
        enabled: c.enabled,
        isSeed: c.isSeed,
        lastUsedAt: c.lastUsedAt,
        createdAt: c.createdAt,
      }));
  },
});

/**
 * Include or exclude one account from the fan-out.
 *
 * Independent of `status` on purpose: a healthy account can be switched off, and
 * a broken one can stay switched on and keep reporting its error. Collapsing the
 * two would mean a transient failure silently narrowing future searches.
 */
export const setEnabled = mutation({
  args: { connectionId: v.id("connections"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnConnection(ctx, args.connectionId);
    await ctx.db.patch("connections", args.connectionId, {
      enabled: args.enabled,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Give up a grant, keeping the row.
 *
 * A hard delete would break every `drafts.connectionId` and `sends.connectionId`
 * pointing at it, and the outbox would lose the ability to explain what a past
 * delivery went through. The tokens are what actually need to go, so they are
 * cleared; the identity and the history stay.
 */
export const disconnect = mutation({
  args: { connectionId: v.id("connections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwnConnection(ctx, args.connectionId);
    const now = Date.now();
    await ctx.db.patch("connections", args.connectionId, {
      status: "revoked",
      statusReason: "Disconnected by you.",
      // Tokens are the only part worth destroying, and destroying them means a
      // reconnect is genuinely a re-grant rather than a status flip.
      accessTokenCipher: "",
      refreshTokenCipher: undefined,
      tokenExpiresAt: undefined,
      refreshLockedUntil: undefined,
      enabled: false,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Forget an account entirely — the way out `disconnect` deliberately does not give.
 *
 * `disconnect` keeps the row, which is right for giving up a grant but leaves a
 * dead connection on screen with nothing but a Reconnect button. This removes it,
 * and has to respect the same constraint that made `disconnect` a soft revoke:
 * `drafts.connectionId` and `sends.connectionId` are **required** references, so
 * deleting a row they point at would orphan them and the outbox would lose the
 * ability to explain what a past delivery went through.
 *
 * So there are two outcomes, and the caller is told which:
 *
 * - nothing references it — the common case for an account that never sent
 *   anything — the row is **deleted**, ciphertext and all.
 * - something does: tokens are cleared and the row is **hidden**. It leaves the
 *   UI, holds no secret, and the history it anchors stays answerable.
 *
 * `searchSources` / `searchResults` also carry a `connectionId`, but theirs is
 * optional and read through their search rather than through the connection, so a
 * deleted row degrades them to "no connection recorded" rather than breaking them.
 */
/**
 * Retire a connection: delete it outright when nothing points at it, empty it
 * and hide it when something does.
 *
 * Shared by `remove` (the user asked) and `supersede` (a newer grant replaced
 * it), because the constraint is the same in both cases and only the reason
 * differs. A hard delete would break every `drafts.connectionId` and
 * `sends.connectionId` pointing here, and the outbox would lose the ability to
 * explain what a past delivery went through.
 */
async function retire(
  ctx: MutationCtx,
  connection: Doc<"connections">,
  reason: string,
): Promise<{ deleted: boolean }> {
  // `first()` rather than a count: the question is only whether *any* row
  // points here, and stopping at one keeps this cheap for a heavy sender.
  const [draft, send] = await Promise.all([
    ctx.db
      .query("drafts")
      .withIndex("by_user", (q) => q.eq("userId", connection.userId))
      .filter((q) => q.eq(q.field("connectionId"), connection._id))
      .first(),
    ctx.db
      .query("sends")
      .withIndex("by_user", (q) => q.eq("userId", connection.userId))
      .filter((q) => q.eq(q.field("connectionId"), connection._id))
      .first(),
  ]);

  if (draft === null && send === null) {
    await ctx.db.delete("connections", connection._id);
    return { deleted: true };
  }

  await ctx.db.patch("connections", connection._id, {
    hiddenAt: Date.now(),
    status: "revoked",
    statusReason: reason,
    // Same as `disconnect`: the tokens are the part that must not survive.
    accessTokenCipher: "",
    refreshTokenCipher: undefined,
    tokenExpiresAt: undefined,
    refreshLockedUntil: undefined,
    enabled: false,
    updatedAt: Date.now(),
  });
  return { deleted: false };
}

export const remove = mutation({
  args: { connectionId: v.id("connections") },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const connection = await requireOwnConnection(ctx, args.connectionId);
    return await retire(ctx, connection, "Removed by you.");
  },
});

/**
 * Break this connection's tokens without touching the provider, so the revoked →
 * reconnect path can be demonstrated on demand.
 *
 * Note what this deliberately does *not* do: it leaves `status` as `active`. The
 * point of the demo is that the system **discovers** the dead grant on next use,
 * classifies the provider's 401 as `needs_reconnect`, and flips the status
 * itself. Setting the status here would demo the UI and skip the mechanism.
 *
 * The tokens are replaced with valid ciphertext holding a bogus value, not with
 * garbage: garbage would fail to decrypt locally, whereas a bogus token produces
 * a real provider 401 — the same code path a genuinely revoked grant takes.
 */
export const simulateRevoke = mutation({
  args: { connectionId: v.id("connections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!faultInjectionEnabled()) {
      throw new Error("Fault injection is disabled on this deployment.");
    }
    const connection = await requireOwnConnection(ctx, args.connectionId);
    if (connection.isSeed) {
      throw new Error("Seeded connections hold no grant to revoke.");
    }

    await ctx.db.patch("connections", args.connectionId, {
      accessTokenCipher: await encryptToken(
        `${INJECTED_PREFIX} invalidated-access-token`,
        aadFor(connection, "access"),
      ),
      refreshTokenCipher: await encryptToken(
        `${INJECTED_PREFIX} invalidated-refresh-token`,
        aadFor(connection, "refresh"),
      ),
      // An hour of headroom so the next use spends the dead access token and gets
      // a 401, rather than refreshing first and getting `invalid_grant`. Both end
      // in `needs_reconnect`; the 401 is the more interesting one to show.
      tokenExpiresAt: Date.now() + 3_600_000,
      refreshLockedUntil: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/* ---------------------------------------------------------------- grant intake */

/**
 * Upsert the identity half of a grant, and hand back the row id.
 *
 * This is deliberately only half of storing a grant. The token ciphertexts are
 * bound to their `connectionId` as authenticated data (see `core/crypto.ts`), so
 * a brand-new connection cannot be encrypted for until its row exists —
 * `storeGrantTokens` finishes the job once the callback knows the id.
 *
 * A row created here and never completed is left `errored` with a reason saying
 * so. That is a legible state a reconnect fixes, which is a better failure mode
 * than either a row holding an unbound ciphertext or a lost grant.
 */
/**
 * Slack's `externalAccountId` is `T…:U…` — the workspace *and* the user within
 * it. Two different Slack users in one workspace are therefore two different
 * identities, and the `(userId, provider, externalAccountId)` index correctly
 * treats them as separate rows. That is right for identity and wrong for
 * *searching*: both grants search the same workspace.
 *
 * This finds the live connections a new grant is about to supersede: same user,
 * same provider, same workspace, different identity. Gmail has no workspace —
 * its `externalAccountId` is the address itself, which is the identity — so this
 * is empty there by construction, and connecting a second Gmail account never
 * disturbs the first.
 */
/**
 * Do two `externalAccountId`s name the same Slack workspace?
 *
 * True only for the `T…:U…` form, and only when the `T…` halves match. Gmail's
 * identifier is a bare address with no workspace part, so this is false there by
 * construction — two Gmail addresses are always two accounts.
 */
function sameWorkspaceAs(a: string, b: string): boolean {
  const left = a.indexOf(":");
  const right = b.indexOf(":");
  if (left <= 0 || right <= 0) return false;
  return a.slice(0, left) === b.slice(0, right);
}

async function sameWorkspace(
  ctx: MutationCtx,
  args: { userId: Id<"users">; provider: "gmail" | "slack"; externalAccountId: string },
): Promise<Doc<"connections">[]> {
  const separator = args.externalAccountId.indexOf(":");
  if (separator <= 0) return [];
  const workspace = args.externalAccountId.slice(0, separator + 1);

  const rows = await ctx.db
    .query("connections")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .collect();

  return rows.filter(
    (row) =>
      row.provider === args.provider &&
      row.hiddenAt === undefined &&
      row.externalAccountId.startsWith(workspace) &&
      row.externalAccountId !== args.externalAccountId,
  );
}

/**
 * How to name an account in a message a person reads.
 *
 * Gmail is its address. Slack is the member *and* the workspace, because
 * "aryan-test" on both sides of a mismatch explains nothing when the two grants
 * differ only by who signed in.
 */
function describeIdentity(row: {
  label: string;
  accountEmail?: string;
  accountName?: string;
}): string {
  if (row.accountEmail !== undefined) return row.accountEmail;
  if (row.accountName !== undefined) return `${row.accountName} at ${row.label}`;
  return row.label;
}

export const upsertFromGrant = internalMutation({
  args: {
    userId: v.id("users"),
    provider: providerValidator,
    externalAccountId: v.string(),
    label: v.string(),
    accountEmail: v.optional(v.string()),
    accountName: v.optional(v.string()),
    teamName: v.optional(v.string()),
    scopes: v.array(v.string()),
    /** Set when this flow was started as a reconnect of a specific row. */
    reconnectConnectionId: v.optional(v.id("connections")),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      connectionId: v.id("connections"),
      created: v.boolean(),
    }),
    v.object({
      ok: v.literal(false),
      error: v.union(v.literal("identity_mismatch"), v.literal("unknown_connection")),
      expected: v.optional(v.string()),
      actual: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("connections")
      .withIndex("by_user_provider_account", (q) =>
        q
          .eq("userId", args.userId)
          .eq("provider", args.provider)
          .eq("externalAccountId", args.externalAccountId),
      )
      .unique();

    if (args.reconnectConnectionId !== undefined) {
      const target = await ctx.db.get("connections", args.reconnectConnectionId);
      if (target === null || target.userId !== args.userId) {
        return { ok: false as const, error: "unknown_connection" as const };
      }

      if (target.externalAccountId !== args.externalAccountId) {
        // Same workspace, different member: absorbed, not refused. A Slack
        // `externalAccountId` is `T…:U…`, so re-authorising as a colleague — or
        // as yourself under a second login — changes the identity while the
        // thing being reconnected is unmistakably the same workspace. Refusing
        // sent the user to "Add account", which is what produced two grants to
        // one workspace fanning out twice.
        //
        // The row is repointed rather than replaced, so its `_id` survives and
        // every draft and send hanging off it stays answerable.
        if (sameWorkspaceAs(target.externalAccountId, args.externalAccountId)) {
          // Unless the new identity is already connected: then that row is the
          // newer grant, it wins, and the one being reconnected is retired.
          // Repointing here would put two rows on one identity and break the
          // uniqueness the account index depends on.
          if (existing !== null && existing._id !== target._id) {
            await retire(
              ctx,
              target,
              `Replaced by a newer connection to ${args.teamName ?? args.label}.`,
            );
          } else {
            await ctx.db.patch("connections", target._id, {
              externalAccountId: args.externalAccountId,
              accountEmail: args.accountEmail,
              // The member changed, so the name on the row has to change with
              // it — otherwise the row keeps claiming the colleague it used to
              // be authorised as.
              accountName: args.accountName,
            });
          }
        } else {
          // A genuinely different account — another workspace, another inbox.
          // Repointing would rewrite the identity every existing draft and send
          // was made against, so this stays a refusal with both names in it.
          return {
            ok: false as const,
            error: "identity_mismatch" as const,
            expected: describeIdentity(target),
            actual: describeIdentity(args),
          };
        }

        if (existing === null) {
          await ctx.db.patch("connections", target._id, {
            label: args.label,
            accountName: args.accountName,
            teamName: args.teamName,
            scopes: args.scopes,
            updatedAt: now,
          });
          return { ok: true as const, connectionId: target._id, created: false };
        }
      }
    }

    if (existing !== null) {
      // Metadata only. Status stays untouched until the tokens actually land.
      await ctx.db.patch("connections", existing._id, {
        label: args.label,
        accountEmail: args.accountEmail,
        accountName: args.accountName,
        teamName: args.teamName,
        scopes: args.scopes,
        updatedAt: now,
      });
      return { ok: true as const, connectionId: existing._id, created: false };
    }

    // A *new* identity in a workspace this user has already connected means the
    // newer grant takes over: two grants to one Slack workspace are two sets of
    // provider calls returning near-identical results, and the older one is
    // whichever the user has just replaced by signing in again. Retiring it here
    // rather than leaving it enabled is what makes reconnecting-as-someone-else
    // self-healing instead of a silent double fan-out.
    //
    // Scoped to the workspace, not the provider: several Gmail inboxes, or
    // several *different* Slack workspaces, are the multi-account case the whole
    // product is for and must not be disturbed.
    for (const previous of await sameWorkspace(ctx, args)) {
      await retire(
        ctx,
        previous,
        `Replaced by a newer connection to ${args.teamName ?? args.label}.`,
      );
    }

    const connectionId = await ctx.db.insert("connections", {
      userId: args.userId,
      provider: args.provider,
      externalAccountId: args.externalAccountId,
      label: args.label,
      accountEmail: args.accountEmail,
      accountName: args.accountName,
      teamName: args.teamName,
      status: "errored",
      statusReason: "Connecting — tokens have not been stored yet.",
      enabled: true,
      scopes: args.scopes,
      accessTokenCipher: "",
      isSeed: false,
      createdAt: now,
      updatedAt: now,
    });

    return { ok: true as const, connectionId, created: true };
  },
});

/**
 * Second half of grant intake: store the ciphertexts and mark the connection
 * live.
 *
 * `refreshTokenCipher` is only written when one was issued. Google returns a
 * refresh token on the first grant and often omits it afterwards, so overwriting
 * unconditionally would trade a working long-lived grant for a one-hour access
 * token — the classic version of this bug.
 */
export const storeGrantTokens = internalMutation({
  args: {
    connectionId: v.id("connections"),
    accessTokenCipher: v.string(),
    refreshTokenCipher: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    scopes: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("connections", args.connectionId);
    if (existing === null) throw new Error("Connection vanished mid-connect.");

    const now = Date.now();
    await ctx.db.patch("connections", args.connectionId, {
      accessTokenCipher: args.accessTokenCipher,
      ...(args.refreshTokenCipher === undefined
        ? {}
        : { refreshTokenCipher: args.refreshTokenCipher }),
      tokenExpiresAt: args.tokenExpiresAt,
      ...(args.scopes === undefined || args.scopes.length === 0
        ? {}
        : { scopes: args.scopes }),
      status: "active",
      statusReason: undefined,
      refreshLockedUntil: undefined,
      lastRefreshedAt: now,
      lastErrorAt: undefined,
      updatedAt: now,
    });
    return null;
  },
});

/* ------------------------------------------------------------ token lifecycle */

const forUseReturns = v.union(
  v.null(),
  v.object({
    _id: v.id("connections"),
    userId: v.id("users"),
    provider: providerValidator,
    externalAccountId: v.string(),
    label: v.string(),
    scopes: v.array(v.string()),
    status: connectionStatus,
    statusReason: v.optional(v.string()),
    enabled: v.boolean(),
    isSeed: v.boolean(),
    accessTokenCipher: v.string(),
    refreshTokenCipher: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    refreshLockedUntil: v.optional(v.number()),
  }),
);

/**
 * Everything `resolveToken` needs, including ciphertext — which is why this is
 * `internalQuery` and why the public `list` above is a separate function rather
 * than a filtered call into this one.
 */
export const forUse = internalQuery({
  args: { connectionId: v.id("connections") },
  returns: forUseReturns,
  handler: async (ctx, args) => {
    const c = await ctx.db.get("connections", args.connectionId);
    if (c === null) return null;
    return {
      _id: c._id,
      userId: c.userId,
      provider: c.provider,
      externalAccountId: c.externalAccountId,
      label: c.label,
      scopes: c.scopes,
      status: c.status,
      statusReason: c.statusReason,
      enabled: c.enabled,
      isSeed: c.isSeed,
      accessTokenCipher: c.accessTokenCipher,
      refreshTokenCipher: c.refreshTokenCipher,
      tokenExpiresAt: c.tokenExpiresAt,
      refreshLockedUntil: c.refreshLockedUntil,
    };
  },
});

/** The projection `forUse` returns — the token-bearing view of a connection. */
type ConnectionForUse = {
  _id: Id<"connections">;
  userId: Id<"users">;
  provider: Provider;
  externalAccountId: string;
  label: string;
  scopes: string[];
  status: Doc<"connections">["status"];
  statusReason?: string;
  enabled: boolean;
  isSeed: boolean;
  accessTokenCipher: string;
  refreshTokenCipher?: string;
  tokenExpiresAt?: number;
  refreshLockedUntil?: number;
};

/**
 * Take the refresh lease, if it is free.
 *
 * Single-flight matters because a fan-out across two Gmail accounts plus a
 * concurrent send can hit one connection three times within the same second.
 * Without the lease that is three parallel refreshes: wasteful with a static
 * refresh token, and outright data loss with a rotating one, because the losers
 * would store tokens the provider has already invalidated.
 */
export const acquireRefreshLease = internalMutation({
  args: { connectionId: v.id("connections") },
  returns: v.object({ acquired: v.boolean() }),
  handler: async (ctx, args) => {
    const c = await ctx.db.get("connections", args.connectionId);
    if (c === null) return { acquired: false };

    const now = Date.now();
    if (c.refreshLockedUntil !== undefined && c.refreshLockedUntil > now) {
      return { acquired: false };
    }

    await ctx.db.patch("connections", args.connectionId, {
      // Time-bounded rather than a boolean: a worker that dies mid-refresh must
      // not lock the connection out permanently.
      refreshLockedUntil: now + REFRESH_LEASE_MS,
    });
    return { acquired: true };
  },
});

export const releaseRefreshLease = internalMutation({
  args: { connectionId: v.id("connections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await ctx.db.get("connections", args.connectionId);
    if (c === null) return null;
    await ctx.db.patch("connections", args.connectionId, {
      refreshLockedUntil: undefined,
    });
    return null;
  },
});

/** Persist a refreshed token and release the lease in the same transaction. */
export const storeRefreshedToken = internalMutation({
  args: {
    connectionId: v.id("connections"),
    accessTokenCipher: v.string(),
    refreshTokenCipher: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await ctx.db.get("connections", args.connectionId);
    if (c === null) return null;

    const now = Date.now();
    await ctx.db.patch("connections", args.connectionId, {
      accessTokenCipher: args.accessTokenCipher,
      ...(args.refreshTokenCipher === undefined
        ? {}
        : { refreshTokenCipher: args.refreshTokenCipher }),
      tokenExpiresAt: args.tokenExpiresAt,
      // A successful refresh is proof the grant is healthy, so it clears a
      // previous `expired`/`errored` state without needing a separate signal.
      status: "active",
      statusReason: undefined,
      refreshLockedUntil: undefined,
      lastRefreshedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Record that the grant is gone. The reason is stored verbatim — the operator
 * should see the provider's own words, not our paraphrase of them.
 */
export const markRevoked = internalMutation({
  args: { connectionId: v.id("connections"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await ctx.db.get("connections", args.connectionId);
    if (c === null) return null;

    const now = Date.now();
    await ctx.db.patch("connections", args.connectionId, {
      status: "revoked",
      statusReason: args.reason,
      refreshLockedUntil: undefined,
      lastErrorAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/* --------------------------------------------------------------- resolveToken */

export interface ResolvedToken {
  accessToken: string;
  provider: Provider;
  externalAccountId: string;
  label: string;
  /** What the user actually granted. An adapter reads this to skip a call it
   *  knows the grant does not cover, instead of spending a request to be told. */
  scopes: string[];
}

function isFresh(connection: ConnectionForUse): boolean {
  // No expiry at all means a non-expiring token (a Slack user token with
  // rotation off), which is fresh by definition.
  if (connection.tokenExpiresAt === undefined) return true;
  return connection.tokenExpiresAt > Date.now() + EXPIRY_SKEW_MS;
}

async function decryptAccess(connection: ConnectionForUse): Promise<string> {
  if (connection.accessTokenCipher === "") {
    throw AdapterError.needsReconnect(
      `${connection.label} has no stored access token. Reconnect the account.`,
    );
  }
  try {
    return await decryptToken(connection.accessTokenCipher, aadFor(connection, "access"));
  } catch (err) {
    // Either the encryption key changed or the row was tampered with. Neither is
    // retryable, and both are fixed by re-granting, so this is a reconnect.
    throw AdapterError.needsReconnect(
      `Stored token for ${connection.label} could not be decrypted. Reconnect the account.`,
      { detail: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * Hand an action a usable access token for a connection, refreshing first if the
 * stored one is close to expiring.
 *
 * This is the only door to a provider credential in the whole system. Adapters
 * and senders call it and receive a string; they never learn that refresh tokens,
 * leases or revocation exist.
 *
 * Every failure leaves the database in a state that explains itself: a dead grant
 * ends as `revoked` with the provider's reason attached and an
 * `AdapterError.needsReconnect` thrown, so the caller records
 * `needs_reconnect` rather than a generic failure and the UI can offer the one
 * button that actually helps.
 */
export async function resolveToken(
  ctx: ActionCtx,
  connectionId: Id<"connections">,
): Promise<ResolvedToken> {
  const connection = await ctx.runQuery(internal.connections.forUse, { connectionId });
  if (connection === null) {
    throw AdapterError.permanent("That connection no longer exists.");
  }

  const resolved = (accessToken: string): ResolvedToken => ({
    accessToken,
    provider: connection.provider,
    externalAccountId: connection.externalAccountId,
    label: connection.label,
    scopes: connection.scopes,
  });

  // Seeded fixtures carry no grant. Refusing here rather than at the provider is
  // what guarantees demo data can never cause a real API call — including a
  // failed one that would burn quota or trip a rate limit.
  if (connection.isSeed) {
    throw AdapterError.permanent(
      `${connection.label} is seeded demo data and holds no real grant, so no provider call was made.`,
    );
  }

  if (connection.status === "revoked") {
    throw AdapterError.needsReconnect(
      connection.statusReason ?? `The grant for ${connection.label} was revoked.`,
    );
  }

  if (isFresh(connection)) {
    return resolved(await decryptAccess(connection));
  }

  if (connection.refreshTokenCipher === undefined) {
    throw AdapterError.needsReconnect(
      `${connection.label} has an expired token and no refresh token. Reconnect the account.`,
    );
  }

  const lease = await ctx.runMutation(internal.connections.acquireRefreshLease, {
    connectionId,
  });

  if (!lease.acquired) {
    // Someone else is refreshing. Wait briefly for their result rather than
    // duplicating the call — but boundedly, because a stuck winner must surface
    // as a transient failure the retry loop can handle, not as a hang.
    for (let attempt = 0; attempt < LEASE_POLL_ATTEMPTS; attempt++) {
      await sleep(LEASE_POLL_INTERVAL_MS);
      const again = await ctx.runQuery(internal.connections.forUse, { connectionId });
      if (again === null) throw AdapterError.permanent("That connection no longer exists.");
      if (again.status === "revoked") {
        throw AdapterError.needsReconnect(
          again.statusReason ?? `The grant for ${again.label} was revoked.`,
        );
      }
      if (isFresh(again)) return resolved(await decryptAccess(again));
    }
    throw AdapterError.transient(
      `Another worker is still refreshing ${connection.label}. Retrying shortly.`,
    );
  }

  try {
    const refreshToken = await decryptToken(
      connection.refreshTokenCipher,
      aadFor(connection, "refresh"),
    ).catch(() => {
      throw AdapterError.needsReconnect(
        `Stored refresh token for ${connection.label} could not be decrypted. Reconnect the account.`,
      );
    });

    const grant =
      connection.provider === "gmail"
        ? await google.refresh(refreshToken)
        : // Only reachable if token rotation gets enabled on the Slack app; with
          // rotation off a Slack user token has no expiry to trip this branch.
          await slack.refresh(refreshToken);

    await ctx.runMutation(internal.connections.storeRefreshedToken, {
      connectionId,
      accessTokenCipher: await encryptToken(grant.accessToken, aadFor(connection, "access")),
      refreshTokenCipher:
        grant.refreshToken === undefined
          ? undefined
          : await encryptToken(grant.refreshToken, aadFor(connection, "refresh")),
      tokenExpiresAt: grant.expiresAt,
    });

    return resolved(grant.accessToken);
  } catch (err) {
    const error = toAdapterError(err);

    if (error.kind === "needs_reconnect") {
      // `invalid_grant` / `token_revoked`: the refresh token is dead and no retry
      // will revive it. Recording that is what turns a repeated mystery failure
      // into one actionable "reconnect this account".
      await ctx.runMutation(internal.connections.markRevoked, {
        connectionId,
        reason: error.message,
      });
    } else {
      // Transient or permanent: the grant may well be fine, so free the lease
      // instead of holding it for its full 30s and blocking the next attempt.
      await ctx.runMutation(internal.connections.releaseRefreshLease, { connectionId });
    }

    throw error;
  }
}
