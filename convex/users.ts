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

/**
 * The calling user's row, or a thrown error.
 *
 * Exported so every public function that needs an owner resolves it the same
 * way. The two failure modes are kept distinct because they call for different
 * reactions: signed out means "sign in", while a missing row means the Clerk
 * webhook has not landed yet and retrying in a moment actually works.
 */
export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not signed in.");

  const user = await currentUser(ctx);
  if (user === null) {
    throw new Error("Your account is still syncing. Try again in a moment.");
  }
  return user;
}

/** The signed-in user, or `null` when signed out or not yet synced. Safe to call
 *  unauthenticated, for read paths that should render empty rather than throw. */
export async function optionalUser(ctx: QueryCtx | MutationCtx) {
  return await currentUser(ctx);
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
 *
 * The Clerk webhook (`convex/http.ts` -> `convex/clerk.ts`) is the authoritative
 * sync. This stays as the fallback that closes the gap the webhook cannot: a
 * webhook is asynchronous, so a brand-new user can reach the app before
 * `user.created` lands. Both paths upsert on `clerkUserId`, so whichever wins
 * the race, the other is a no-op patch.
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
