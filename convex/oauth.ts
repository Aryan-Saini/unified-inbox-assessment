/**
 * The start of every OAuth flow, and the state machine that makes the callback
 * safe.
 *
 * `begin` is an **authenticated Convex mutation**, not an HTTP route. That is the
 * single most load-bearing decision in this file: the browser is already holding
 * a Convex session, so the flow can be started with the user's identity proven,
 * and no token — Convex JWT or otherwise — ever has to ride in a URL where it
 * would land in logs, referrers and browser history. What does ride in the URL is
 * an opaque, single-use, expiring `state` that means nothing on its own.
 *
 * The callback lives in `convex/http.ts` because a Convex deployment already has
 * a stable public URL, so real OAuth works while the frontend is still only on
 * localhost.
 */

import { v } from "convex/values";
import { randomToken, sha256Base64Url } from "./core/crypto";
import * as google from "./oauth/google";
import * as slack from "./oauth/slack";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { provider as providerValidator } from "./schema";
import type { Doc } from "./_generated/dataModel";

type Provider = Doc<"connections">["provider"];

/** How long a started flow stays valid. Long enough to read a consent screen. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The path segment each provider is called back on. Google's is `google` rather
 * than `gmail` because the grant is a Google account grant — Gmail is only the
 * API we then call with it — and the registered redirect URI has to read that way
 * in the Google console.
 */
const CALLBACK_SLUG: Record<Provider, string> = {
  gmail: "google",
  slack: "slack",
};

/** The reverse map, for the callback handler. */
export const PROVIDER_BY_SLUG: Record<string, Provider> = {
  google: "gmail",
  slack: "slack",
};

/**
 * The redirect URI, derived from `CONVEX_SITE_URL` rather than configured.
 *
 * Google and Slack both require a byte-exact match against a registered value,
 * and a hand-set env var is exactly the kind of thing that drifts between
 * deployments and fails with `redirect_uri_mismatch` at the worst moment.
 * `CONVEX_SITE_URL` is injected by the deployment itself, so it cannot be wrong.
 */
export function redirectUriFor(provider: Provider): string {
  const site = process.env.CONVEX_SITE_URL;
  if (site === undefined || site === "") {
    throw new Error("CONVEX_SITE_URL is not available on this deployment.");
  }
  return `${site}/oauth/${CALLBACK_SLUG[provider]}/callback`;
}

/**
 * Reduce a caller-supplied `returnTo` to a same-origin path.
 *
 * The callback redirects to `APP_BASE_URL + returnTo`, so an unchecked value here
 * is an open redirect: `//evil.test` is a protocol-relative URL that most
 * browsers resolve off-origin, and a backslash is treated as a slash by some.
 * Anything that is not plainly a path is dropped rather than repaired.
 */
export function sanitizeReturnTo(returnTo: string | undefined): string {
  if (returnTo === undefined || returnTo === "") return "/";
  if (!returnTo.startsWith("/")) return "/";
  if (returnTo.startsWith("//")) return "/";
  if (returnTo.includes("\\")) return "/";
  if (returnTo.length > 512) return "/";
  return returnTo;
}

/** Hosts that can only ever mean the visitor's own machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Reduce a caller-supplied origin to one this deployment is willing to return to.
 *
 * The frontend's origin is not something the backend can know: the port changes
 * between `next dev` runs, and one deployment legitimately serves both a local
 * browser and a deployed one. So the browser proposes its own origin — and because
 * the callback redirects there, an unchecked value is a plain open redirect
 * (`origin: "https://evil.test"` and Convex bounces the user to it). Hence propose
 * and *check*, never trust:
 *
 * - a **loopback** origin is allowed on any port. It names the visitor's own
 *   machine and nobody else's, which is what makes the dev port stop mattering.
 * - anything else must appear in `APP_BASE_URL` or `APP_ORIGIN_ALLOWLIST`
 *   (comma-separated), so a deployed frontend is registered exactly once.
 *
 * Returns `undefined` when nothing matches, which leaves the callback on
 * `APP_BASE_URL` — the older behaviour, and the conservative one.
 */
export function resolveAppOrigin(proposed: string | undefined): string | undefined {
  if (proposed === undefined || proposed === "" || proposed.length > 256) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(proposed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin;

  return allowedOrigins().includes(url.origin) ? url.origin : undefined;
}

/**
 * The registered origins, as origins rather than as whatever shape they were
 * written in — `https://app.example/` and `https://app.example` have to compare
 * equal. An entry that will not parse is dropped rather than repaired, so one
 * typo in the list cannot widen what the rest of it allows.
 */
function allowedOrigins(): string[] {
  return [
    process.env.APP_BASE_URL,
    ...(process.env.APP_ORIGIN_ALLOWLIST ?? "").split(","),
  ]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => entry !== undefined && entry !== "")
    .flatMap((entry) => {
      try {
        return [new URL(entry).origin];
      } catch {
        return [];
      }
    });
}

