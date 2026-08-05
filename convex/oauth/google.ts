/**
 * Google OAuth — pure fetch helpers.
 *
 * No Convex functions live here on purpose: this module knows how to talk to
 * Google and nothing about how the app stores the result, so it can be read (and
 * tested) as a description of Google's protocol rather than of our plumbing.
 *
 * Two Google-specific behaviours drive most of the code below:
 *
 *  1. A refresh token is issued only when the authorization request carries
 *     `access_type=offline`, and only on a *first* grant — a re-consent for
 *     scopes the user already granted returns none. `prompt=consent` on every
 *     authorization forces the consent screen so a reconnect really does return
 *     one. Even so, `exchangeCode` may legitimately return `refreshToken:
 *     undefined`, and the caller must then KEEP the refresh token it already
 *     has rather than overwrite it with nothing.
 *
 *  2. While the OAuth app is in testing mode, refresh tokens expire after seven
 *     days. That is not a bug to work around; it is the reconnect path becoming
 *     routinely demonstrable.
 */

import { AdapterError } from "../core/types";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * `openid`/`email` identify the account; the two Gmail scopes are the narrowest
 * pair that can search a mailbox and send from it. Notably absent:
 * `gmail.modify`, `gmail.compose`, and anything that could delete mail.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

/** The result of a code exchange or a refresh, normalised. */
export interface GoogleTokenGrant {
  accessToken: string;
  /** Absent when Google declined to issue a new one. Keep the stored one. */
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scopes: string[];
}

export interface GoogleIdentity {
  /** Google's immutable account id. */
  sub: string;
  email?: string;
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

export function googleClientId(): string {
  return requireEnv("GOOGLE_OAUTH_CLIENT_ID");
}

/**
 * Build the URL the browser is sent to.
 *
 * `include_granted_scopes` keeps a second Gmail account from silently dropping
 * scopes granted to the first, and `login_hint` on a reconnect preselects the
 * account so the user is less likely to sign in as somebody else (which the
 * callback then has to reject).
 */
export function authorizeUrl(args: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.loginHint !== undefined) {
    url.searchParams.set("login_hint", args.loginHint);
  }
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * POST the token endpoint and classify anything that is not a usable grant.
 *
 * This does not go through `fetchJson`: the token endpoint signals a dead grant
 * with `400 {"error":"invalid_grant"}`, and a generic status-code mapping would
 * call that "permanent" when the correct handling is to mark the connection
 * revoked and route the user to reconnect.
 */
async function postToken(
  form: Record<string, string>,
  context: string,
): Promise<GoogleTokenGrant> {
  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
    signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    bodyText = await response.text();
  } catch (err) {
    throw AdapterError.transient(
      `Google token endpoint unreachable during ${context}`,
      { detail: err instanceof Error ? err.message : String(err) },
    );
  }

  let body: GoogleTokenResponse = {};
  try {
    body = JSON.parse(bodyText) as GoogleTokenResponse;
  } catch {
    // Fall through: an unparseable body is classified from the status alone.
  }

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    const description =
      typeof body.error_description === "string" ? body.error_description : bodyText.slice(0, 500);
    const message = `Google ${context} failed: ${code} — ${description}`;
    const options = { httpStatus: response.status, detail: description };

    // The grant itself is gone: user revoked access, the refresh token expired
    // (7 days in testing mode), or the password changed.
    if (code === "invalid_grant") throw AdapterError.needsReconnect(message, options);
    if (response.status === 429 || response.status >= 500) {
      throw AdapterError.transient(message, options);
    }
    // invalid_client, redirect_uri_mismatch, bad code_verifier: our bug, not the
    // user's, and no retry fixes it.
    throw AdapterError.permanent(message, options);
  }

  if (typeof body.access_token !== "string") {
    throw AdapterError.transient(
      `Google ${context} returned 200 with no access_token`,
      { httpStatus: response.status, detail: bodyText.slice(0, 500) },
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
  };
}

/** Exchange an authorization code, completing PKCE with the stored verifier. */
export async function exchangeCode(args: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GoogleTokenGrant> {
  return await postToken(
    {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
      client_id: googleClientId(),
      client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    },
    "code exchange",
  );
}

/** Trade a refresh token for a fresh access token. */
export async function refresh(refreshToken: string): Promise<GoogleTokenGrant> {
  return await postToken(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: googleClientId(),
      client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    },
    "token refresh",
  );
}

/**
 * Who the grant belongs to.
 *
 * Both fields are returned because the caller uses the email as the connection's
 * identity and keeps `sub` available as the strictly-immutable fallback. That
 * tradeoff is argued where it is acted on, in `convex/http.ts`.
 */
export async function fetchIdentity(accessToken: string): Promise<GoogleIdentity> {
  const response = await fetch(USERINFO_ENDPOINT, {
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new AdapterError(
      response.status === 401 || response.status === 403 ? "needs_reconnect" : "transient",
      `Google userinfo returned ${response.status}`,
      { httpStatus: response.status, detail: bodyText.slice(0, 500) },
    );
  }

  let body: { sub?: unknown; email?: unknown } = {};
  try {
    body = JSON.parse(bodyText) as { sub?: unknown; email?: unknown };
  } catch {
    throw AdapterError.transient("Google userinfo returned unparseable JSON");
  }

  if (typeof body.sub !== "string") {
    throw AdapterError.transient("Google userinfo returned no `sub`");
  }
  return {
    sub: body.sub,
    email: typeof body.email === "string" ? body.email : undefined,
  };
}
