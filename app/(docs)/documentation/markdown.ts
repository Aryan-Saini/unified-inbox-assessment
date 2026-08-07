/**
 * The markdown rendering of the documentation — the copy an agent actually reads.
 *
 * Same `spec.ts` and `guide.ts` the HTML page renders, emitted as text. That is
 * the whole point: an agent gets the *documentation*, not a scraped
 * approximation of it, and the two cannot disagree because neither is a
 * transcription of the other.
 *
 * Three renderings come out of here, aimed at three different moments:
 *
 *   - `renderIndex`    — `llms.txt`. Small. What this is, where the rest lives,
 *                        and the send protocol, because an agent that reads only
 *                        this file must still be unable to send by accident.
 *   - `renderFull`     — `llms-full.txt`. Everything, one fetch, no navigation.
 *   - `renderAgentsMd` — a file to commit into a repository, written as
 *                        instructions to the agent working there rather than as
 *                        reference prose.
 */

import { AGENT_BRIEF, guide, type Block } from "./guide";
import {
  API_BASE,
  API_PREFIX,
  BASE_URL,
  ENDPOINTS,
  ERROR_CODES,
  RATE_LIMITS,
  SCHEMAS,
  SECTIONS,
  SEND_STATUSES,
  type Endpoint,
  type Field,
} from "./spec";

/* ------------------------------------------------------------------ helpers */

/** A markdown table. Cells are passed through — they already carry inline markup. */
function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const escape = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

function fence(lang: string, code: string): string {
  return ["```" + lang, code, "```"].join("\n");
}

function fieldRows(fields: Field[]): string[][] {
  return fields.map((f) => [
    `\`${f.name}\``,
    `\`${f.type}\``,
    f.required === true ? "yes" : "no",
    f.description,
  ]);
}

function block(b: Block): string {
  switch (b.kind) {
    case "p":
      return b.text;
    case "code":
      return [b.caption === undefined ? null : `_${b.caption}_`, fence(b.lang, b.code)]
        .filter((part) => part !== null)
        .join("\n\n");
    case "list":
      return b.items
        .map((item, i) => `${b.ordered === true ? `${i + 1}.` : "-"} ${item}`)
        .join("\n");
    case "note":
      // Blockquote rather than an admonition syntax: every markdown reader
      // renders it, and an agent reading raw text still sees the emphasis.
      return `> **${b.tone === "warn" ? "⚠ " : ""}${b.title}**\n>\n> ${b.text.replace(/\n/g, "\n> ")}`;
    case "table":
      return table(b.head, b.rows);
  }
}

/* ---------------------------------------------------------------- endpoints */

function endpoint(e: Endpoint): string {
  const parts: string[] = [`### \`${e.method} ${API_PREFIX}${e.path}\``, "", `**${e.summary}**`, ""];

  if (e.alias !== undefined) {
    parts.push(
      `Also reachable at the bare path \`${e.method} ${e.alias}\`, which hits the same handler.`,
      "",
    );
  }

  parts.push(e.description, "");

  if (e.pathParams !== undefined) {
    parts.push("**Path parameters**", "", table(["Name", "Type", "Required", "Description"], fieldRows(e.pathParams)), "");
  }
  if (e.query !== undefined) {
    parts.push("**Query parameters**", "", table(["Name", "Type", "Required", "Description"], fieldRows(e.query)), "");
  }
  if (e.body !== undefined) {
    parts.push("**Request body** (JSON)", "", table(["Field", "Type", "Required", "Description"], fieldRows(e.body)), "");
  }

  parts.push(
    "**Responses**",
    "",
    table(["Status", "Meaning"], e.responses.map((r) => [`\`${r.status}\``, r.description])),
    "",
  );

  if (e.responseHeaders !== undefined) {
    parts.push(
      "**Response headers**",
      "",
      table(["Header", "Meaning"], e.responseHeaders.map((h) => [`\`${h.name}\``, h.description])),
      "",
    );
  }

  parts.push(fence("bash", e.curl), "", fence("json", e.example), "");
  return parts.join("\n");
}

function schemaSection(name: string): string {
  const schema = SCHEMAS[name];
  return [
    `### \`${schema.title}\``,
    "",
    ...(schema.note === undefined ? [] : [schema.note, ""]),
    table(["Field", "Type", "Always present", "Description"], fieldRows(schema.fields)),
    "",
  ].join("\n");
}

/* ------------------------------------------------------- shared sub-documents */

