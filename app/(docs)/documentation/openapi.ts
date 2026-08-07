/**
 * The OpenAPI 3.1 rendering.
 *
 * Built from the same `spec.ts` the page and the markdown are, so the three
 * cannot drift. What lives *here* rather than there is the one thing the other
 * two renderings do not need: the exact JSON Schema of each success body,
 * including the wrappers (`{count, connections}`, the `sources` hung off a
 * search) that are not part of any single object shape.
 *
 * Field types in `spec.ts` are written for a human — `"gmail" | "slack"`,
 * `string (ISO 8601)`, `string[]` — and `jsonSchema` below translates them.
 * That keeps the human rendering readable without keeping a second, parallel
 * type declaration in sync with it.
 */

import {
  API_BASE,
  ENDPOINTS,
  ERROR_CODES,
  SCHEMAS,
  type Endpoint,
  type Field,
} from "./spec";

/** Loose JSON-Schema-shaped value. The document is emitted as JSON, not typed. */
type Schema = Record<string, unknown>;

/* ------------------------------------------------------------ type translation */

/**
 * Turn a human-written type into JSON Schema.
 *
 * Four forms appear in `spec.ts`, and anything unrecognised degrades to
 * `{type: "string"}` rather than throwing — a documentation route that 500s
 * because someone wrote a new type string is worse than one that is slightly
 * vague about a single field.
 */
