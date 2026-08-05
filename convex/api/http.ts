/**
 * REST plumbing: routing, envelopes, CORS, and reading untrusted bodies.
 *
 * Convex's router matches an exact path or a path *prefix*, and nothing in
 * between — there is no `/searches/:id/results` pattern. So the whole `/api/v1`
 * surface is mounted as a handful of prefix routes and dispatched here, by a
 * pattern matcher small enough to read in one sitting (`matchRoute`).
 *
 * Everything in this file is pure. No `ctx`, no database, no auth — which is
 * what makes the routing table testable without a deployment.
 */

/** Where the versioned surface lives. */
export const API_PREFIX = "/api/v1";

/**
 * Permissive CORS, deliberately.
 *
 * The credential is a bearer token in a header, never a cookie, so a browser on
 * another origin cannot make an authenticated request by accident — it has to be
 * given a key. `*` therefore grants nothing except the ability to try, and it
 * lets a reviewer poke the API from a scratch page or a Swagger UI.
 */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, idempotency-key",
  "access-control-max-age": "86400",
  vary: "origin",
};

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

/**
 * The single error envelope.
 *
 * One shape for every failure — `{ error: { code, message } }` — because a
 * client that has to guess whether today's 409 is `{error: "..."}` or
 * `{message: "..."}` ends up string-matching, and then our error text becomes
 * their API contract.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: { code, message, ...extra } }, status, headers);
}

/** Milliseconds → whole seconds, floor 1. `Retry-After: 0` invites a hot loop. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/* ------------------------------------------------------------------- routing */

export interface RouteMatch {
  params: Record<string, string>;
}

/**
 * Match a path against a pattern like `/searches/:id/results`.
 *
 * Segment count must match exactly: `/searches/abc/results/extra` does **not**
 * match, which is what stops a prefix route from silently accepting junk tails
 * and answering as though they were the real thing.
 */
export function matchRoute(pattern: string, path: string): RouteMatch | null {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(path);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(":")) {
      if (actual === "") return null;
      // A malformed escape (`%ZZ`) makes decodeURIComponent throw a URIError.
      // That is a bad path, not a server error: treat it as no-match so the
      // caller gets the ordinary JSON 404 envelope instead of a bare 500.
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
      continue;
    }
    if (expected !== actual) return null;
  }
  return { params };
}

function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/**
 * Strip the `/api/v1` prefix, if present, and normalise trailing slashes.
 *
 * Paths arriving without the prefix are the spec's literal `/drafts` and
 * `/drafts/{id}/send` aliases, which are mounted separately and land in the same
 * routing table. One table, two mount points — the alias cannot drift from the
 * versioned route because there is only one implementation.
 */
export function normalizePath(pathname: string): string {
  const withoutPrefix = pathname.startsWith(API_PREFIX)
    ? pathname.slice(API_PREFIX.length)
    : pathname;
  const trimmed = withoutPrefix.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/* ---------------------------------------------------------------- request body */

/**
 * Parse a JSON body into an object, or fail loudly.
 *
 * `null` is returned for an empty body — several routes take no arguments and a
 * `curl -X POST` with no `-d` should work rather than 400.
 */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null | "invalid"> {
  const text = await request.text();
  if (text.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalid";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "invalid";
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read a string field under any of several names.
 *
 * The spec writes request fields in `snake_case`; JavaScript clients tend to
 * send `camelCase`. Accepting both is being liberal in what we accept without
 * being ambiguous in what we mean — every alias set maps to one concept.
 */
export function readString(
  body: Record<string, unknown> | null,
  ...names: string[]
): string | undefined {
  if (body === null) return undefined;
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

export function readStringArray(
  body: Record<string, unknown> | null,
  ...names: string[]
): string[] | undefined {
  if (body === null) return undefined;
  for (const name of names) {
    const value = body[name];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value as string[];
    }
  }
  return undefined;
}

/** Epoch ms → ISO 8601, so every timestamp in the API reads the same way. */
export function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
