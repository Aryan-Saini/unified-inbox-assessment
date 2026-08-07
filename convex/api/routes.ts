/**
 * The REST surface: one httpAction, one routing table.
 *
 * Mounted twice from `convex/http.ts` — under `/api/v1`, and under the bare
 * `/drafts…` paths the specification writes literally. Both mount points reach
 * this same table, so the alias cannot drift from the versioned route.
 *
 * ## Shape of every request
 *
 *   Authorization: Bearer uik_…   → sha256 → indexed lookup → a `userId`
 *
 * Authentication happens once, here, before any route runs; everything below it
 * receives an already-resolved user and can only see that user's rows. A request
 * for somebody else's id gets **404**, not 403 — 403 would confirm the row
 * exists, which is a slow enumeration oracle.
 *
 * ## The one interesting response
 *
 * `POST /drafts/{id}/send` claims the idempotency key in a single transaction and
 * then *waits* — up to five seconds — for the delivery to settle, so a `curl` in a
 * terminal usually shows the real outcome instead of a job id. Past that budget it
 * answers 202 with a `Retry-After`; holding the connection longer would be
 * pretending the send is synchronous when it is not.
 *
 * Two calls with the same key return **byte-identical bodies**. The fact that the
 * second one claimed nothing is reported in the `X-Idempotent-Replay` header, so
 * "prove the double-tap sent once" is `diff` on two response bodies.
 */

import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../core/crypto";
import { asAppError } from "../core/errors";
import { sleep } from "../core/http";
import { ALL_SOURCES } from "../core/registry";
import type { Source } from "../core/types";
import {
  API_PREFIX,
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  matchRoute,
  normalizePath,
  readJsonObject,
  readString,
  readStringArray,
  retryAfterSeconds,
} from "./http";

/** How long `POST /drafts/{id}/send` will wait for a terminal outcome. */
const SEND_POLL_BUDGET_MS = 5_000;
const SEND_POLL_INTERVAL_MS = 300;

/** The prefix every key carries. Checked before hashing, purely to give a useful
 *  401 to someone who pasted a Clerk token by mistake. */
const KEY_PREFIX = "uik_";

interface RequestContext {
  userId: Id<"users">;
  params: Record<string, string>;
  url: URL;
  /** Parsed JSON body: an object, `null` for an empty body. */
  body: Record<string, unknown> | null;
}

type Handler = (ctx: ActionCtx, rc: RequestContext) => Promise<Response>;

interface Route {
  method: "GET" | "POST";
  pattern: string;
  handler: Handler;
}

/* --------------------------------------------------------------- route handlers */

const runSearch: Handler = async (ctx, rc) => {
  const query = readString(rc.body, "query", "q");
  if (query === undefined) {
    return errorResponse(400, "BAD_REQUEST", "A search needs a `query` string.");
  }

  const requested = readStringArray(rc.body, "sources");
  const sources = requested?.filter((s): s is Source =>
    (ALL_SOURCES as string[]).includes(s),
  );
  if (requested !== undefined && (sources === undefined || sources.length === 0)) {
    return errorResponse(
      400,
      "BAD_REQUEST",
      `\`sources\` must contain at least one of ${ALL_SOURCES.join(", ")}.`,
    );
  }

  const { searchId } = await ctx.runMutation(internal.api.functions.createSearch, {
    userId: rc.userId,
    query,
    sources,
  });

  // 202: the fan-out is scheduled, not finished. The two URLs are the whole
  // protocol for reading it — status while it runs, results as they land.
  return jsonResponse(
    {
      search_id: searchId,
      status: "running",
      search_url: `${API_PREFIX}/searches/${searchId}`,
      results_url: `${API_PREFIX}/searches/${searchId}/results`,
    },
    202,
  );
};

const listSearches: Handler = async (ctx, rc) => {
  const searches = await ctx.runQuery(internal.api.functions.listSearches, {
    userId: rc.userId,
  });
  return jsonResponse({ count: searches.length, searches });
};

