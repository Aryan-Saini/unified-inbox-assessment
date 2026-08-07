/**
 * Public HTTP surface of the Convex deployment.
 *
 * Two kinds of route live here: the Clerk webhook that keeps `users` in step with
 * Clerk, and the OAuth callbacks. Both are in Convex rather than in Next.js route
 * handlers because a Convex deployment already has a stable public URL
 * (`https://<slug>.convex.site`), so a webhook and a real OAuth redirect both
 * work while the frontend is still only running on localhost.
 */

import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { handleApiRequest } from "./api/routes";
import { encryptToken } from "./core/crypto";
import { redactError } from "./core/redact";
import { toAdapterError } from "./core/types";
import { redirectUriFor, sanitizeReturnTo } from "./oauth";
import * as google from "./oauth/google";
import * as slack from "./oauth/slack";

/** The subset of Clerk's `user.*` payload this app actually consumes. */
interface ClerkUserData {
  id: string;
  email_addresses?: { id: string; email_address: string }[];
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
}

interface ClerkEvent {
  type: string;
  data: ClerkUserData;
}

/**
 * Narrow Svix's verified payload to the shape above.
 *
 * A passing signature only proves Clerk sent it — not that the body looks the
 * way this code expects — so the shape is still checked before use.
 */
function asClerkEvent(payload: unknown): ClerkEvent | null {
  if (typeof payload !== "object" || payload === null) return null;

  const { type, data } = payload as { type?: unknown; data?: unknown };
  if (typeof type !== "string") return null;
  if (typeof data !== "object" || data === null) return null;
  if (typeof (data as { id?: unknown }).id !== "string") return null;

  return { type, data: data as ClerkUserData };
}

/**
 * Clerk sends every address on the account, so pick the primary one rather than
 * the first — otherwise a user who adds a second address can have their stored
 * email silently change.
 */
function primaryEmail(data: ClerkUserData): string | undefined {
  const addresses = data.email_addresses ?? [];
  const primary =
    addresses.find((a) => a.id === data.primary_email_address_id) ??
    addresses[0];
  return primary?.email_address;
}

function fullName(data: ClerkUserData): string | undefined {
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
  return name === "" ? undefined : name;
}

const handleClerkWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (secret === undefined) {
    // A misconfigured deployment is our fault, not the sender's. 500 makes Svix
    // retry, so events are not lost between deploying and setting the secret.
    console.error("CLERK_WEBHOOK_SIGNING_SECRET is not set on this deployment");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  // Must be the raw body: the signature covers the exact bytes Clerk sent, so
  // parsing and re-serialising first would invalidate it.
  const body = await request.text();
  const headers = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  };

  let event: ClerkEvent | null;
  try {
    event = asClerkEvent(new Webhook(secret).verify(body, headers));
  } catch (err) {
    // Bad signature or a replayed/stale timestamp. 400 so Svix stops retrying —
    // an unsigned request will never become signed.
    console.error("Clerk webhook signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event === null) {
    console.error("Clerk webhook payload was not in the expected shape");
    return new Response("Malformed payload", { status: 400 });
  }

  switch (event.type) {
    case "user.created":
    case "user.updated":
      await ctx.runMutation(internal.clerk.upsertFromClerk, {
        clerkUserId: event.data.id,
        email: primaryEmail(event.data),
        name: fullName(event.data),
        imageUrl: event.data.image_url ?? undefined,
      });
      break;

    case "user.deleted":
      await ctx.runMutation(internal.clerk.deleteFromClerk, {
        clerkUserId: event.data.id,
      });
      break;

    default:
      // Subscribing to extra events in the dashboard should not start failing
      // deliveries, so anything unhandled is acknowledged and ignored.
      console.log(`Ignoring unhandled Clerk event: ${event.type}`);
  }

  return new Response(null, { status: 200 });
});

/* ---------------------------------------------------------- OAuth callbacks */

type Provider = Doc<"connections">["provider"];

/**
 * Send the browser back into the app.
 *
 * `returnTo` has already been reduced to a path (`sanitizeReturnTo`) and is
 * re-checked here, because this is the function that would turn a bad value into
 * an actual open redirect. Resolving it against an origin we chose means the origin
 * is ours no matter what arrived.
 *
 * `appOrigin` is that origin when the flow recorded one — already run through
 * `resolveAppOrigin`, so it is either loopback or registered. It exists so the
 * frontend's port does not have to match a deployment env var. `APP_BASE_URL` is
 * the fallback, and the only option for the two failures that happen before there
 * is a state row to read.
 */
