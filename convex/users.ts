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
 * Idempotently upsert the calling Clerk user into Convex, and return the row.
 *
 * This is what `AuthGate` awaits before it mounts the app, so it is the thing
 * that makes "signed in" and "has a user row" the same moment. Everything the
 * row needs is already in the Convex JWT (`subject`, `email`, `name`,
 * `pictureUrl`), so there is nothing to wait for — a user who arrives without a
 * row gets issued one here rather than being told to come back later.
 *
 * The Clerk webhook (`convex/http.ts` -> `convex/clerk.ts`) is still the
 * authoritative sync; this closes the gap it cannot, because a webhook is
 * asynchronous and can be slow, retried, or — with a misconfigured signing
 * secret — never delivered at all.
 *
 * ## Why this cannot issue two rows for one person
 *
 * Both writers (`store` here, `upsertFromClerk` there) read
 * `by_clerk_user_id` for the same `clerkUserId` and only insert when that read
 * comes back empty. Convex mutations are serializable transactions, so if two
 * of them interleave — two tabs mounting at once, or this racing the webhook —
 * the second one's read set overlaps the first one's write, Convex detects the
 * conflict and re-runs it, and the re-run sees the row and patches instead.
 * The empty read and the insert can never be separated by another writer, which
 * is exactly the guarantee a duplicate would need.
 *
 * That property is load-bearing, so keep the shape: read the index inside the
 * same mutation that writes, and never move the existence check into an action
 * or a separate call. `.unique()` is the backstop — if a duplicate ever did
 * appear, every read throws loudly rather than silently picking one row.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ensureUser(ctx);
    return { userId: user._id };
  },
});

/**
 * The calling user's row, created from the JWT if it is not there yet.
 *
 * The write-path counterpart to `requireUser`: any mutation holding a valid
 * Convex identity can call this instead of throwing at a missing row, because
 * every field the row needs is in the token. Read paths keep `requireUser` —
 * a query cannot write.
 *
 * See `store` above for why concurrent callers cannot produce two rows.
 */
export async function ensureUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not signed in.");

  const fields = {
    email: identity.email,
    name: identity.name,
    imageUrl: identity.pictureUrl,
  };

  const existing = await currentUser(ctx);
  if (existing !== null) {
    await ctx.db.patch(existing._id, fields);
    return { ...existing, ...fields };
  }

  const userId = await ctx.db.insert("users", {
    clerkUserId: identity.subject,
    ...fields,
  });
  const created = await ctx.db.get(userId);
  if (created === null) throw new Error("User row vanished immediately after insert.");
  return created;
}