function jsonSchema(type: string): Schema {
  const trimmed = type.trim();

  // `("a" | "b")[]` and `string[]`
  const arrayMatch = /^\(?(.+?)\)?\[\]$/.exec(trimmed);
  if (arrayMatch !== null) {
    return { type: "array", items: jsonSchema(arrayMatch[1]) };
  }

  // `"a" | "b" | "c"`
  if (trimmed.includes('"')) {
    const values = [...trimmed.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (values.length > 0) return { type: "string", enum: values };
  }

  if (trimmed.startsWith("number")) return { type: "number" };
  if (trimmed.startsWith("boolean")) return { type: "boolean" };
  if (trimmed.includes("ISO 8601")) return { type: "string", format: "date-time" };
  return { type: "string" };
}

function objectSchema(name: string): Schema {
  const schema = SCHEMAS[name];
  const properties: Record<string, Schema> = {};
  const required: string[] = [];

  for (const field of schema.fields) {
    properties[field.name] = {
      ...jsonSchema(field.type),
      ...(field.description === "" ? {} : { description: field.description }),
    };
    if (field.required === true) required.push(field.name);
  }

  return {
    type: "object",
    ...(schema.note === undefined ? {} : { description: schema.note }),
    properties,
    ...(required.length === 0 ? {} : { required }),
    // Deliberately NOT `additionalProperties: false`. Five operations compose
    // these with `allOf` to hang an envelope field off the object (`send_url`,
    // `attempts`, `sources`, `retried`), and under JSON Schema each `allOf`
    // branch is evaluated independently — so a closed ref branch rejects the
    // exact fields the sibling branch adds, and every real response of those
    // five would fail validation. Closing the object here would be describing a
    // shape the API never returns.
  };
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/* --------------------------------------------------------- response envelopes */

/**
 * The success body of each operation.
 *
 * Written out rather than derived because the envelopes are genuinely
 * per-operation: a list wraps its rows in `{count, …}`, a search read hangs
 * `sources` off the object, a send read hangs `attempts`. Keyed by
 * `Endpoint.id`; a route added to `spec.ts` without an entry here emits a
 * success response with no schema, which `openapi.test.ts` fails on.
 */
const SUCCESS: Record<string, Schema> = {
  listConnections: {
    type: "object",
    properties: { count: { type: "integer" }, connections: { type: "array", items: ref("Connection") } },
    required: ["count", "connections"],
  },

  createSearch: {
    type: "object",
    properties: {
      search_id: { type: "string" },
      status: { type: "string", enum: ["running"] },
      search_url: { type: "string" },
      results_url: { type: "string" },
    },
    required: ["search_id", "status", "search_url", "results_url"],
  },

  getSearch: {
    allOf: [
      ref("Search"),
      {
        type: "object",
        properties: {
          sources: { type: "array", items: ref("SourceRun") },
          results_url: { type: "string" },
        },
        required: ["sources", "results_url"],
      },
    ],
  },

  getResults: {
    type: "object",
    properties: {
      search_id: { type: "string" },
      status: { type: "string", enum: ["running", "complete"] },
      order: { type: "string", enum: ["rank", "arrival"] },
      partial: { type: "boolean", description: "True while at least one source is still working." },
      count: { type: "integer" },
      results: { type: "array", items: ref("Result") },
    },
    required: ["search_id", "status", "order", "partial", "count", "results"],
  },

  listSearches: {
    type: "object",
    properties: { count: { type: "integer" }, searches: { type: "array", items: ref("Search") } },
    required: ["count", "searches"],
  },

  rerunSearch: {
    type: "object",
    properties: {
      search_id: { type: "string" },
      status: { type: "string", enum: ["running"] },
      rerun_of: { type: "string" },
      search_url: { type: "string" },
      results_url: { type: "string" },
    },
    required: ["search_id", "status", "rerun_of", "search_url", "results_url"],
  },

  createDraft: {
    allOf: [
      ref("Draft"),
      {
        type: "object",
        properties: { confirm_url: { type: "string" }, send_url: { type: "string" } },
        required: ["confirm_url", "send_url"],
      },
    ],
  },

  getDraft: ref("Draft"),
  confirmDraft: ref("Draft"),

  sendDraft: {
    allOf: [ref("Send"), { type: "object", properties: { send_url: { type: "string" } }, required: ["send_url"] }],
  },

  listSends: {
    type: "object",
    properties: { count: { type: "integer" }, sends: { type: "array", items: ref("Send") } },
    required: ["count", "sends"],
  },

  getSend: {
    allOf: [
      ref("Send"),
      { type: "object", properties: { attempts: { type: "array", items: ref("Attempt") } }, required: ["attempts"] },
    ],
  },

  retrySend: {
    allOf: [
      ref("Send"),
      {
        type: "object",
        properties: {
          retried: { type: "boolean" },
          reason: {
            type: "string",
            description:
              "Only present when `retried` is false. One of `already_delivered` or `attempt_in_progress`.",
          },
        },
        required: ["retried"],
      },
    ],
  },
};

/* ------------------------------------------------------------------ operations */

function parameters(fields: Field[] | undefined, location: "path" | "query"): Schema[] {
  return (fields ?? []).map((field) => ({
    name: field.name,
    in: location,
    required: location === "path" ? true : field.required === true,
    description: field.description,
    schema: jsonSchema(field.type),
  }));
}

/** The example bodies in `spec.ts` are literals we control, so a parse failure is
 *  a typo caught at request time rather than an untrusted input. */
function parseExample(endpoint: Endpoint): unknown {
  try {
    return JSON.parse(endpoint.example);
  } catch {
    return undefined;
  }
}

function operation(endpoint: Endpoint): Schema {
  const example = parseExample(endpoint);
  const success = SUCCESS[endpoint.id];

  const responses: Record<string, Schema> = {
    // Every authenticated operation can answer these, and repeating them in
    // `spec.ts` on all thirteen routes would be noise a reader has to skip.
    // A generator, though, wants them on the operation.
    "401": {
      description: "No key, a malformed one, or one that has been revoked.",
      content: { "application/json": { schema: ref("Error") } },
      headers: {
        "WWW-Authenticate": {
          description: "Sent when the `Authorization` header is missing or is not a bearer scheme.",
          schema: { type: "string" },
        },
      },
    },
    "500": {
      description: "An unclassified failure. The real error is in the deployment log.",
      content: { "application/json": { schema: ref("Error") } },
    },
  };
  for (const [index, response] of endpoint.responses.entries()) {
    const isSuccess = response.status < 300;
    responses[String(response.status)] = {
      description: response.description,
      content: {
        "application/json": {
          schema: isSuccess ? success : ref("Error"),
          // The example belongs to the first success status only: a 200 and a
          // 201 on the same route are the same body, and repeating it under both
          // suggests they differ.
          ...(isSuccess && index === 0 && example !== undefined ? { example } : {}),
        },
      },
      ...(response.status === 429
        ? {
            headers: {
              "Retry-After": {
                description: "Seconds until the bucket refills. Computed, not a constant.",
                schema: { type: "integer" },
              },
            },
          }
        : {}),
      ...(endpoint.responseHeaders === undefined || !isSuccess
        ? {}
        : {
            headers: Object.fromEntries(
              endpoint.responseHeaders.map((header) => [
                header.name,
                { description: header.description, schema: { type: "string" } },
              ]),
            ),
          }),
    };
  }

  const bodyProperties: Record<string, Schema> = {};
  const bodyRequired: string[] = [];
  for (const field of endpoint.body ?? []) {
    bodyProperties[field.name] = { ...jsonSchema(field.type), description: field.description };
    if (field.required === true) bodyRequired.push(field.name);
  }

  return {
    operationId: endpoint.id,
    summary: endpoint.summary,
    description: [
      endpoint.description,
      endpoint.alias === undefined
        ? null
        : `Also mounted at the bare path \`${endpoint.method} ${endpoint.alias}\`, reaching the same handler.`,
      "",
      "```bash",
      endpoint.curl,
      "```",
    ]
      .filter((part) => part !== null)
      .join("\n\n"),
    parameters: [...parameters(endpoint.pathParams, "path"), ...parameters(endpoint.query, "query")],
    ...(endpoint.body === undefined
      ? {}
      : {
          requestBody: {
            required: bodyRequired.length > 0,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: bodyProperties,
                  ...(bodyRequired.length === 0 ? {} : { required: bodyRequired }),
                },
              },
            },
          },
        }),
    responses,
  };
}