async function requireUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Sign in before connecting an account.");
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (user === null) {
    // `StoreUser` upserts on mount and the Clerk webhook does the same, so this
    // is a genuine race rather than a normal state — retrying works.
    throw new Error("Your account is still syncing. Try again in a moment.");
  }
  return user;
}

/**
 * Start a connect or reconnect, and return the URL to navigate to.
 *
 * Returns the URL instead of redirecting because a mutation cannot redirect —
 * which is fine, and arguably better: the client decides whether to navigate,
 * open a popup, or show the link.
 */
export const begin = mutation({
  args: {
    provider: providerValidator,
    /** Set to re-grant an existing connection rather than add a new one. */
    reconnectConnectionId: v.optional(v.id("connections")),
    /** Path within the app to land on afterwards. Defaults to `/`. */
    returnTo: v.optional(v.string()),
    /**
     * The origin to come back to, normally `window.location.origin`. Honoured only
     * if `resolveAppOrigin` allows it; otherwise the callback uses `APP_BASE_URL`.
     */
    origin: v.optional(v.string()),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);

    let loginHint: string | undefined;
    if (args.reconnectConnectionId !== undefined) {
      const existing = await ctx.db.get("connections", args.reconnectConnectionId);
      // Not-found and not-yours are the same answer on purpose: distinguishing
      // them would confirm the existence of another user's row.
      if (existing === null || existing.userId !== user._id) {
        throw new Error("That connection does not exist.");
      }
      loginHint = existing.accountEmail;
    }

    const state = randomToken(32);
    // PKCE for Google; Slack's `oauth.v2.access` does not support it, so there
    // the single-use state is the whole defence.
    const codeVerifier = args.provider === "gmail" ? randomToken(48) : undefined;

    await ctx.db.insert("oauthStates", {
      state,
      userId: user._id,
      provider: args.provider,
      reconnectConnectionId: args.reconnectConnectionId,
      returnTo: sanitizeReturnTo(args.returnTo),
      // Resolved now rather than at the callback: the flow's return origin is
      // settled by the request that started it, and cannot be influenced by
      // anything that arrives later.
      appOrigin: resolveAppOrigin(args.origin),
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const redirectUri = redirectUriFor(args.provider);

    if (args.provider === "gmail") {
      return {
        url: google.authorizeUrl({
          redirectUri,
          state,
          codeChallenge: await sha256Base64Url(codeVerifier as string),
          loginHint,
        }),
      };
    }

    return { url: slack.authorizeUrl({ redirectUri, state }) };
  },
});

/**
 * Consume a `state` exactly once.
 *
 * Every check that makes a callback trustworthy happens here, in one
 * transaction, because "read the row, then mark it used" as two steps is a replay
 * window: two callbacks arriving together would both see it unconsumed.
 *
 * `provider` is an argument rather than something read off the row, and it must
 * match. Otherwise a state minted for Slack could be redeemed at the Google
 * callback, and the handler would happily store a Slack grant as a Gmail one.
 *
 * Returns a result union rather than throwing: the caller is an HTTP action whose
 * job is to redirect the browser somewhere legible, and a thrown error there is a
 * 500 with a stack trace in it.
 */
export const consumeState = internalMutation({
  args: { state: v.string(), provider: providerValidator },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      userId: v.id("users"),
      provider: providerValidator,
      reconnectConnectionId: v.optional(v.id("connections")),
      returnTo: v.string(),
      appOrigin: v.optional(v.string()),
      codeVerifier: v.optional(v.string()),
    }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();

    if (row === null) return { ok: false as const, error: "unknown_state" };
    if (row.consumedAt !== undefined) return { ok: false as const, error: "state_replayed" };
    if (row.expiresAt < Date.now()) return { ok: false as const, error: "state_expired" };
    if (row.provider !== args.provider) {
      return { ok: false as const, error: "state_provider_mismatch" };
    }

    await ctx.db.patch("oauthStates", row._id, { consumedAt: Date.now() });

    return {
      ok: true as const,
      userId: row.userId,
      provider: row.provider,
      reconnectConnectionId: row.reconnectConnectionId,
      returnTo: sanitizeReturnTo(row.returnTo),
      // Re-checked on the way out for the same reason `returnTo` is: the row was
      // written by an earlier deploy's rules, and this is the last place the value
      // can be stopped before it becomes a redirect.
      appOrigin: resolveAppOrigin(row.appOrigin),
      codeVerifier: row.codeVerifier,
    };
  },
});

/**
 * Delete states that can no longer be redeemed. Driven by a cron.
 *
 * Consumed rows are kept for a full TTL past expiry rather than deleted on use:
 * while the row exists, a replay is answered with `state_replayed`, and once it
 * is gone the same replay looks like `unknown_state`. The former is the truth.
 */
export const gcExpiredStates = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - STATE_TTL_MS;
    const stale = await ctx.db
      .query("oauthStates")
      .filter((q) => q.lt(q.field("expiresAt"), cutoff))
      .take(args.batchSize ?? 200);

    for (const row of stale) {
      await ctx.db.delete("oauthStates", row._id);
    }
    return { deleted: stale.length };
  },
});