function redirectIntoApp(
  returnTo: string,
  params: Record<string, string>,
  appOrigin?: string,
): Response {
  const base = appOrigin ?? process.env.APP_BASE_URL;
  if (base === undefined || base === "") {
    // Nowhere safe to send them, and guessing an origin is how open redirects
    // get shipped. Fail visibly instead.
    return new Response(
      "APP_BASE_URL is not set on this deployment, so the OAuth callback has nowhere to return to.",
      { status: 500 },
    );
  }

  const target = new URL(sanitizeReturnTo(returnTo), base);

  // The last line of defence, and the reason it is an assertion rather than
  // another filter: `sanitizeReturnTo` decides what a path may look like, but
  // *this* is the function that turns a value into a `Location`. Comparing the
  // resolved origin against the one we chose means no future gap in the
  // sanitizer — a URL-parser quirk, a character nobody thought of — can send a
  // browser off-origin. It can only ever fall back to the app root.
  const expectedOrigin = new URL(base).origin;
  const safeTarget =
    target.origin === expectedOrigin ? target : new URL("/", base);

  for (const [key, value] of Object.entries(params)) {
    safeTarget.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { location: safeTarget.toString() },
  });
}

/** Errors are surfaced to the user as a query param, never as a raw 500 page. */
function oauthFailure(
  returnTo: string,
  error: string,
  detail?: string,
  appOrigin?: string,
): Response {
  return redirectIntoApp(
    returnTo,
    {
      oauth_error: error,
      ...(detail === undefined ? {} : { oauth_error_detail: detail.slice(0, 300) }),
    },
    appOrigin,
  );
}