/* -------------------------------------------------------------------- document */

export function openApiDocument(origin: string): Schema {
  const paths: Record<string, Schema> = {};
  for (const endpoint of ENDPOINTS) {
    const path = endpoint.path;
    paths[path] = { ...(paths[path] ?? {}), [endpoint.method.toLowerCase()]: operation(endpoint) };
  }

  const schemas: Record<string, Schema> = {};
  for (const name of Object.keys(SCHEMAS)) {
    if (name === "Error") continue;
    schemas[name] = objectSchema(name);
  }

  // Hand-written, because the error shape is nested and `SCHEMAS.Error`
  // describes it with dotted paths for the human rendering.
  schemas.Error = {
    type: "object",
    description:
      "One shape for every failure. Switch on `error.code`; show `error.message`.",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string", enum: ERROR_CODES.map((e) => e.code) },
          message: { type: "string" },
          retry_after_seconds: {
            type: "integer",
            description: "On 429 only. Mirrors the `Retry-After` header.",
          },
        },
        required: ["code", "message"],
      },
    },
    required: ["error"],
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Unified Inbox API",
      version: "1.0.0",
      summary:
        "Search Gmail, Slack and the web from one place, and send replies only after an explicit confirmation step.",
      description: [
        "There is no endpoint that takes a recipient and a body and delivers them.",
        "Sending is four requests: create a draft, read it back, confirm the hash, then",
        "send while repeating the recipient exactly. Three of the four are enforced. The",
        "read is not, because create already returns the hash.",
        "",
        `Human documentation: ${origin}/documentation`,
        `Markdown for agents: ${origin}/documentation/llms-full.txt`,
      ].join("\n"),
    },
    // One server only. `POST /drafts` and `POST /drafts/{id}/send` are also
    // mounted at the bare origin, but a second entry here would tell a generator
    // that *every* path is served there, which is false: the alias covers two
    // POSTs. The two operations that have it say so in their own description.
    servers: [
      { url: API_BASE, description: "Versioned surface. Every route lives here." },
    ],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "A `uik_…` key from Settings → API keys in the web app. Shown once; only its SHA-256 digest is stored.",
        },
      },
      schemas,
    },
    paths,
  };
}