const getSearch: Handler = async (ctx, rc) => {
  const data = await ctx.runQuery(internal.api.functions.getSearch, {
    userId: rc.userId,
    searchId: rc.params.id,
  });
  return jsonResponse({
    ...data.search,
    sources: data.sources,
    results_url: `${API_PREFIX}/searches/${data.search.id}/results`,
  });
};

const getResults: Handler = async (ctx, rc) => {
  const requested = rc.url.searchParams.get("order") ?? "rank";
  if (requested !== "rank" && requested !== "arrival") {
    return errorResponse(400, "BAD_REQUEST", "`order` must be `rank` or `arrival`.");
  }

  const data = await ctx.runQuery(internal.api.functions.getResults, {
    userId: rc.userId,
    searchId: rc.params.id,
    order: requested,
  });
  return jsonResponse(data);
};

const rerunSearch: Handler = async (ctx, rc) => {
  const { searchId } = await ctx.runMutation(internal.api.functions.rerunSearch, {
    userId: rc.userId,
    searchId: rc.params.id,
  });
  return jsonResponse(
    {
      search_id: searchId,
      status: "running",
      rerun_of: rc.params.id,
      search_url: `${API_PREFIX}/searches/${searchId}`,
      results_url: `${API_PREFIX}/searches/${searchId}/results`,
    },
    202,
  );
};

const createDraft: Handler = async (ctx, rc) => {
  const channel = readString(rc.body, "channel");
  const connectionId = readString(rc.body, "connection_id", "connectionId");
  const to = readString(rc.body, "to", "recipient");
  const body = readString(rc.body, "body", "text");

  if (channel !== "gmail" && channel !== "slack") {
    return errorResponse(400, "BAD_REQUEST", "`channel` must be `gmail` or `slack`.");
  }
  if (connectionId === undefined) {
    return errorResponse(
      400,
      "BAD_REQUEST",
      "`connection_id` is required. GET /api/v1/connections lists the ones you hold.",
    );
  }
  if (to === undefined) return errorResponse(400, "BAD_REQUEST", "`to` is required.");
  if (body === undefined) return errorResponse(400, "BAD_REQUEST", "`body` is required.");

  const { draft, reused } = await ctx.runMutation(
    internal.api.functions.createDraftForApi,
    {
      userId: rc.userId,
      channel,
      connectionId,
      to,
      subject: readString(rc.body, "subject"),
      body,
      idempotencyKey: readString(rc.body, "idempotency_key", "idempotencyKey"),
      replyToResultId: readString(rc.body, "reply_to_result_id", "replyToResultId"),
    },
  );

  // 200 rather than 201 on a re-used key: nothing was created, and saying
  // otherwise would make a retried request look like a duplicate draft.
  return jsonResponse(
    {
      ...draft,
      confirm_url: `${API_PREFIX}/drafts/${draft.id}/confirm`,
      send_url: `${API_PREFIX}/drafts/${draft.id}/send`,
    },
    reused ? 200 : 201,
    { "x-idempotent-replay": reused ? "true" : "false" },
  );
};

const getDraft: Handler = async (ctx, rc) => {
  const draft = await ctx.runQuery(internal.api.functions.getDraft, {
    userId: rc.userId,
    draftId: rc.params.id,
  });
  return jsonResponse(draft);
};

const confirmDraft: Handler = async (ctx, rc) => {
  const reviewedHash = readString(
    rc.body,
    "reviewed_hash",
    "reviewedHash",
    "confirmation_hash",
    "confirmationHash",
  );
  if (reviewedHash === undefined) {
    return errorResponse(
      400,
      "BAD_REQUEST",
      "`reviewed_hash` is required. GET the draft first — its `review_hash` is the value to send back.",
    );
  }

  const draft = await ctx.runMutation(internal.api.functions.confirmDraftForApi, {
    userId: rc.userId,
    draftId: rc.params.id,
    reviewedHash,
  });
  return jsonResponse(draft);
};

