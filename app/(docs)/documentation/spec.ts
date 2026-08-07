/**
 * The API description, written once.
 *
 * Everything under `/documentation` is rendered from this file: the HTML page a
 * human reads, the markdown an agent `curl`s, and the OpenAPI document a client
 * generator consumes. Three renderings, one source — because the failure mode of
 * hand-written API docs is not being wrong on day one, it is the HTML and the
 * spec disagreeing on day ninety and nobody knowing which is the lie.
 *
 * The rule for editing: this file describes `convex/api/routes.ts` and
 * `convex/api/views.ts`. If a route, a status code or a field changes there, it
 * changes here, and the three renderings follow for free.
 */

/* --------------------------------------------------------------- deployment */

/** Shown when neither env var is set — a checkout with no deployment behind it. */
export const BASE_URL_PLACEHOLDER = "https://<deployment>.convex.site";

/**
 * Resolve the origin the REST API is served from.
 *
 * The REST surface belongs to the Convex deployment, not to Next.js, so the base
 * URL is the `.convex.site` origin — a different host from the one serving this
 * page.
 *
 * `NEXT_PUBLIC_CONVEX_SITE_URL` is preferred but **must not be required**:
 * `npx convex dev` writes it locally and `dev:deployed` sets it, but nothing sets
 * it on a deployed frontend, and a reviewer opening the deployed docs would then
 * find every example addressed to `<deployment>`. `NEXT_PUBLIC_CONVEX_URL` is
 * guaranteed present — `ConvexClientProvider` throws without it — and Convex
 * derives one host from the other by exactly this substitution, so deriving it
 * here is reading the same rule rather than guessing.
 *
 * Exported as a function so the substitution is testable without a build.
 */
export function resolveBaseUrl(
  siteUrl: string | undefined,
  cloudUrl: string | undefined,
): string {
  if (siteUrl !== undefined && siteUrl !== "") return siteUrl.replace(/\/+$/, "");
  if (cloudUrl !== undefined && cloudUrl.endsWith(".convex.cloud")) {
    return `${cloudUrl.slice(0, -".convex.cloud".length)}.convex.site`;
  }
  return BASE_URL_PLACEHOLDER;
}

/**
 * Read at module scope, from the two `NEXT_PUBLIC_*` names verbatim: Next.js
 * inlines these at build time by matching the literal `process.env.NAME`, so
 * they cannot be looked up dynamically.
 */
export const BASE_URL = resolveBaseUrl(
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
  process.env.NEXT_PUBLIC_CONVEX_URL,
);

export const API_PREFIX = "/api/v1";
export const API_BASE = `${BASE_URL}${API_PREFIX}`;

/** Everything a search can fan out to. Mirrors `ALL_SOURCES` in the registry. */
export const SOURCES = ["gmail", "slack", "web"] as const;

/** Sources you can send *through*. `web` is searchable but not replyable. */
export const CHANNELS = ["gmail", "slack"] as const;

/* ------------------------------------------------------------------- shapes */

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface StatusCode {
  status: number;
  description: string;
}

export interface Header {
  name: string;
  description: string;
}

export interface Endpoint {
  /** Anchor slug, and the OpenAPI `operationId`. */
  id: string;
  method: "GET" | "POST";
  /** Path relative to `/api/v1`, in OpenAPI template form. */
  path: string;
  /** The bare path the specification writes literally, mounted at the same table. */
  alias?: string;
  summary: string;
  /** Prose. Sentences, not bullet fragments — an agent reads this as context. */
  description: string;
  pathParams?: Field[];
  query?: Field[];
  body?: Field[];
  responses: StatusCode[];
  responseHeaders?: Header[];
  /** Name of the schema in `SCHEMAS` this returns, for the OpenAPI document. */
  returns?: string;
  /** A real, runnable `curl`. Uses `$API` and `$KEY` so a shell can paste a block. */
  curl: string;
  /** A representative body. Must be valid JSON — it is parsed for the examples. */
  example: string;
}

export interface Section {
  id: string;
  title: string;
  endpoints: Endpoint[];
}

/* ------------------------------------------------------------- object schemas */

/**
 * The response objects, described field by field.
 *
 * These mirror the validators in `convex/api/views.ts`, which Convex enforces at
 * runtime — so a field listed here that does not exist there would fail that
 * route's test, and a field added there without being added here is the one
 * drift this file cannot catch on its own. `publicResult` is the one to guard
 * hardest: the specification says a `Result` has exactly seven fields.
 */
