import { mutation, query } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";

/**
 * Resolve the calling Clerk identity to a row in `users`.
 * Returns null when the request carries no (or an invalid) Convex JWT.
 */
async function currentUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;

  return await ctx.db
    .query("users")
    .withIndex("by_clerk_user_id", (q) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

/** The signed-in user, or null when signed out. Safe to call unauthenticated. */
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return null;

    const user = await currentUser(ctx);
    return {
      clerkUserId: identity.subject,
      email: identity.email ?? user?.email,
      name: identity.name ?? user?.name,
      imageUrl: user?.imageUrl,
      // Present only once `store` has run, so the UI can tell "authenticated"
      // apart from "authenticated and persisted".
      stored: user !== null,
    };
  },
});

/**
 * Idempotently upsert the calling Clerk user into Convex.
 * Called on mount by the client once Clerk reports an authenticated session.
 * A Clerk webhook would be the more robust long-term sync; this keeps the
 * proof-of-concept to a single round trip.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("store called without an authenticated identity");
    }

    const existing = await currentUser(ctx);
    const fields = {
      email: identity.email,
      name: identity.name,
      imageUrl: identity.pictureUrl,
    };

    if (existing !== null) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkUserId: identity.subject,
      ...fields,
    });
  },
});
