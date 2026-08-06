/**
 * Slack OAuth — pure fetch helpers.
 *
 * Three things about Slack shape this module:
 *
 *  1. `search.messages` is only available to a **user** token (`xoxp-`), never a
 *     bot token. So the install requests `user_scope` and the app reads
 *     `authed_user.access_token` — `access_token` at the top level is the bot
 *     token and is deliberately ignored.
 *
 *  2. Slack does not support PKCE on `oauth.v2.access`. The `state` parameter is
 *     the whole CSRF defence, which is why it is single-use, expiring, and bound
 *     to the provider on the way back in.
 *
 *  3. Slack reports application errors as **HTTP 200** with `{ok: false, error}`.
 *     Status-code classification is therefore useless here; the `error` string is
 *     the signal, and it is mapped explicitly below.
 *
 * Token rotation is intentionally left OFF on the Slack app: with rotation
 * disabled a user token does not expire, so there is no refresh to get wrong.
 * `refresh` is written and exported so enabling rotation later is a Slack-console
 * change plus a stored `expiresAt`, not new code — but nothing calls it today.
 */

import { AdapterError, type ErrorKind } from "../core/types";

const AUTHORIZE_ENDPOINT = "https://slack.com/oauth/v2/authorize";
const ACCESS_ENDPOINT = "https://slack.com/api/oauth.v2.access";

/**
 * The narrowest set that can search, post, resolve a user id to a name and
 * face, and count the replies on a thread it already found.
 *
 * The two `*:history` scopes are the loosest thing here and were added
 * deliberately: `conversations.replies` is the only way to learn that a result
 * has a thread hanging off it, and a Slack row without that is missing the
 * thing Slack itself puts in the message list. They are read-only, and the
 * adapter calls `conversations.replies` for a message it already has an id for
 * — never `conversations.history`, which is what actually reads a channel
 * wholesale. Still no `files:read` and no bot-wide access.
 *
 * Adding a scope invalidates nothing: an existing grant keeps working and
 * simply returns no reply counts until the user reconnects.
 */
export const SLACK_USER_SCOPES = [
  "search:read",
  "chat:write",
  "users:read",
  "channels:history",
  "groups:history",
];

export interface SlackGrant {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent unless the app has token rotation enabled. */
  expiresAt?: number;
  scopes: string[];
  /** `T…:U…` — the workspace-scoped user identity. */
  externalAccountId: string;
  teamId: string;
  teamName: string;
  slackUserId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw AdapterError.permanent(
      `${name} is not set on the Convex deployment. Set it with \`npx convex env set ${name} <value>\`.`,
    );
  }
  return value;
}

export function slackClientId(): string {
  return requireEnv("SLACK_CLIENT_ID");
}