export const SCHEMAS: Record<string, { title: string; note?: string; fields: Field[] }> = {
  Result: {
    title: "Result",
    note: "Exactly seven fields, whatever the source is and whatever the underlying row happens to carry. The projection strips ranking, threading and read state.",
    fields: [
      { name: "source", type: `"gmail" | "slack" | "web"`, required: true, description: "Which adapter produced it." },
      { name: "id", type: "string", required: true, description: "This API's id for the result. Pass it back as `reply_to_result_id` and your reply stays in the same thread." },
      { name: "title", type: "string", required: true, description: "Subject line, message heading, or page title." },
      { name: "snippet", type: "string", required: true, description: "A short extract. Never the full body." },
      { name: "author", type: "string", description: "Sender, where the source has one." },
      { name: "timestamp", type: "string (ISO 8601)", description: "Missing for sources with no reliable date, which is most web results." },
      { name: "url", type: "string", required: true, description: "Where a human can open it at the provider." },
    ],
  },

  Search: {
    title: "Search",
    fields: [
      { name: "id", type: "string", required: true, description: "The search id." },
      { name: "query", type: "string", required: true, description: "The normalised query that actually ran." },
      { name: "status", type: `"running" | "complete"`, required: true, description: "`complete` once every source has settled, succeeded or failed." },
      { name: "origin", type: `"ui" | "api" | "seed"`, required: true, description: "Searches you start over REST are recorded as `api`." },
      { name: "result_count", type: "number", required: true, description: "Results landed so far. Grows while `running`." },
      { name: "rerun_of", type: "string", description: "Set when this search came from a rerun, whether that was `/rerun` or the app. History is never overwritten." },
      { name: "is_seed", type: "boolean", required: true, description: "True for demo fixtures, which hold no provider grant." },
      { name: "created_at", type: "string (ISO 8601)", required: true, description: "When the fan-out was scheduled." },
      { name: "completed_at", type: "string (ISO 8601)", description: "When the last source settled." },
    ],
  },

  SourceRun: {
    title: "SourceRun",
    note: "One adapter's run inside a search. This is how a polling client finds out that two of five accounts already answered, and why the third one has not.",
    fields: [
      { name: "source", type: `"gmail" | "slack" | "web"`, required: true, description: "The adapter." },
      { name: "connection_id", type: "string", description: "Which grant answered, for account-scoped sources." },
      { name: "label", type: "string", required: true, description: "Human name for the account or provider." },
      { name: "status", type: `"pending" | "running" | "succeeded" | "failed" | "needs_reconnect"`, required: true, description: "Per-source, independent of every other source." },
      { name: "error_kind", type: `"transient" | "permanent" | "needs_reconnect" | "unknown"`, description: "The classification the retry loop acted on." },
      { name: "error_message", type: "string", description: "Redacted of credentials, not truncated." },
      { name: "attempt_count", type: "number", required: true, description: "Attempts made against this source." },
      { name: "result_count", type: "number", required: true, description: "Results this source contributed." },
      { name: "duration_ms", type: "number", description: "Wall time for the run, once it has finished." },
    ],
  },

  Draft: {
    title: "Draft",
    note: "A message that exists but is not authorised yet. Making one of these is the only way a message comes to exist, because there is no endpoint that takes a recipient and a body and just sends it.",
    fields: [
      { name: "id", type: "string", required: true, description: "The draft id." },
      { name: "channel", type: `"gmail" | "slack"`, required: true, description: "How it would be delivered." },
      { name: "connection_id", type: "string", required: true, description: "The grant it would be sent through." },
      { name: "to", type: "string", required: true, description: "The recipient. This exact string is what `/send` makes you echo back." },
      { name: "subject", type: "string", description: "Gmail only. Slack ignores it." },
      { name: "body", type: "string", required: true, description: "The message." },
      { name: "idempotency_key", type: "string", required: true, description: "Yours if you supplied one, otherwise minted here." },
      { name: "status", type: `"draft" | "confirmed" | "sent" | "failed"`, required: true, description: "Where in the gate this draft is." },
      { name: "revision", type: "number", required: true, description: "Goes up on every edit. It is part of the digest, so editing kills any confirmation." },
      { name: "confirmed", type: "boolean", required: true, description: "True when the stored confirmation still matches the current payload." },
      { name: "review_hash", type: "string", required: true, description: "SHA-256 of `canonical_payload`, and the value `/confirm` wants back. It comes back on create, read and confirm." },
      { name: "canonical_payload", type: "string", required: true, description: "The exact string the digest is taken over, so you can verify the hash yourself." },
      { name: "created_at", type: "string (ISO 8601)", required: true, description: "" },
      { name: "updated_at", type: "string (ISO 8601)", required: true, description: "" },
    ],
  },

  Send: {
    title: "Send",
    note: "A delivery attempt record. Two requests sharing an idempotency key get byte-identical bodies out of this projection, because nothing in here says which call produced it. The dedupe goes in the `X-Idempotent-Replay` header instead, so proving a double tap only sent once is a `diff` of two files.",
    fields: [
      { name: "id", type: "string", required: true, description: "The send id." },
      { name: "draft_id", type: "string", required: true, description: "The draft it was claimed from." },
      { name: "idempotency_key", type: "string", required: true, description: "The key this delivery is deduplicated under." },
      { name: "channel", type: `"gmail" | "slack"`, required: true, description: "" },
      { name: "connection_id", type: "string", required: true, description: "" },
      { name: "to", type: "string", required: true, description: "Frozen when the send was claimed, not read off the draft afterwards." },
      { name: "subject", type: "string", description: "" },
      { name: "body", type: "string", required: true, description: "" },
      { name: "status", type: `"queued" | "in_flight" | "succeeded" | "failed_transient" | "failed_permanent" | "needs_reconnect" | "unknown"`, required: true, description: "See the send status table below. `unknown` is a refusal to guess, not a failure." },
      { name: "attempt_count", type: "number", required: true, description: "" },
      { name: "max_attempts", type: "number", required: true, description: "Once we hit this the automatic retries stop and it is yours to decide about." },
      { name: "provider_message_id", type: "string", description: "The provider's id for the delivered message." },
      { name: "provider_thread_id", type: "string", description: "" },
      { name: "last_error_kind", type: `"transient" | "permanent" | "needs_reconnect" | "unknown"`, description: "" },
      { name: "last_error_message", type: "string", description: "" },
      { name: "next_retry_at", type: "string (ISO 8601)", description: "Set while an automatic retry is still scheduled, so a `failed_transient` with this set is still going." },
      { name: "is_seed", type: "boolean", required: true, description: "" },
      { name: "created_at", type: "string (ISO 8601)", required: true, description: "" },
      { name: "updated_at", type: "string (ISO 8601)", required: true, description: "" },
      { name: "completed_at", type: "string (ISO 8601)", description: "" },
    ],
  },

  Attempt: {
    title: "Attempt",
    note: "One try at a delivery. `GET /sends/{id}` gives you the whole timeline, which is what makes a failure something you can explain instead of just report.",
    fields: [
      { name: "attempt_number", type: "number", required: true, description: "1-based." },
      { name: "trigger", type: `"initial" | "auto" | "manual"`, required: true, description: "Who asked for this attempt. The first send, the retry scheduler, or you." },
      { name: "started_at", type: "string (ISO 8601)", required: true, description: "" },
      { name: "finished_at", type: "string (ISO 8601)", description: "" },
      { name: "outcome", type: `"succeeded" | "failed" | "unknown"`, description: "" },
      { name: "error_kind", type: `"transient" | "permanent" | "needs_reconnect" | "unknown"`, description: "" },
      { name: "error_message", type: "string", description: "The provider's error with credentials stripped out, but not cut short." },
      { name: "http_status", type: "number", description: "What the provider answered." },
      { name: "provider_message_id", type: "string", description: "" },
    ],
  },

  Connection: {
    title: "Connection",
    note: "Tokens, ciphertexts and lease state are missing by construction, not because someone forgot them.",
    fields: [
      { name: "id", type: "string", required: true, description: "Pass this as `connection_id` when creating a draft." },
      { name: "provider", type: `"gmail" | "slack"`, required: true, description: "" },
      { name: "external_account_id", type: "string", required: true, description: "The provider's identity for the account." },
      { name: "label", type: "string", required: true, description: "Email address, or Slack workspace name." },
      { name: "status", type: `"active" | "expired" | "errored" | "revoked"`, required: true, description: "Only `active` can search or send." },
      { name: "status_reason", type: "string", description: "Why it is not active." },
      { name: "enabled", type: "boolean", required: true, description: "Whether you have this account switched on for searches." },
      { name: "scopes", type: "string[]", required: true, description: "What the grant actually covers." },
      { name: "is_seed", type: "boolean", required: true, description: "Demo connections hold no real grant, so they can never reach a provider." },
      { name: "created_at", type: "string (ISO 8601)", required: true, description: "" },
      { name: "last_used_at", type: "string (ISO 8601)", description: "" },
    ],
  },

  Error: {
    title: "Error",
    note: "One shape for every failure that reaches the API, so switch on `error.code` and show `error.message`. A client that has to guess whether today's 409 is `{error: \"…\"}` or `{message: \"…\"}` ends up string-matching, and then our error text becomes their API contract. The one gap: only `GET`, `POST` and `OPTIONS` are mounted, so a `PUT` or a `DELETE` is refused by Convex itself and comes back as its plain 404 rather than this envelope.",
    fields: [
      { name: "error.code", type: "string", required: true, description: "The machine-readable reason. The contract." },
      { name: "error.message", type: "string", required: true, description: "Written for a human. Errors raised by our own rules carry the code as a prefix so a flattened log line still says which rule fired. The ones the REST layer writes directly, like a 401 or a malformed body, do not." },
      { name: "error.retry_after_seconds", type: "number", description: "On 429 only. It mirrors the `Retry-After` header and comes out of the bucket's own arithmetic, so obeying it actually works." },
    ],
  },
};