/** The protocol, spelled out. Appears in all three renderings, verbatim. */
function sendProtocol(): string {
  return [
    "## Sending: four requests, three of them enforced",
    "",
    "There is **no endpoint that takes a recipient and a body and just sends it**.",
    "",
    "The API enforces steps 1, 3 and 4. Step 2 is not enforced, because step 1",
    "already returns a usable `review_hash`, so a client can technically go",
    "create, confirm, send. Do the read anyway: it is the only way to hold a hash",
    "you know matches the draft right now.",
    "",
    "1. `POST /api/v1/drafts` to create the draft. Pass your own `idempotency_key`.",
    "2. `GET /api/v1/drafts/{id}` to read it back. You get `review_hash` and the exact `to`. The create response carries the hash too, so this step matters most after an edit, when the hash you hold has gone stale.",
    "3. `POST /api/v1/drafts/{id}/confirm` with `{\"reviewed_hash\": \"<review_hash>\"}`. The server re-derives the digest and compares, so a draft edited in between fails instead of going through on a stale review.",
    "4. `POST /api/v1/drafts/{id}/send` with `{\"acknowledged_destination\": \"<the draft's `to`, exactly>\"}`.",
    "",
    "Copy `acknowledged_destination` out of the draft you read in step 2. Do not",
    "build it out of your own state. The check is worth nothing if the value",
    "comes from the same place the recipient came from.",
    "",
    "Once a send has settled, two `/send` calls on one draft return **byte-identical**",
    "**bodies**. The dedupe goes in the `X-Idempotent-Replay` header, not the body.",
    "`/send` waits up to five",
    "seconds for a terminal outcome, then answers **202** with `Retry-After` and a",
    "`send_url` to poll.",
    "",
    "**Never retry a send whose `status` is `unknown`.** That status means the outcome",
    "genuinely is not known and a retry could double-send, so",
    "`POST /sends/{id}/retry` refuses it with 409 `INDETERMINATE`. Escalate to a",
    "human, reconcile at the provider, or clone the draft under a new idempotency key.",
  ].join("\n");
}

function routeTable(): string {
  return table(
    ["Method", "Path", "Purpose"],
    ENDPOINTS.map((e) => [
      `\`${e.method}\``,
      `\`${API_PREFIX}${e.path}\``,
      e.summary,
    ]),
  );
}

function errorTable(): string {
  return table(
    ["Code", "Status", "Means", "Do"],
    ERROR_CODES.map((e) => [`\`${e.code}\``, String(e.status), e.meaning, e.action]),
  );
}

/* ------------------------------------------------------------------ llms.txt */

/**
 * The index, in the [llms.txt](https://llmstxt.org) shape: an H1, a blockquote
 * summary, then linked sections. Deliberately short — but it still carries the
 * send protocol in full, because the failure this documentation exists to
 * prevent is an agent sending something it should not, and an index that only
 * pointed at the rule would be an index that let it be skipped.
 */
