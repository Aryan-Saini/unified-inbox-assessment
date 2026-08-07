/**
 * Clerk → Convex user sync.
 *
 * These are the only writers to `users` that a webhook touches. They are
 * internal on purpose: the sole caller is the verified HTTP action in
 * `convex/http.ts`, so nothing on the public API can forge a user row.
 *
 * The join key is `clerkUserId` — Clerk's own `user_…` id, which is also what
 * `ctx.auth.getUserIdentity().subject` returns. It has to be this rather than
 * `tokenIdentifier`, because a webhook carries no session token to derive one
 * from; it is the one identifier both sides of the sync can see.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Idempotently create or update the Convex user for a Clerk user.
 *
 * Idempotency matters more than it looks: Svix retries on any non-2xx, and
 * `user.created` and `user.updated` can arrive out of order, so both events
 * route here and the last write simply wins.
 */
export const upsertFromClerk = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { clerkUserId, ...fields } = args;

    // Drop absent fields rather than passing them through. `ctx.db.patch`
    // *removes* a field set to `undefined`, so patching the raw args would let
    // an event that simply omits an email delete a good stored one — Clerk sends
    // no email for a phone-only or some OAuth-only accounts. Absent must mean
    // "unchanged" here, not "cleared".
    const present = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (existing !== null) {
      await ctx.db.patch(existing._id, present);
      return existing._id;
    }

    return await ctx.db.insert("users", { clerkUserId, ...present });
  },
});

/**
 * Remove the Convex user for a deleted Clerk user.
 *
 * Deliberately a no-op when the row is absent: a `user.deleted` for someone who
 * never signed in to this app is normal, not an error, and throwing would make
 * Svix retry a delete that can never succeed.
 *
 * NOTE: this deletes the `users` row and revokes every live credential that
 * hangs off it — API keys and OAuth grants — because a deleted Clerk user has
 * no UI left to revoke them, and a key issued before deletion would otherwise
 * keep authenticating forever against still-decryptable tokens. History rows
 * (searches, drafts, sends) are left in place for auditability: they hold no
 * live credential, and cascading them would risk the mutation's transaction
 * limits.
 */
export const deleteFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (existing === null) return null;

    const now = Date.now();

    // Revoke every API key so `authenticate` refuses it even before its
    // owner-existence check catches the deleted user row.
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", existing._id))
      .take(100);
    for (const key of keys) {
      if (key.revokedAt === undefined) {
        await ctx.db.patch("apiKeys", key._id, { revokedAt: now });
      }
    }

    // Destroy the stored grants: clear both ciphertexts and mark the row revoked,
    // the same field set `connections.disconnect`/`retire` use, so no OAuth token
    // survives the account it belonged to.
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_user", (q) => q.eq("userId", existing._id))
      .take(100);
    for (const connection of connections) {
      await ctx.db.patch("connections", connection._id, {
        accessTokenCipher: "",
        refreshTokenCipher: undefined,
        tokenExpiresAt: undefined,
        refreshLockedUntil: undefined,
        status: "revoked",
        statusReason: "Owner account deleted.",
        enabled: false,
        updatedAt: now,
      });
    }

    await ctx.db.delete("users", existing._id);
    return null;
  },
});