/* ------------------------------------------------------------------ endpoints */

export const SECTIONS: Section[] = [
  {
    id: "connections",
    title: "Connections",
    endpoints: [
      {
        id: "listConnections",
        method: "GET",
        path: "/connections",
        summary: "List the accounts you have",
        description:
          "Start here. A draft needs a `connection_id` and this is the only place one comes from. Connections get made by the OAuth flow in the web app and there is no REST route that adds one, because a token grant needs a browser and a consent screen.",
        responses: [{ status: 200, description: "`{count, connections: Connection[]}`." }],
        returns: "Connection",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/connections"`,
        example: `{
  "count": 2,
  "connections": [
    {
      "id": "k57d0h9wxqz4v2m1n8p3r6t0",
      "provider": "gmail",
      "external_account_id": "you@example.com",
      "label": "you@example.com",
      "status": "active",
      "enabled": true,
      "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
      "is_seed": false,
      "created_at": "2026-08-01T09:14:22.104Z",
      "last_used_at": "2026-08-06T11:02:51.882Z"
    },
    {
      "id": "k9821bcde4f6g8h0j2k4m6n8",
      "provider": "slack",
      "external_account_id": "T04AB12CD",
      "label": "aryan-test",
      "status": "active",
      "enabled": true,
      "scopes": ["search:read", "chat:write", "users:read"],
      "is_seed": false,
      "created_at": "2026-08-01T09:18:40.003Z"
    }
  ]
}`,
      },
    ],
  },

  {
    id: "searching",
    title: "Searching",
    endpoints: [
      {
        id: "createSearch",
        method: "POST",
        path: "/searches",
        summary: "Fan a query out across every source",
        description:
          "You get **202**, not 200, because the fan-out is scheduled and not finished. Every source runs on its own so a slow provider cannot hold up a fast one, and partial results are real results. Poll `search_url` for per-source status and `results_url` for the rows.",
        body: [
          { name: "query", type: "string", required: true, description: "What to search for. Also accepted as `q`." },
          { name: "sources", type: `("gmail" | "slack" | "web")[]`, description: "Narrow the fan-out. Defaults to all three. An array with none of them in it is a 400 instead of a silently empty search." },
        ],
        responses: [
          { status: 202, description: "`{search_id, status: \"running\", search_url, results_url}`." },
          { status: 400, description: "No `query`, or `sources` named nothing recognisable." },
          { status: 429, description: "Fan-out limit exhausted. `Retry-After` says when." },
        ],
        curl: `curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"query":"invoice"}' "$API/searches"`,
        example: `{
  "search_id": "j5720cd8e1f4a9b6c3d2e7f0",
  "status": "running",
  "search_url": "/api/v1/searches/j5720cd8e1f4a9b6c3d2e7f0",
  "results_url": "/api/v1/searches/j5720cd8e1f4a9b6c3d2e7f0/results"
}`,
      },

      {
        id: "getSearch",
        method: "GET",
        path: "/searches/{id}",
        summary: "Status of a search, source by source",
        description:
          "The `sources` array is the useful half. Each entry carries its own status, attempt count, duration and error. `status` on the search goes `complete` only once every source has settled, whether it succeeded *or* failed. One source failing does not fail the search.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The search id." }],
        responses: [
          { status: 200, description: "A `Search`, plus `sources: SourceRun[]` and `results_url`." },
          { status: 404, description: "No such search, or not yours. Same answer on purpose." },
        ],
        returns: "Search",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID"`,
        example: `{
  "id": "j5720cd8e1f4a9b6c3d2e7f0",
  "query": "invoice",
  "status": "running",
  "origin": "api",
  "result_count": 7,
  "is_seed": false,
  "created_at": "2026-08-06T11:04:02.331Z",
  "sources": [
    {
      "source": "gmail",
      "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
      "label": "you@example.com",
      "status": "succeeded",
      "attempt_count": 1,
      "result_count": 5,
      "duration_ms": 812
    },
    {
      "source": "slack",
      "connection_id": "k9821bcde4f6g8h0j2k4m6n8",
      "label": "aryan-test",
      "status": "running",
      "attempt_count": 1,
      "result_count": 0
    },
    {
      "source": "web",
      "label": "The Web",
      "status": "succeeded",
      "attempt_count": 1,
      "result_count": 2,
      "duration_ms": 640
    }
  ],
  "results_url": "/api/v1/searches/j5720cd8e1f4a9b6c3d2e7f0/results"
}`,
      },

      {
        id: "getResults",
        method: "GET",
        path: "/searches/{id}/results",
        summary: "The normalised results",
        description:
          "`partial` is true while at least one source is still working, and that is the flag a polling client should branch on instead of working it out again from `status`. Every row is exactly the seven public `Result` fields no matter which provider produced it.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The search id." }],
        query: [
          {
            name: "order",
            type: `"rank" | "arrival"`,
            description:
              "`rank` is the default and it is best-first, because an API consumer has no scroll position to protect. `arrival` is append-only, which is what a client polling a running search wants, since re-ranking would shuffle rows it has already shown.",
          },
        ],
        responses: [
          { status: 200, description: "`{search_id, status, order, partial, count, results: Result[]}`." },
          { status: 400, description: "`order` was neither `rank` nor `arrival`." },
          { status: 404, description: "No such search, or not yours." },
        ],
        returns: "Result",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID/results?order=rank"`,
        example: `{
  "search_id": "j5720cd8e1f4a9b6c3d2e7f0",
  "status": "complete",
  "order": "rank",
  "partial": false,
  "count": 2,
  "results": [
    {
      "source": "gmail",
      "id": "kd83jf0s9a2b4c6d8e0f2g4h",
      "title": "Re: invoice INV-2041",
      "snippet": "The copy attached to the last mail had the wrong total, corrected one to follow.",
      "author": "billing@acme.test",
      "timestamp": "2026-08-05T16:41:09.000Z",
      "url": "https://mail.google.com/mail/u/0/#inbox/18f2c9a0b1d3e5f7"
    },
    {
      "source": "slack",
      "id": "kb01xy2z3a4b5c6d7e8f9g0h",
      "title": "#finance",
      "snippet": "has anyone got the invoice for the August retainer?",
      "author": "George",
      "timestamp": "2026-08-05T09:22:44.000Z",
      "url": "https://aryan-test.slack.com/archives/C04FIN/p1754385764"
    }
  ]
}`,
      },

      {
        id: "listSearches",
        method: "GET",
        path: "/searches",
        summary: "Your search history",
        description: "Most recent first, capped at 50. `origin` tells you which of them a script ran.",
        responses: [{ status: 200, description: "`{count, searches: Search[]}`." }],
        returns: "Search",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/searches"`,
        example: `{
  "count": 1,
  "searches": [
    {
      "id": "j5720cd8e1f4a9b6c3d2e7f0",
      "query": "invoice",
      "status": "complete",
      "origin": "api",
      "result_count": 7,
      "is_seed": false,
      "created_at": "2026-08-06T11:04:02.331Z",
      "completed_at": "2026-08-06T11:04:04.918Z"
    }
  ]
}`,
      },

      {
        id: "rerunSearch",
        method: "POST",
        path: "/searches/{id}/rerun",
        summary: "Run the same query again",
        description:
          "Makes a **new** search carrying `rerun_of`, over the same sources as the original. It never overwrites the old one, because history that changes under you is not history.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The search to repeat." }],
        responses: [
          { status: 202, description: "`{search_id, status, rerun_of, search_url, results_url}`." },
          { status: 400, description: "The request body is not a JSON object." },
          { status: 404, description: "No such search, or not yours." },
          { status: 429, description: "Fan-out limit exhausted." },
        ],
        curl: `curl -sS -X POST -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID/rerun"`,
        example: `{
  "search_id": "j61a1de9f2b5c8d7e4f3a0b1",
  "status": "running",
  "rerun_of": "j5720cd8e1f4a9b6c3d2e7f0",
  "search_url": "/api/v1/searches/j61a1de9f2b5c8d7e4f3a0b1",
  "results_url": "/api/v1/searches/j61a1de9f2b5c8d7e4f3a0b1/results"
}`,
      },
    ],
  },

  {
    id: "sending",
    title: "Sending",
    endpoints: [
      {
        id: "createDraft",
        method: "POST",
        path: "/drafts",
        alias: "/drafts",
        summary: "Write a message without sending it",
        description:
          "**201** when it creates one, or **200** with `X-Idempotent-Replay: true` when that idempotency key was already used for this exact payload. Send a *different* payload under a key you already used and you get a 409, because the key names one message and not one request.",
        body: [
          { name: "channel", type: `"gmail" | "slack"`, required: true, description: "How it goes out." },
          { name: "connection_id", type: "string", required: true, description: "Comes from `GET /connections`. We also accept `connectionId`." },
          { name: "to", type: "string", required: true, description: "Email address, or Slack channel/user id. Also accepted as `recipient`." },
          { name: "subject", type: "string", description: "Gmail only." },
          { name: "body", type: "string", required: true, description: "The message. Also accepted as `text`." },
          { name: "idempotency_key", type: "string", description: "Pass your own so a retried request reads as the same message. We mint one if you do not. Also accepted as `idempotencyKey`." },
          { name: "reply_to_result_id", type: "string", description: "A `Result.id`. It carries the provider thread over so the reply lands in the conversation instead of next to it. Also accepted as `replyToResultId`." },
        ],
        responses: [
          { status: 201, description: "Created. A `Draft`, plus `confirm_url` and `send_url`." },
          { status: 200, description: "The key was re-used for the same payload. Same body, `X-Idempotent-Replay: true`." },
          { status: 400, description: "A field is missing, or `channel` is not `gmail` or `slack`." },
          { status: 404, description: "No such connection, or not yours." },
          { status: 409, description: "`IDEMPOTENCY_KEY_REUSED`, meaning a different payload under a key you already used. `CONNECTION_UNAVAILABLE` when the grant is off, revoked or the wrong provider. `INVALID_STATE` when a field is present but the value is rejected: too long, control characters in the recipient, or an idempotency key outside 8 to 128 characters of `[A-Za-z0-9._:-]`." },
          { status: 429, description: "Write limit exhausted." },
        ],
        responseHeaders: [
          { name: "X-Idempotent-Replay", description: "`true` when nothing got created." },
        ],
        returns: "Draft",
        curl: `curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "channel": "gmail",
  "connection_id": "'"$CONNECTION_ID"'",
  "to": "someone@example.com",
  "subject": "Re: invoice INV-2041",
  "body": "Attaching the corrected copy.",
  "idempotency_key": "agent-run-001"
}' "$API/drafts"`,
        example: `{
  "id": "kn40as8d7f6g5h4j3k2l1m0n",
  "channel": "gmail",
  "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
  "to": "someone@example.com",
  "subject": "Re: invoice INV-2041",
  "body": "Attaching the corrected copy.",
  "idempotency_key": "agent-run-001",
  "status": "draft",
  "revision": 1,
  "confirmed": false,
  "review_hash": "12c3160402fca3d7784b8626a534121e5e70210a17c8c65f529c527c0507947c",
  "canonical_payload": "v1|1:1|5:gmail|24:k57d0h9wxqz4v2m1n8p3r6t0|19:someone@example.com|20:Re: invoice INV-2041|29:Attaching the corrected copy.",
  "created_at": "2026-08-06T11:06:12.008Z",
  "updated_at": "2026-08-06T11:06:12.008Z",
  "confirm_url": "/api/v1/drafts/kn40as8d7f6g5h4j3k2l1m0n/confirm",
  "send_url": "/api/v1/drafts/kn40as8d7f6g5h4j3k2l1m0n/send"
}`,
      },

      {
        id: "getDraft",
        method: "GET",
        path: "/drafts/{id}",
        summary: "Read a draft back, and get its review hash",
        description:
          "Read the draft back before you confirm it. The hash also comes back on create, so the read matters most after an edit, when the revision has moved and the hash you are holding is stale. `canonical_payload` is the exact string the digest is taken over, so you can recompute the SHA-256 yourself instead of trusting ours.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The draft id." }],
        responses: [
          { status: 200, description: "A `Draft`." },
          { status: 404, description: "No such draft, or not yours." },
        ],
        returns: "Draft",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/drafts/$DRAFT_ID"`,
        example: `{
  "id": "kn40as8d7f6g5h4j3k2l1m0n",
  "channel": "gmail",
  "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
  "to": "someone@example.com",
  "subject": "Re: invoice INV-2041",
  "body": "Attaching the corrected copy.",
  "idempotency_key": "agent-run-001",
  "status": "draft",
  "revision": 1,
  "confirmed": false,
  "review_hash": "12c3160402fca3d7784b8626a534121e5e70210a17c8c65f529c527c0507947c",
  "canonical_payload": "v1|1:1|5:gmail|24:k57d0h9wxqz4v2m1n8p3r6t0|19:someone@example.com|20:Re: invoice INV-2041|29:Attaching the corrected copy.",
  "created_at": "2026-08-06T11:06:12.008Z",
  "updated_at": "2026-08-06T11:06:12.008Z"
}`,
      },

      {
        id: "confirmDraft",
        method: "POST",
        path: "/drafts/{id}/confirm",
        alias: "/drafts/{id}/confirm",
        summary: "Authorise the payload you just read",
        description:
          "Send back the `review_hash` from the read. The server re-derives the digest off the current row and compares, so a draft edited between the read and the confirm fails with `PAYLOAD_MISMATCH` instead of going through on a stale review. Confirming does not send.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The draft id." }],
        body: [
          {
            name: "reviewed_hash",
            type: "string",
            required: true,
            description:
              "The `review_hash` from `GET /drafts/{id}`. We also accept `reviewedHash`, `confirmation_hash` or `confirmationHash`.",
          },
        ],
        responses: [
          { status: 200, description: "The `Draft`, now with `status: \"confirmed\"` and `confirmed: true`." },
          { status: 400, description: "No `reviewed_hash`." },
          { status: 404, description: "No such draft, or not yours." },
          { status: 409, description: "`PAYLOAD_MISMATCH`, meaning that hash is not this payload's current digest. `INVALID_STATE` when the draft has already been sent or failed." },
          { status: 429, description: "Write limit exhausted." },
        ],
        returns: "Draft",
        curl: `curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"reviewed_hash":"'"$HASH"'"}' "$API/drafts/$DRAFT_ID/confirm"`,
        example: `{
  "id": "kn40as8d7f6g5h4j3k2l1m0n",
  "channel": "gmail",
  "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
  "to": "someone@example.com",
  "subject": "Re: invoice INV-2041",
  "body": "Attaching the corrected copy.",
  "idempotency_key": "agent-run-001",
  "status": "confirmed",
  "revision": 1,
  "confirmed": true,
  "review_hash": "12c3160402fca3d7784b8626a534121e5e70210a17c8c65f529c527c0507947c",
  "canonical_payload": "v1|1:1|5:gmail|24:k57d0h9wxqz4v2m1n8p3r6t0|19:someone@example.com|20:Re: invoice INV-2041|29:Attaching the corrected copy.",
  "created_at": "2026-08-06T11:06:12.008Z",
  "updated_at": "2026-08-06T11:06:31.442Z"
}`,
      },

      {
        id: "sendDraft",
        method: "POST",
        path: "/drafts/{id}/send",
        alias: "/drafts/{id}/send",
        summary: "Send it, naming the destination out loud",
        description:
          "`acknowledged_destination` has to repeat the draft's `to` **exactly**. Anything else is a 409 and nothing gets sent. Then the request *waits*, up to five seconds, for the delivery to settle, so your terminal usually shows the real outcome instead of a job id. Past that budget it answers **202** with `Retry-After` and a `send_url`, because holding the connection open longer would be pretending the send is synchronous when it is not.\n\nCall it twice on the same draft and you get **byte-identical bodies**. The fact that the second call claimed nothing lives in the header, not the body.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The draft id." }],
        body: [
          {
            name: "acknowledged_destination",
            type: "string",
            required: true,
            description: "The draft's `to`, character for character. Also accepted as `acknowledgedDestination`.",
          },
        ],
        responses: [
          { status: 200, description: "The delivery settled. You get a `Send`, including a failed one. See below." },
          { status: 202, description: "Still in flight after five seconds. You get `Retry-After: 2` and a `send_url` to poll." },
          { status: 400, description: "The request body is not a JSON object." },
          { status: 404, description: "No such draft, or not yours." },
          { status: 409, description: "`DESTINATION_NOT_ACKNOWLEDGED`, `CONFIRMATION_REQUIRED`, `PAYLOAD_CHANGED_SINCE_CONFIRM`, or `IDEMPOTENCY_KEY_REUSED` when the draft was edited after a send already claimed that key." },
          { status: 429, description: "Write limit exhausted." },
        ],
        responseHeaders: [
          { name: "X-Idempotent-Replay", description: "`true` when this call claimed nothing, because the send already existed." },
          { name: "X-Send-Id", description: "The send id. You get it even on a 202." },
          { name: "Retry-After", description: "Seconds to wait before polling `send_url`. Sent on the 202, and on a 429 with the bucket's own number." },
        ],
        returns: "Send",
        curl: `curl -sS -D - -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"acknowledged_destination":"someone@example.com"}' \\
  "$API/drafts/$DRAFT_ID/send"`,
        example: `{
  "id": "ks91zx8c7v6b5n4m3a2s1d0f",
  "draft_id": "kn40as8d7f6g5h4j3k2l1m0n",
  "idempotency_key": "agent-run-001",
  "channel": "gmail",
  "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
  "to": "someone@example.com",
  "subject": "Re: invoice INV-2041",
  "body": "Attaching the corrected copy.",
  "status": "succeeded",
  "attempt_count": 1,
  "max_attempts": 4,
  "provider_message_id": "18f2ca17b9d0e3f4",
  "provider_thread_id": "18f2c9a0b1d3e5f7",
  "is_seed": false,
  "created_at": "2026-08-06T11:06:44.117Z",
  "updated_at": "2026-08-06T11:06:45.902Z",
  "completed_at": "2026-08-06T11:06:45.902Z",
  "send_url": "/api/v1/sends/ks91zx8c7v6b5n4m3a2s1d0f"
}`,
      },
    ],
  },

  {
    id: "outbox",
    title: "Outbox",
    endpoints: [
      {
        id: "listSends",
        method: "GET",
        path: "/sends",
        summary: "Everything you have sent",
        description: "Most recent first, capped at 50.",
        responses: [{ status: 200, description: "`{count, sends: Send[]}`." }],
        returns: "Send",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/sends"`,
        example: `{
  "count": 1,
  "sends": [
    {
      "id": "ks91zx8c7v6b5n4m3a2s1d0f",
      "draft_id": "kn40as8d7f6g5h4j3k2l1m0n",
      "idempotency_key": "agent-run-001",
      "channel": "gmail",
      "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
      "to": "someone@example.com",
      "subject": "Re: invoice INV-2041",
      "body": "Attaching the corrected copy.",
      "status": "succeeded",
      "attempt_count": 1,
      "max_attempts": 4,
      "provider_message_id": "18f2ca17b9d0e3f4",
      "is_seed": false,
      "created_at": "2026-08-06T11:06:44.117Z",
      "updated_at": "2026-08-06T11:06:45.902Z",
      "completed_at": "2026-08-06T11:06:45.902Z"
    }
  ]
}`,
      },

      {
        id: "getSend",
        method: "GET",
        path: "/sends/{id}",
        summary: "One send, with every attempt",
        description:
          "The `attempts` array is the whole timeline. What was tried, when, what the provider answered, and how we classified the error. This is where a failure stops being a status word and turns into an explanation.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The send id." }],
        responses: [
          { status: 200, description: "A `Send`, plus `attempts: Attempt[]`." },
          { status: 404, description: "No such send, or not yours." },
        ],
        returns: "Send",
        curl: `curl -sS -H "Authorization: Bearer $KEY" "$API/sends/$SEND_ID"`,
        example: `{
  "id": "ks91zx8c7v6b5n4m3a2s1d0f",
  "draft_id": "kn40as8d7f6g5h4j3k2l1m0n",
  "idempotency_key": "agent-run-001",
  "channel": "gmail",
  "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
  "to": "someone@example.com",
  "body": "Attaching the corrected copy.",
  "status": "failed_transient",
  "attempt_count": 2,
  "max_attempts": 4,
  "last_error_kind": "transient",
  "last_error_message": "Gmail answered 503 Service Unavailable.",
  "next_retry_at": "2026-08-06T11:07:04.000Z",
  "is_seed": false,
  "created_at": "2026-08-06T11:06:44.117Z",
  "updated_at": "2026-08-06T11:06:52.310Z",
  "attempts": [
    {
      "attempt_number": 1,
      "trigger": "initial",
      "started_at": "2026-08-06T11:06:44.220Z",
      "finished_at": "2026-08-06T11:06:46.014Z",
      "outcome": "failed",
      "error_kind": "transient",
      "error_message": "Gmail answered 503 Service Unavailable.",
      "http_status": 503
    },
    {
      "attempt_number": 2,
      "trigger": "auto",
      "started_at": "2026-08-06T11:06:50.500Z",
      "finished_at": "2026-08-06T11:06:52.310Z",
      "outcome": "failed",
      "error_kind": "transient",
      "error_message": "Gmail answered 503 Service Unavailable.",
      "http_status": 503
    }
  ]
}`,
      },

      {
        id: "retrySend",
        method: "POST",
        path: "/sends/{id}/retry",
        summary: "Try a failed delivery again",
        description:
          "Fine for a failed send. **Refused with a 409 for an `unknown` one**, because that status means the outcome genuinely is not known, so retrying under the same key could double-send. Choosing between reconciling at the provider and cloning the draft under a new key belongs to an operator, not a retry loop.",
        pathParams: [{ name: "id", type: "string", required: true, description: "The send id." }],
        responses: [
          { status: 200, description: "`{retried, ...Send}`. `reason` only shows up when `retried` is `false`, and it is one of `already_delivered` or `attempt_in_progress`. The `status` you get back is the pre-retry one, because the new attempt is scheduled rather than applied inline." },
          { status: 404, description: "No such send, or not yours." },
          { status: 409, description: "`INDETERMINATE`, meaning the send is `unknown` and must not be retried blind." },
          { status: 429, description: "Write limit exhausted." },
        ],
        returns: "Send",
        curl: `curl -sS -X POST -H "Authorization: Bearer $KEY" "$API/sends/$SEND_ID/retry"`,
        example: `{
  "retried": true,
  "id": "ks91zx8c7v6b5n4m3a2s1d0f",
  "draft_id": "kn40as8d7f6g5h4j3k2l1m0n",
  "idempotency_key": "agent-run-001",
  "channel": "gmail",
  "connection_id": "k57d0h9wxqz4v2m1n8p3r6t0",
  "to": "someone@example.com",
  "body": "Attaching the corrected copy.",
  "status": "failed_transient",
  "attempt_count": 2,
  "max_attempts": 4,
  "last_error_kind": "transient",
  "last_error_message": "Gmail answered 503 Service Unavailable.",
  "is_seed": false,
  "created_at": "2026-08-06T11:06:44.117Z",
  "updated_at": "2026-08-06T11:07:10.884Z"
}`,
      },
    ],
  },
];