export function renderIndex(origin: string): string {
  return [
    "# Unified Inbox API",
    "",
    "> Search Gmail, Slack and the web from one place, and only send a reply after you",
    "> have explicitly confirmed it. REST, one bearer token, JSON in and out.",
    "",
    AGENT_BRIEF,
    "",
    "## Files",
    "",
    `- [Full documentation](${origin}/documentation/llms-full.txt): every endpoint, field, error code and example, as markdown. One fetch.`,
    `- [OpenAPI 3.1](${origin}/documentation/openapi.json): machine-readable schema for client generation.`,
    `- [AGENTS.md](${origin}/documentation/AGENTS.md): drop-in instructions to commit into a repository.`,
    `- [Human documentation](${origin}/documentation): the same content as a web page.`,
    "",
    "## Authentication",
    "",
    "Make a key in the web app under **Settings → API keys**. You see it once and we",
    "only store the SHA-256 of it, so there is no endpoint that reads it back.",
    "",
    fence("http", "Authorization: Bearer uik_…"),
    "",
    "## Routes",
    "",
    routeTable(),
    "",
    sendProtocol(),
    "",
    "## Errors",
    "",
    "Every failure has one shape: `{\"error\": {\"code\", \"message\"}}`. Switch on `code`",
    "and show `message`. Asking for another user's row is **404, not 403**, because a",
    "403 would confirm the row is there.",
    "",
    errorTable(),
    "",
    "## Rate limits",
    "",
    table(["Bucket", "Limit", "Covers"], RATE_LIMITS.map((r) => [r.name, r.limit, r.covers])),
    "",
    "Obey `Retry-After` on a 429. It comes out of the bucket's own arithmetic, so a",
    "retry after that many seconds actually works.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------- llms-full.txt */

/** Everything, in one document. */
export function renderFull(origin: string): string {
  const parts: string[] = [
    "# Unified Inbox API, full documentation",
    "",
    "> Search Gmail, Slack and the web from one place, and only send a reply after you",
    "> have explicitly confirmed it.",
    "",
    AGENT_BRIEF,
    "",
    `Generated from the same source that renders ${origin}/documentation, so this`,
    "document and that page cannot disagree.",
    "",
    "---",
    "",
  ];

  for (const section of guide(origin)) {
    parts.push(`## ${section.title}`, "");
    for (const b of section.blocks) parts.push(block(b), "");
  }

  parts.push("---", "", "## Route summary", "", routeTable(), "");

  for (const section of SECTIONS) {
    parts.push(`## ${section.title}`, "");
    for (const e of section.endpoints) parts.push(endpoint(e));
  }

  parts.push("---", "", "## Object shapes", "");
  for (const name of Object.keys(SCHEMAS)) parts.push(schemaSection(name));

  parts.push(
    "---",
    "",
    "## Send statuses",
    "",
    table(
      ["Status", "Means", "What to do"],
      SEND_STATUSES.map((s) => [`\`${s.status}\``, s.meaning, s.retryable]),
    ),
    "",
    "## Error codes",
    "",
    errorTable(),
    "",
    "## Rate limits",
    "",
    table(["Bucket", "Limit", "Covers"], RATE_LIMITS.map((r) => [r.name, r.limit, r.covers])),
    "",
  );

  return parts.join("\n");
}

/* ---------------------------------------------------------------- AGENTS.md */

/**
 * Instructions to commit into a repository.
 *
 * Written in the imperative, at an agent, rather than as reference prose — the
 * file is read as *rules for this codebase*, so "never retry an `unknown` send"
 * has to read as an instruction and not as an interesting fact about the API.
 */
export function renderAgentsMd(origin: string): string {
  return [
    "# Unified Inbox API",
    "",
    "How to work with the Unified Inbox REST API from this repo.",
    "",
    AGENT_BRIEF,
    "",
    "## Setup",
    "",
    "The key comes from the web app, under **Settings → API keys**. You see it once.",
    "Keep it in the environment and never in a committed file.",
    "",
    fence(
      "bash",
      `export API=${API_BASE}
export KEY="$UNIFIED_INBOX_API_KEY"

curl -sS -H "Authorization: Bearer $KEY" "$API/connections"`,
    ),
    "",
    "## Routes",
    "",
    routeTable(),
    "",
    sendProtocol(),
    "",
    "## A complete send, start to finish",
    "",
    fence(
      "bash",
      `set -euo pipefail
API=${API_BASE}
KEY="$UNIFIED_INBOX_API_KEY"
AUTH=(-H "Authorization: Bearer $KEY" -H 'content-type: application/json')
field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

# 1. Pick an active connection.
CONNECTION_ID=$(curl -sS "\${AUTH[@]}" "$API/connections" | python3 -c '
import json, sys
for c in json.load(sys.stdin)["connections"]:
    if c["status"] == "active" and c["provider"] == "gmail":
        print(c["id"]); break
')

# 2. Create the draft. The idempotency key names this message, not this request.
DRAFT_ID=$(curl -sS "\${AUTH[@]}" -d "{
  \\"channel\\": \\"gmail\\",
  \\"connection_id\\": \\"$CONNECTION_ID\\",
  \\"to\\": \\"someone@example.com\\",
  \\"subject\\": \\"Re: invoice INV-2041\\",
  \\"body\\": \\"Attaching the corrected copy.\\",
  \\"idempotency_key\\": \\"agent-run-001\\"
}" "$API/drafts" | field id)

# 3. Read it back. This is where review_hash and the exact recipient come from.
DRAFT=$(curl -sS "\${AUTH[@]}" "$API/drafts/$DRAFT_ID")
HASH=$(printf '%s' "$DRAFT" | field review_hash)
TO=$(printf '%s' "$DRAFT" | field to)

# 4. Confirm the payload you actually read.
curl -sS "\${AUTH[@]}" -d "{\\"reviewed_hash\\": \\"$HASH\\"}" "$API/drafts/$DRAFT_ID/confirm" > /dev/null

# 5. Send, naming the destination in your own request.
curl -sS -D headers.txt "\${AUTH[@]}" \\
  -d "{\\"acknowledged_destination\\": \\"$TO\\"}" \\
  "$API/drafts/$DRAFT_ID/send"`,
    ),
    "",
    "## Rules",
    "",
    "- **Never invent `acknowledged_destination`.** Read the draft and copy `to` exactly.",
    "- **Never retry a send whose status is `unknown`.** Stop and ask a human.",
    "- **One idempotency key per message.** Reusing a key with a different payload gives you a 409, not an overwrite.",
    "- **A 202 from `/send` means it is still going.** Poll `send_url` and do not re-issue the send.",
    "- **Obey `Retry-After` on a 429.** That value is real, not a round number.",
    "- **404 means \"no such row, or not yours\".** Do not retry it, and do not go looking for the difference because there is not one.",
    "- **You cannot make connections over REST.** OAuth needs a browser. If none are `active`, stop and say so.",
    "",
    "## Errors",
    "",
    "Every failure is `{\"error\": {\"code\", \"message\"}}`. Branch on `code`.",
    "",
    errorTable(),
    "",
    "## Send statuses",
    "",
    table(
      ["Status", "Means", "What to do"],
      SEND_STATUSES.map((s) => [`\`${s.status}\``, s.meaning, s.retryable]),
    ),
    "",
    "## More",
    "",
    `- Full reference, every field and example: ${origin}/documentation/llms-full.txt`,
    `- OpenAPI 3.1: ${origin}/documentation/openapi.json`,
    `- The API itself: ${BASE_URL}`,
    "",
  ].join("\n");
}