export function authorizeUrl(args: { redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", slackClientId());
  // `user_scope`, not `scope`: requesting bot scopes as well would install a bot
  // this app has no use for, and would make the consent screen ask for more.
  url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  return url.toString();
}

/**
 * Map a Slack `error` string to a retry decision.
 *
 * Exported because the search adapter and the sender classify the same way — the
 * table has to live in exactly one place or the two will drift.
 */
export function classifySlackError(error: string): ErrorKind {
  switch (error) {
    case "token_revoked":
    case "token_expired":
    case "invalid_auth":
    case "not_authed":
    case "account_inactive":
    case "missing_scope":
    case "no_permission":
      return "needs_reconnect";
    case "ratelimited":
    case "rate_limited":
    case "service_unavailable":
    case "internal_error":
    case "fatal_error":
    case "request_timeout":
      return "transient";
    // Listed explicitly rather than left to the default so the classification
    // reads as a decision: these are all "the call was wrong", and repeating it
    // unchanged cannot help.
    case "channel_not_found":
    case "not_in_channel":
    case "is_archived":
    case "msg_too_long":
    case "invalid_arguments":
      return "permanent";
    default:
      // Unrecognised errors are permanent on purpose: an unclassified failure
      // retrying forever is worse than one an operator has to look at.
      return "permanent";
  }
}

interface SlackAccessResponse {
  ok?: unknown;
  error?: unknown;
  team?: { id?: unknown; name?: unknown };
  authed_user?: {
    id?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
}

async function postAccess(
  form: Record<string, string>,
  context: string,
): Promise<SlackGrant> {
  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(ACCESS_ENDPOINT, {
    signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    bodyText = await response.text();
  } catch (err) {
    throw AdapterError.transient(`Slack oauth.v2.access unreachable during ${context}`, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let body: SlackAccessResponse = {};
  try {
    body = JSON.parse(bodyText) as SlackAccessResponse;
  } catch {
    throw AdapterError.transient(`Slack ${context} returned unparseable JSON`, {
      httpStatus: response.status,
      detail: bodyText.slice(0, 500),
    });
  }

  if (body.ok !== true) {
    const error = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new AdapterError(
      classifySlackError(error),
      `Slack ${context} failed: ${error}`,
      { httpStatus: response.status, detail: bodyText.slice(0, 500) },
    );
  }

  const user = body.authed_user ?? {};
  if (typeof user.access_token !== "string" || typeof user.id !== "string") {
    // Almost always a scope mistake: bot scopes were granted and user scopes
    // were not, so Slack returns ok:true with no `authed_user.access_token`.
    throw AdapterError.permanent(
      `Slack ${context} returned no user token — the install must request user_scope, not scope.`,
      { detail: bodyText.slice(0, 500) },
    );
  }

  const teamId = typeof body.team?.id === "string" ? body.team.id : "unknown-team";
  const teamName = typeof body.team?.name === "string" ? body.team.name : teamId;

  return {
    accessToken: user.access_token,
    refreshToken: typeof user.refresh_token === "string" ? user.refresh_token : undefined,
    expiresAt:
      typeof user.expires_in === "number" ? Date.now() + user.expires_in * 1000 : undefined,
    scopes: typeof user.scope === "string" ? user.scope.split(",").filter(Boolean) : [],
    // A user has one identity per workspace, and the same person in two
    // workspaces is two connections, so the pair is the identity — not either
    // half of it.
    externalAccountId: `${teamId}:${user.id}`,
    teamId,
    teamName,
    slackUserId: user.id,
  };
}

/**
 * Exchange the code. Slack returns the grant *and* the identity in one call, so
 * there is no separate `fetchIdentity` round trip to make.
 */
export async function exchangeCode(args: {
  code: string;
  redirectUri: string;
}): Promise<SlackGrant> {
  return await postAccess(
    {
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: slackClientId(),
      client_secret: requireEnv("SLACK_CLIENT_SECRET"),
    },
    "code exchange",
  );
}

interface SlackUserInfoResponse {
  ok?: unknown;
  user?: {
    name?: unknown;
    real_name?: unknown;
    profile?: { display_name?: unknown; real_name?: unknown };
  };
}

/**
 * What the granting member is called in the workspace.
 *
 * The grant itself only carries `U…`, and a workspace name alone does not say
 * *whose* Slack this is — one workspace can be connected as any of its members,
 * and the search results differ per member. `users:read` is already in the
 * requested set, so this is one extra call rather than a wider consent screen.
 *
 * Best-effort by design: a name is a label, and failing to read it must not
 * fail a connection whose token is already valid.
 */
export async function fetchUserName(args: {
  accessToken: string;
  userId: string;
}): Promise<string | undefined> {
  try {
    const url = new URL("https://slack.com/api/users.info");
    url.searchParams.set("user", args.userId);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${args.accessToken}` },
    });
    const body = (await response.json()) as SlackUserInfoResponse;
    if (body.ok !== true) return undefined;

    const profile = body.user?.profile;
    for (const candidate of [
      profile?.display_name,
      profile?.real_name,
      body.user?.real_name,
      body.user?.name,
    ]) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rotate a refresh token. Unreachable unless token rotation is enabled on the
 * Slack app — see the note at the top of this file.
 */
export async function refresh(refreshToken: string): Promise<SlackGrant> {
  return await postAccess(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: slackClientId(),
      client_secret: requireEnv("SLACK_CLIENT_SECRET"),
    },
    "token refresh",
  );
}