/** Has this send stopped moving on its own? */
function isSettled(send: {
  status: string;
  next_retry_at?: string;
}): boolean {
  if (send.status === "queued" || send.status === "in_flight") return false;
  // A transient failure with a retry already scheduled is still in progress.
  if (send.status === "failed_transient" && send.next_retry_at !== undefined) return false;
  return true;
}

const sendDraft: Handler = async (ctx, rc) => {
  const acknowledged = readString(
    rc.body,
    "acknowledged_destination",
    "acknowledgedDestination",
  );
  if (acknowledged === undefined) {
    return errorResponse(
      409,
      "DESTINATION_NOT_ACKNOWLEDGED",
      "`acknowledged_destination` is required and must repeat the draft's recipient exactly. GET the draft to see it.",
    );
  }

  const claim = await ctx.runMutation(internal.api.functions.claimForApi, {
    userId: rc.userId,
    draftId: rc.params.id,
    acknowledgedDestination: acknowledged,
  });

  // The header, not the body, records that this call deduped — see the file
  // header for why the body has to stay identical across repeat calls.
  const headers = {
    "x-idempotent-replay": claim.claimed ? "false" : "true",
    "x-send-id": claim.sendId,
  };

  let send = claim.send;
  const deadline = Date.now() + SEND_POLL_BUDGET_MS;
  while (!isSettled(send) && Date.now() < deadline) {
    await sleep(SEND_POLL_INTERVAL_MS);
    const latest = await ctx.runQuery(internal.api.functions.sendStatus, {
      userId: rc.userId,
      sendId: claim.sendId,
    });
    if (latest === null) break;
    send = latest;
  }

  if (!isSettled(send)) {
    return jsonResponse({ ...send, send_url: `${API_PREFIX}/sends/${send.id}` }, 202, {
      ...headers,
      "retry-after": "2",
    });
  }

  // 200 for every settled outcome, including a failed one: the request to record
  // and attempt a delivery succeeded, and the delivery's own verdict is in
  // `status`. Mapping a provider's refusal onto our HTTP status would conflate
  // "your request was wrong" with "the message bounced".
  return jsonResponse({ ...send, send_url: `${API_PREFIX}/sends/${send.id}` }, 200, headers);
};

const listSends: Handler = async (ctx, rc) => {
  const sends = await ctx.runQuery(internal.api.functions.listSends, {
    userId: rc.userId,
  });
  return jsonResponse({ count: sends.length, sends });
};

const getSend: Handler = async (ctx, rc) => {
  const data = await ctx.runQuery(internal.api.functions.getSend, {
    userId: rc.userId,
    sendId: rc.params.id,
  });
  return jsonResponse({ ...data.send, attempts: data.attempts });
};

const retrySend: Handler = async (ctx, rc) => {
  const outcome = await ctx.runMutation(internal.api.functions.retryForApi, {
    userId: rc.userId,
    sendId: rc.params.id,
  });
  return jsonResponse({
    retried: outcome.retried,
    reason: outcome.reason,
    ...outcome.send,
  });
};

const listConnections: Handler = async (ctx, rc) => {
  const connections = await ctx.runQuery(internal.api.functions.listConnections, {
    userId: rc.userId,
  });
  return jsonResponse({ count: connections.length, connections });
};

/* ------------------------------------------------------------------ the table */

const ROUTES: Route[] = [
  { method: "POST", pattern: "/searches", handler: runSearch },
  { method: "GET", pattern: "/searches", handler: listSearches },
  { method: "GET", pattern: "/searches/:id", handler: getSearch },
  { method: "GET", pattern: "/searches/:id/results", handler: getResults },
  { method: "POST", pattern: "/searches/:id/rerun", handler: rerunSearch },
  { method: "POST", pattern: "/drafts", handler: createDraft },
  { method: "GET", pattern: "/drafts/:id", handler: getDraft },
  { method: "POST", pattern: "/drafts/:id/confirm", handler: confirmDraft },
  { method: "POST", pattern: "/drafts/:id/send", handler: sendDraft },
  { method: "GET", pattern: "/sends", handler: listSends },
  { method: "GET", pattern: "/sends/:id", handler: getSend },
  { method: "POST", pattern: "/sends/:id/retry", handler: retrySend },
  { method: "GET", pattern: "/connections", handler: listConnections },
];

