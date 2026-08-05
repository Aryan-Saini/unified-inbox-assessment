/**
 * API keys: the credential the REST surface accepts, and nothing else.
 *
 * Three properties are deliberate and worth stating, because each of them is a
 * way this could have been done worse:
 *
 *  1. **Only the digest is stored.** The plaintext exists for exactly one
 *     response and is then unrecoverable — there is no "show key" endpoint,
 *     because a database dump must not be a set of working credentials.
 *  2. **Key management is Clerk-authenticated only.** No REST route mints,
 *     lists or revokes keys. A leaked key can spend its own rate limit; it
 *     cannot mint a fresh key, and so cannot outlive the revocation of itself.
 *  3. **Lookup is by index, comparison is constant-time.** The indexed read on
 *     `by_hash` is what makes it fast; `timingSafeEqual` on the digest is what
 *     keeps the fast path from also being a timing oracle.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { randomToken, sha256Hex, timingSafeEqual } from "./core/crypto";
import { appError } from "./core/errors";
import { requireUser } from "./users";

/** Recognisable at a glance in a log or a shell history, per the spec's `uik_`. */
const KEY_PREFIX = "uik_";

/** 24 random bytes = 192 bits, base64url. Far past guessing range. */
const KEY_ENTROPY_BYTES = 24;

/** How much of the key is stored in the clear, so a user can tell keys apart. */
const DISPLAY_PREFIX_LENGTH = 12;

/** Bound on keys per user. A key is a credential, not a scratch variable. */
const MAX_KEYS_PER_USER = 20;

const MAX_NAME_LENGTH = 64;

/**
 * How stale `lastUsedAt` is allowed to get.
 *
 * Every REST request authenticates, so stamping the row on each one would make
 * one document the write-hotspot of the whole API — and, worse, would make two
 * concurrent requests on the same key conflict with each other in Convex's OCC.
 * The double-tap test fires exactly that pattern. A minute of granularity is
 * plenty for "last used" in a UI and costs no contention in between.
 */
const LAST_USED_GRANULARITY_MS = 60_000;

const keyView = v.object({
  id: v.id("apiKeys"),
  name: v.string(),
  /** e.g. `uik_a1b2c3` — enough to identify, useless as a credential. */
  prefix: v.string(),
  createdAt: v.number(),
  lastUsedAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
});

/* --------------------------------------------------------------------- create */

/**
 * Mint a key. The plaintext in the response is the only copy that will ever
 * exist; the row holds its SHA-256 and a display prefix.
 */
export const create = mutation({
  args: { name: v.optional(v.string()) },
  returns: v.object({
    /** The plaintext key. Shown once, stored nowhere. */
    key: v.string(),
    apiKey: keyView,
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);

    const existing = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_KEYS_PER_USER + 1);

    const live = existing.filter((row) => row.revokedAt === undefined);
    if (live.length >= MAX_KEYS_PER_USER) {
      throw appError(
        "INVALID_STATE",
        `You already hold ${MAX_KEYS_PER_USER} active API keys. Revoke one before creating another.`,
      );
    }

    const name = (args.name ?? "").trim().slice(0, MAX_NAME_LENGTH);
    const key = `${KEY_PREFIX}${randomToken(KEY_ENTROPY_BYTES)}`;
    const now = Date.now();

    const id = await ctx.db.insert("apiKeys", {
      userId: user._id,
      name: name === "" ? "API key" : name,
      hash: await sha256Hex(key),
      prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
      createdAt: now,
    });

    const row = await ctx.db.get("apiKeys", id);
    if (row === null) throw appError("NOT_FOUND", "The key vanished on creation.");

    return {
      key,
      apiKey: {
        id: row._id,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
      },
    };
  },
});

/* ----------------------------------------------------------------- list/revoke */

/**
 * The caller's keys. Note what is absent: `hash`. The projection is an explicit
 * field list rather than a spread, so adding a secret column to the table later
 * cannot leak it through here by default.
 */
export const list = query({
  args: {},
  returns: v.array(keyView),
  handler: async (ctx) => {
    const user = await requireUser(ctx);

    const rows = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_KEYS_PER_USER * 2);

    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        id: row._id,
        name: row.name,
        prefix: row.prefix,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
      }));
  },
});

/**
 * Revoke a key. The row is kept rather than deleted so "this key was used, then
 * revoked at 14:02" stays answerable — and so a request arriving on it can be
 * refused as revoked rather than as merely unknown.
 */
export const revoke = mutation({
  args: { apiKeyId: v.id("apiKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get("apiKeys", args.apiKeyId);
    if (row === null || row.userId !== user._id) {
      // Not-found and not-yours answer identically, here as everywhere.
      throw appError("NOT_FOUND", "That API key does not exist.");
    }
    if (row.revokedAt === undefined) {
      await ctx.db.patch("apiKeys", args.apiKeyId, { revokedAt: Date.now() });
    }
    return null;
  },
});

/* ----------------------------------------------------------------- authenticate */

/**
 * Resolve a presented key digest to its owner, or `null`.
 *
 * A mutation rather than a query because it stamps `lastUsedAt` — a key you
 * cannot tell is in use is a key you cannot safely revoke.
 *
 * It takes the **digest**, never the plaintext: the REST layer hashes what
 * arrived and this function only ever sees a hash, so the raw credential is
 * confined to the one function that read the header.
 */
export const authenticate = internalMutation({
  args: { hash: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), apiKeyId: v.id("apiKeys") })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique();

    if (row === null) return null;
    // The index already matched, so this is belt and braces — but it costs
    // nothing and it means the comparison in this codebase is never the naive one.
    if (!timingSafeEqual(row.hash, args.hash)) return null;
    if (row.revokedAt !== undefined) return null;

    const now = Date.now();
    if (row.lastUsedAt === undefined || now - row.lastUsedAt > LAST_USED_GRANULARITY_MS) {
      await ctx.db.patch("apiKeys", row._id, { lastUsedAt: now });
    }

    return { userId: row.userId, apiKeyId: row._id };
  },
});