interface GrantDetails {
  externalAccountId: string;
  label: string;
  accountEmail?: string;
  /** Who the grant belongs to inside the workspace — Slack's member name. */
  accountName?: string;
  teamName?: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Google half: exchange the code, then ask who it belongs to.
 *
 * The connection's identity is the **email address**, not the immutable `sub`.
 * That is a deliberate tradeoff. `sub` never changes, but it is an opaque number,
 * which would make every label, log line and reconnect-mismatch message
 * unreadable ("this connection is 118273…, you signed in as 994412…"). A Google
 * account's primary address changing is rare, and the cost when it happens is one
 * extra connection row the user can disconnect — cheap next to permanently
 * illegible identity. `sub` remains the fallback when no email scope was granted.
 */
async function googleGrant(code: string, codeVerifier: string): Promise<GrantDetails> {
  const grant = await google.exchangeCode({
    code,
    redirectUri: redirectUriFor("gmail"),
    codeVerifier,
  });
  const identity = await google.fetchIdentity(grant.accessToken);
  const externalAccountId = identity.email ?? identity.sub;

  return {
    externalAccountId,
    label: externalAccountId,
    accountEmail: identity.email,
    scopes: grant.scopes,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
  };
}

/** Slack half: one call returns the user token and the identity together. */
async function slackGrant(code: string): Promise<GrantDetails> {
  const grant = await slack.exchangeCode({
    code,
    redirectUri: redirectUriFor("slack"),
  });

  // The workspace names the connection; the member says whose view of it this
  // is. Read after the exchange because only the user token can ask.
  const accountName = await slack.fetchUserName({
    accessToken: grant.accessToken,
    userId: grant.slackUserId,
  });

  return {
    externalAccountId: grant.externalAccountId,
    label: grant.teamName,
    accountName,
    teamName: grant.teamName,
    scopes: grant.scopes,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresAt,
  };
}

/**
 * Finish an OAuth flow.
 *
 * The order is not negotiable: **consume the state first**. It is single-use,
 * expiring and provider-bound, and until it has been redeemed nothing about this
 * request is known to be legitimate — not the user it claims to be for, and not
 * where it is allowed to redirect afterwards.
 */
async function completeOAuth(
  ctx: ActionCtx,
  provider: Provider,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");

  // Without a state there is no verified `returnTo` and no verified origin, so
  // the only safe landing place is `APP_BASE_URL` at the app root.
  if (state === null) return oauthFailure("/", "missing_state");

  const consumed = await ctx.runMutation(internal.oauth.consumeState, { state, provider });
  if (!consumed.ok) return oauthFailure("/", consumed.error);

  const { returnTo, appOrigin, userId, reconnectConnectionId, codeVerifier } = consumed;

  // The user pressed Cancel, or the provider refused. Their word for it is more
  // useful than ours, so it is passed through as-is.
  if (providerError !== null) {
    return oauthFailure(returnTo, providerError, undefined, appOrigin);
  }
  if (code === null) return oauthFailure(returnTo, "missing_code", undefined, appOrigin);
  if (provider === "gmail" && codeVerifier === undefined) {
    return oauthFailure(returnTo, "missing_code_verifier", undefined, appOrigin);
  }

  try {
    const grant =
      provider === "gmail"
        ? await googleGrant(code, codeVerifier as string)
        : await slackGrant(code);

    // Identity first, tokens second: the ciphertexts are bound to the connection
    // id as authenticated data, so the row has to exist before it can be
    // encrypted for. See `convex/connections.ts`.
    const upsert = await ctx.runMutation(internal.connections.upsertFromGrant, {
      userId,
      provider,
      externalAccountId: grant.externalAccountId,
      label: grant.label,
      accountEmail: grant.accountEmail,
      accountName: grant.accountName,
      teamName: grant.teamName,
      scopes: grant.scopes,
      reconnectConnectionId,
    });

    if (!upsert.ok) {
      // Reconnected as the wrong account. Both labels are handed back so the app
      // can say which is which instead of "something went wrong".
      return redirectIntoApp(
        returnTo,
        {
          oauth_error: upsert.error,
          ...(upsert.expected === undefined ? {} : { oauth_expected: upsert.expected }),
          ...(upsert.actual === undefined ? {} : { oauth_actual: upsert.actual }),
        },
        appOrigin,
      );
    }

    const connectionId = upsert.connectionId;
    await ctx.runMutation(internal.connections.storeGrantTokens, {
      connectionId,
      accessTokenCipher: await encryptToken(grant.accessToken, {
        provider,
        connectionId,
        tokenType: "access",
      }),
      // Absent means "Google issued none this time", which must leave the stored
      // refresh token alone rather than clear it.
      refreshTokenCipher:
        grant.refreshToken === undefined
          ? undefined
          : await encryptToken(grant.refreshToken, {
              provider,
              connectionId,
              tokenType: "refresh",
            }),
      tokenExpiresAt: grant.expiresAt,
      scopes: grant.scopes,
    });

    return redirectIntoApp(
      returnTo,
      {
        connected: provider,
        account: grant.label,
      },
      appOrigin,
    );
  } catch (err) {
    const error = toAdapterError(err);
    // Redacted detail to the deployment log; a trimmed message to the URL bar.
    // The Slack bot-only-grant path can carry an `xoxb-` token in the provider
    // body, and a raw `console.error(error)` would serialise `error.detail` into
    // the log — so message and detail both go through `redactError` first.
    console.error(
      `OAuth callback failed for ${provider}`,
      redactError(error.message),
      redactError(error.detail),
    );
    return oauthFailure(
      returnTo,
      `exchange_failed_${error.kind}`,
      error.message,
      appOrigin,
    );
  }
}

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: handleClerkWebhook,
});

// `/oauth/google/…` rather than `/oauth/gmail/…`: the grant is a Google account
// grant and the registered redirect URI has to read that way in the console.
http.route({
  path: "/oauth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => await completeOAuth(ctx, "gmail", request)),
});

http.route({
  path: "/oauth/slack/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => await completeOAuth(ctx, "slack", request)),
});

/* -------------------------------------------------------------------- REST API */

/**
 * The API-key surface (`convex/api/routes.ts`).
 *
 * Convex routes an exact path or a path prefix, and `/searches/{id}/results` is
 * neither — so the whole surface is mounted as prefixes and dispatched by the
 * routing table inside the handler. `path` and `pathPrefix` are both registered
 * because a prefix of `/api/v1/` does not match the bare `/api/v1`.
 *
 * The second mount point is the specification's literal `/drafts` and
 * `/drafts/{id}/send`. Same table, same handler: the alias cannot behave
 * differently from the versioned route because there is only one of it.
 */
for (const method of ["GET", "POST", "OPTIONS"] as const) {
  http.route({ path: "/api/v1", method, handler: handleApiRequest });
  http.route({ pathPrefix: "/api/v1/", method, handler: handleApiRequest });
}

for (const method of ["POST", "OPTIONS"] as const) {
  http.route({ path: "/drafts", method, handler: handleApiRequest });
  http.route({ pathPrefix: "/drafts/", method, handler: handleApiRequest });
}

export default http;