/* -------------------------------------------------------------------- dispatch */

/**
 * Resolve `Authorization: Bearer uik_…` to a user, or explain the refusal.
 *
 * The plaintext key never leaves this function: it is hashed here and only the
 * digest is passed on, so no other function — and no log line inside one — can
 * see the credential.
 */
async function authenticate(
  ctx: ActionCtx,
  request: Request,
): Promise<{ userId: Id<"users"> } | Response> {
  const header = request.headers.get("authorization");
  if (header === null || !header.toLowerCase().startsWith("bearer ")) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Send an API key as `Authorization: Bearer uik_…`. Create one in Settings → API keys.",
      {},
      { "www-authenticate": 'Bearer realm="unified-inbox"' },
    );
  }

  const presented = header.slice("bearer ".length).trim();
  if (!presented.startsWith(KEY_PREFIX)) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      `That is not a unified-inbox API key — they all begin with \`${KEY_PREFIX}\`.`,
    );
  }

  const resolved = await ctx.runMutation(internal.apiKeys.authenticate, {
    hash: await sha256Hex(presented),
  });
  if (resolved === null) {
    // One answer for unknown and for revoked: telling them apart would confirm
    // that a stolen key was real before it was turned off.
    return errorResponse(401, "UNAUTHENTICATED", "That API key is not valid.");
  }

  return { userId: resolved.userId };
}

/** Map a thrown error onto the envelope. App errors carry their own status. */
function errorToResponse(err: unknown): Response {
  const app = asAppError(err);
  if (app !== null) {
    const headers: Record<string, string> = {};
    const extra: Record<string, unknown> = {};
    if (app.retryAfterMs !== undefined) {
      // The bucket's own arithmetic, not a guessed constant: a client that obeys
      // this header succeeds on its next try.
      const seconds = retryAfterSeconds(app.retryAfterMs);
      headers["retry-after"] = String(seconds);
      extra.retry_after_seconds = seconds;
    }
    return errorResponse(app.httpStatus, app.code, app.message, extra, headers);
  }

  // A `ConvexError` without our envelope, or a plain `Error`. We did not
  // classify it, so we cannot vouch that its message is safe to show — it may
  // carry internal detail or a stack. The real error is logged server-side; the
  // client gets a generic 500. (Classified app errors above keep their messages.)
  console.error("REST request failed", err);
  return errorResponse(500, "INTERNAL", "An internal error occurred.");
}

export const handleApiRequest = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const method = request.method === "HEAD" ? "GET" : request.method;

  // Route first, authenticate second — but only far enough to know the path
  // exists. An unknown path answers 404 without a credential, which is fine:
  // the routing table is public information, the data behind it is not.
  let matchedPath = false;
  for (const route of ROUTES) {
    const match = matchRoute(route.pattern, path);
    if (match === null) continue;
    matchedPath = true;
    if (route.method !== method) continue;

    const auth = await authenticate(ctx, request);
    if (auth instanceof Response) return auth;

    const body = method === "POST" ? await readJsonObject(request) : null;
    if (body === "invalid") {
      return errorResponse(400, "BAD_REQUEST", "The request body is not a JSON object.");
    }

    try {
      return await route.handler(ctx, {
        userId: auth.userId,
        params: match.params,
        url,
        body,
      });
    } catch (err) {
      return errorToResponse(err);
    }
  }

  if (matchedPath) {
    const allowed = ROUTES.filter((route) => matchRoute(route.pattern, path) !== null)
      .map((route) => route.method)
      .join(", ");
    return errorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      `${request.method} is not supported on this path.`,
      {},
      { allow: `${allowed}, OPTIONS` },
    );
  }

  return errorResponse(404, "NOT_FOUND", `No route matches ${request.method} ${path}.`, {
    routes: ROUTES.map((route) => `${route.method} ${API_PREFIX}${route.pattern}`),
  });
});