/** Flattened, for the OpenAPI generator and the table of contents. */
export const ENDPOINTS: Endpoint[] = SECTIONS.flatMap((section) => section.endpoints);

/* --------------------------------------------------------------- error codes */

export interface ErrorCode {
  code: string;
  status: number;
  meaning: string;
  /** What a client, human or agent, should actually do about it. */
  action: string;
}

export const ERROR_CODES: ErrorCode[] = [
  {
    code: "UNAUTHENTICATED",
    status: 401,
    meaning: "No key, a broken one, or one that got revoked. A missing or non-bearer `Authorization` header also gets a `WWW-Authenticate` header back.",
    action: "Stop. Retrying will not help. Unknown and revoked answer the same on purpose, because telling them apart would confirm a stolen key was real before it got turned off.",
  },
  {
    code: "NOT_FOUND",
    status: 404,
    meaning: "No such row, or it is not yours.",
    action: "Stop. These two look the same on purpose, because a 403 would confirm the row is there and that is a slow way to enumerate.",
  },
  {
    code: "BAD_REQUEST",
    status: 400,
    meaning: "A missing field, a bad enum, or a body that is not a JSON object.",
    action: "Fix the request. The message names the field.",
  },
  {
    code: "DESTINATION_NOT_ACKNOWLEDGED",
    status: 409,
    meaning: "`/send` got called without `acknowledged_destination`, or with one that does not match the draft's `to`.",
    action: "`GET` the draft, copy `to` exactly, send again. Do not build the value out of your own state.",
  },
  {
    code: "CONFIRMATION_REQUIRED",
    status: 409,
    meaning: "`/send` on a draft nobody ever confirmed.",
    action: "`GET` the draft, then `POST /confirm` with its `review_hash`.",
  },
  {
    code: "PAYLOAD_MISMATCH",
    status: 409,
    meaning: "`/confirm` got a hash that is not the payload's current digest.",
    action: "Re-read the draft and confirm with the fresh `review_hash`. The payload changed after you read it.",
  },
  {
    code: "PAYLOAD_CHANGED_SINCE_CONFIRM",
    status: 409,
    meaning: "The draft got confirmed and then edited, so the confirmation no longer describes the message.",
    action: "Re-read and re-confirm. The gate is doing its job.",
  },
  {
    code: "IDEMPOTENCY_KEY_REUSED",
    status: 409,
    meaning: "Two different payloads under one idempotency key.",
    action: "Use a new key for a genuinely new message. A key names one message, not one request.",
  },
  {
    code: "CONNECTION_UNAVAILABLE",
    status: 409,
    meaning: "The connection is off, revoked, or the wrong provider for that channel.",
    action: "`GET /connections` and pick one with `status: \"active\"`. Reconnecting needs a browser.",
  },
  {
    code: "INVALID_STATE",
    status: 409,
    meaning: "Either the row is in a status this operation does not apply to, or a field value was rejected: over a length cap, control characters in the recipient, a malformed idempotency key.",
    action: "Read the message. It says whether the problem is the row's status or one of the values you sent.",
  },
  {
    code: "INDETERMINATE",
    status: 409,
    meaning: "The delivery outcome genuinely is not known, so retrying could double-send.",
    action: "**Do not retry automatically.** Reconcile at the provider, or clone the draft under a new idempotency key. This is a refusal to guess, not a failure.",
  },
  {
    code: "RATE_LIMITED",
    status: 429,
    meaning: "A per-user token bucket is empty.",
    action: "Sleep for `Retry-After` seconds and retry. That value comes out of the bucket's own arithmetic, so obeying it actually works.",
  },
  {
    code: "METHOD_NOT_ALLOWED",
    status: 405,
    meaning: "The path exists, the method does not. Only `GET`, `POST` and `OPTIONS` reach the API at all.",
    action: "Read the `Allow` header on the response, which lists the methods that path does take.",
  },
  {
    code: "INTERNAL",
    status: 500,
    meaning: "Something we did not classify. The real error is in the deployment log.",
    action: "Retry once with backoff, then stop and report it.",
  },
];

/* ---------------------------------------------------------- send status table */

export const SEND_STATUSES: { status: string; meaning: string; retryable: string }[] = [
  { status: "queued", meaning: "Claimed, not tried yet.", retryable: "Wait." },
  { status: "in_flight", meaning: "An attempt is running right now.", retryable: "Wait." },
  { status: "succeeded", meaning: "The provider took it. `provider_message_id` is set.", retryable: "Done." },
  {
    status: "failed_transient",
    meaning: "A failure worth retrying. If `next_retry_at` is set then an automatic retry is already scheduled.",
    retryable: "Wait if `next_retry_at` is set, otherwise `POST /sends/{id}/retry`.",
  },
  { status: "failed_permanent", meaning: "The provider refused in a way that is not going to change. A bad address, a rejected message.", retryable: "Fix the payload and send a new draft under a new key." },
  { status: "needs_reconnect", meaning: "The grant is not valid any more.", retryable: "Reconnect the account in the web app, then retry." },
  {
    status: "unknown",
    meaning: "The attempt came back with no verdict, so it may or may not have gone out.",
    retryable: "**Never retry blind.** `POST /retry` answers 409 `INDETERMINATE`. Reconcile at the provider.",
  },
];

/* ------------------------------------------------------------- rate limits */

export const RATE_LIMITS: { name: string; limit: string; covers: string }[] = [
  {
    name: "Fan-out",
    limit: "10 / minute",
    covers: "`POST /searches` and `POST /searches/{id}/rerun`. One search is a call per enabled connection plus the web, so it is the expensive one.",
  },
  {
    name: "Writes",
    limit: "30 / minute",
    covers: "`POST /drafts`, `/confirm`, `/send`, and `/sends/{id}/retry`.",
  },
];
