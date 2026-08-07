/**
 * The prose half of the documentation.
 *
 * `spec.ts` is the reference: every route, field and status code. This is
 * everything a reader needs *around* it. How to get a key, what the send gate
 * actually enforces, and what an autonomous client is expected to do when a send
 * comes back `unknown`.
 *
 * It is a small block tree rather than a markdown string because it has two
 * renderers, React for the page and markdown for the `curl`-able copies, and a
 * markdown string would have made the HTML renderer parse markdown, which is a
 * dependency and a class of bug this does not need. Inline markup is limited to
 * three forms (`` `code` ``, `**bold**`, `[text](url)`), which `inline.tsx`
 * renders and the markdown emitter passes through untouched.
 */

import { API_BASE, BASE_URL } from "./spec";

export type Block =
  /**
   * A subheading inside a section. Carries its own `id` because it is both an
   * anchor and a row in the page's "On this page" rail — derived slugs would
   * change silently the moment someone reworded a heading, and every link into
   * it would break without anything failing.
   */
  | { kind: "h"; id: string; text: string }
  | { kind: "p"; text: string }
  | { kind: "code"; lang: string; code: string; caption?: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "note"; tone: "info" | "warn"; title: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] };

export interface Guide {
  id: string;
  title: string;
  blocks: Block[];
}

/* -------------------------------------------------------------- agent header */

/**
 * The first thing an agent should read, and the thing the page leads with.
 *
 * Kept as its own export because it is prepended to every machine-readable
 * rendering: an agent that fetches only `llms.txt` still gets the send protocol
 * and the one rule about `unknown`.
 */
export const AGENT_BRIEF = `You are talking to Unified Inbox. It is a REST API that searches Gmail, Slack and
the web from one place, and it only sends a reply after you have explicitly
confirmed it.

Base URL: ${BASE_URL}
Every route lives under ${API_BASE}. Authenticate with \`Authorization: Bearer uik_…\`.

THE ONE RULE THAT MATTERS: there is no endpoint that takes a recipient and a body
and just sends it. The normal flow is four requests. Create a draft, read it back,
confirm the hash, then send while repeating the recipient exactly.

Three of those four are enforced. The API will not send without a confirm whose
hash matches the draft as it stands right now, and it will not send unless you
name the recipient yourself. The read is not enforced, because create already
hands you a usable hash. Do it anyway: it is the only way to hold a hash you know
is current, and after any edit the one you are holding is stale.`;

/* ------------------------------------------------------------------- sections */

/**
 * The guide, parameterised by the origin serving it.
 *
 * A function rather than a constant because half the value of the agent section
 * is that its URLs are copy-pasteable, and the app origin is not knowable at
 * build time. It differs between `localhost:3000`, a Codespace and the deployed
 * deployed. Callers read it off the incoming request (`docsOrigin` in
 * `origin.ts`) and every URL below comes out absolute and correct.
 */
export function guide(origin: string): Guide[] {
  return [
    {
      id: "quickstart",
      title: "Quickstart",
      blocks: [
        { kind: "h", id: "get-a-key", text: "Get a key" },
        {
          kind: "p",
          text: "Make a key in the app under **Settings → API keys**. You see the whole thing once. What we keep is its SHA-256 plus the first 12 characters, which is enough to tell two keys apart in a list and useless as a credential, so there is no way to read the key back later. Lose it and you revoke it and make another one.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Set these once. Every example below uses them.",
          code: `export API=${API_BASE}
export KEY=uik_your_key_here

# Prove the key works and find an account to send through.
curl -sS -H "Authorization: Bearer $KEY" "$API/connections"`,
        },
        { kind: "h", id: "run-a-search", text: "Run a search" },
        {
          kind: "p",
          text: "Nothing listed? Connect Gmail or Slack in the web app, or load **Settings → Demo data**. Seeded connections are enough to walk the whole draft, confirm, send path, and a send through one fails `permanent` with an explicit \"holds no real grant\", which is worth seeing on its own because it proves demo data can never reach a provider.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Search, then read the results once they land.",
          code: `SEARCH=$(curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"query":"invoice"}' "$API/searches")
SEARCH_ID=$(printf '%s' "$SEARCH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["search_id"])')

# 202 means scheduled, not finished. Poll until status is complete.
curl -sS -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID"
curl -sS -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID/results?order=rank"`,
        },
      ],
    },

    {
      id: "authentication",
      title: "Authentication",
      blocks: [
        { kind: "h", id: "the-header", text: "The header" },
        {
          kind: "p",
          text: "One credential, one header. Keys start with `uik_` so you can spot one in a log or a shell history, and we check that prefix before hashing anything, which is how pasting a Clerk token by mistake gets you a useful 401 instead of a silent failure.",
        },
        {
          kind: "code",
          lang: "http",
          code: `Authorization: Bearer uik_…`,
        },
        { kind: "h", id: "how-keys-are-handled", text: "How keys are handled" },
        {
          kind: "list",
          items: [
            "**We never store the whole key.** Only its SHA-256 and a 12-character display prefix. The rest exists for exactly one response and then it is gone, and there is no *show key* endpoint, because a database dump should not be a set of working credentials.",
            "**Key management is Clerk-only.** No REST route mints, lists or revokes keys, so a leaked key cannot mint a fresh one and cannot outlive being revoked. Worth knowing though: the rate limits are per user, not per key, so a leaked key spends the same buckets your other keys draw on.",
            "**Revoked and unknown answer the same.** Both get a bare 401. Telling them apart would confirm to whoever stole it that the key was real before you turned it off.",
            "**A key dies with its owner.** Deleting the account revokes every key, and a key whose user row is gone resolves to nobody instead of authenticating against orphaned grants.",
          ],
        },
        {
          kind: "note",
          tone: "info",
          title: "CORS is wide open on purpose",
          text: "`Access-Control-Allow-Origin: *`. The credential is a bearer token in a header and never a cookie, so a browser on another origin cannot make an authenticated request by accident. It has to be handed a key. The wildcard grants nothing except the ability to try, and it means you can poke the API from a scratch page.",
        },
      ],
    },

    {
      id: "send-protocol",
      title: "The send protocol",
      blocks: [
        { kind: "h", id: "four-requests", text: "Four requests" },
        {
          kind: "p",
          text: "This is the part worth reading twice, and the part an automated client is most likely to get wrong. **Four requests, and the API enforces three of them.** Create, confirm and send are checked. The read is not, because create already returns a usable hash, so a client can technically go create, confirm, send. Do the read anyway, for the reason in step 2.",
        },
        {
          kind: "list",
          ordered: true,
          items: [
            "`POST /drafts` and the message exists, unsent. Pass your own `idempotency_key` so a retried request reads as the same message instead of a second one.",
            "`GET /drafts/{id}` to read it back. You get `review_hash` and the exact `to` here. This is the step the API does not force, since create returns the hash as well, but it is the only way to be sure the hash matches the draft as it stands. Edit anything and the revision moves and the hash you were holding is dead.",
            "`POST /drafts/{id}/confirm` with the hash. The server re-derives the digest from the current row and compares, so a draft that got edited in between fails instead of going out on a stale review.",
            "`POST /drafts/{id}/send`, repeating the recipient exactly in `acknowledged_destination`. A mismatch is a 409 and nothing is delivered.",
          ],
        },
        {
          kind: "note",
          tone: "warn",
          title: "Do not build `acknowledged_destination` from your own state",
          text: "Copy it out of the draft you just read. The check is worth nothing if the value comes from the same place the recipient came from, because the whole point is forcing a round trip through the stored payload so an agent working off a stale plan names the wrong address and gets stopped.",
        },
        { kind: "h", id: "verify-the-hash", text: "Verify the hash yourself" },
        {
          kind: "p",
          text: "You get `canonical_payload` back next to the hash so you can verify the digest yourself instead of trusting ours. The layout is `v1|<revision>|<channel>|<connection_id>|<to>|<subject>|<body>` and every field is written as `<byteLength>:<value>`. Length-prefixed, not just joined, because a plain separator collides. `to = \"a|b\", subject = \"c\"` and `to = \"a\", subject = \"b|c\"` would produce the same string, and a collision here is a confirmed-payload bypass. An absent field is `-`, which no real value can look like. Newlines get normalised to `\\n`.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Verify the hash yourself before you confirm.",
          code: `DRAFT=$(curl -sS -H "Authorization: Bearer $KEY" "$API/drafts/$DRAFT_ID")

printf '%s' "$DRAFT" | python3 -c '
import hashlib, json, sys
d = json.load(sys.stdin)
mine = hashlib.sha256(d["canonical_payload"].encode()).hexdigest()
print("match" if mine == d["review_hash"] else "MISMATCH, do not confirm")
'`,
        },
        { kind: "h", id: "why-revision-is-in-the-digest", text: "Why the revision is in the digest" },
        {
          kind: "p",
          text: "`revision` is folded into the digest, and that is what closes the confirm-then-mutate hole. Without it you could edit a draft A to B and back to A, and the stale confirmation of A would be valid again. Every edit bumps the revision, so every confirmation is tied to one specific version.",
        },
      ],
    },

    {
      id: "idempotency",
      title: "Idempotency and the double tap",
      blocks: [
        { kind: "h", id: "two-sends-one-delivery", text: "Two sends, one delivery" },
        {
          kind: "p",
          text: "Once a send has settled, two calls to `/send` on the same draft give you **byte-identical bodies**. Nothing in the response says which call produced it. The fact that the second one claimed nothing goes in the `X-Idempotent-Replay` header instead, so proving a double tap only sent once is a `diff` on two files rather than a careful read of two JSON blobs.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "The proof, in four lines.",
          code: `curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"acknowledged_destination":"someone@example.com"}' "$API/drafts/$DRAFT_ID/send" > first.json
curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"acknowledged_destination":"someone@example.com"}' "$API/drafts/$DRAFT_ID/send" > second.json

diff first.json second.json && echo "identical, one delivery"`,
        },
        { kind: "h", id: "a-key-names-one-message", text: "A key names one message" },
        {
          kind: "p",
          text: "An idempotency key names **one message**, not one request. Send a different payload under a key you already used and you get a 409 `IDEMPOTENCY_KEY_REUSED` instead of a silent overwrite, so a client that reuses keys carelessly gets told about it rather than quietly sending something other than what it thinks it sent.",
        },
        {
          kind: "note",
          tone: "info",
          title: "`/send` waits, but only five seconds",
          text: "It polls for a terminal outcome so your terminal usually shows what actually happened instead of a job id. Past that budget it answers **202** with `Retry-After: 2` and a `send_url`, because holding the connection open any longer would be pretending the send is synchronous when it is not. On a 202 you poll `send_url`. The delivery is still going and it is not yours to re-issue.",
        },
      ],
    },

    {
      id: "failures",
      title: "Failures, retries, and the one you must not retry",
      blocks: [
        { kind: "h", id: "the-attempt-timeline", text: "The attempt timeline" },
        {
          kind: "p",
          text: "A send that fails is not a send that vanished. `GET /sends/{id}` gives you the full attempt timeline. What was tried, when, what the provider said back, and how we classified the error. So a failure is something you can explain rather than just report. Errors get classified *before* anything decides whether to retry them.",
        },
        {
          kind: "note",
          tone: "warn",
          title: "`unknown` is a refusal to guess, not a failure",
          text: "It means the attempt came back with no verdict, so the message may or may not have gone out. Retrying under the same key could double-send, so `POST /sends/{id}/retry` answers **409 `INDETERMINATE`** and stays refused. An autonomous client has to escalate here. Reconcile at the provider, or clone the draft under a *new* idempotency key. Never loop on it.",
        },
        { kind: "h", id: "when-to-retry", text: "When to retry" },
        {
          kind: "p",
          text: "A `failed_transient` with `next_retry_at` set is still going. The scheduler will try again on its own and a manual retry on top of that is wasted work, so only retry when that field is missing.",
        },
      ],
    },

    {
      id: "agents",
      title: "Using this from an agent",
      blocks: [
        { kind: "h", id: "machine-readable-copies", text: "Machine-readable copies" },
        {
          kind: "p",
          text: "Everything in these docs is also plain text at a stable URL, so a coding agent can read the API with no browser and no HTML parsing. Point Claude Code, Codex, Cursor, or anything else that can run `curl`, at one of these.",
        },
        {
          kind: "table",
          head: ["URL", "What it is"],
          rows: [
            [`\`${origin}/documentation/llms.txt\``, "The [llms.txt](https://llmstxt.org) index. What this API is, where the other files live, and the send protocol in full. Start here."],
            [`\`${origin}/documentation/llms-full.txt\``, "This whole page as markdown. Every endpoint, field, error code and example, in one fetch."],
            [`\`${origin}/documentation/openapi.json\``, "OpenAPI 3.1. Feed it to a client generator or anything that already speaks OpenAPI."],
            [`\`${origin}/documentation/AGENTS.md\``, "A drop-in instruction file. Save it into a repo as `AGENTS.md` or `CLAUDE.md` and the agent working there knows the protocol without being told."],
            [`\`${origin}/llms.txt\``, "Site root, for crawlers and agents that look there by convention. Points at everything above."],
          ],
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Hand an agent the whole API in one command.",
          code: `# Claude Code, Codex, or any shell-capable agent:
curl -sS ${origin}/documentation/llms-full.txt

# Or drop the instructions into the repo it is working in, so every
# session there starts already knowing the protocol:
curl -sS -o AGENTS.md ${origin}/documentation/AGENTS.md`,
        },
        {
          kind: "note",
          tone: "info",
          title: "Two different origins",
          text: "The docs are served by the Next.js app and the API itself is served by the Convex deployment at `" + BASE_URL + "`. So the `.txt` and `.json` files live on the app origin and every `/api/v1` route lives on the Convex one. Both are public and the docs need no credential at all.",
        },
        { kind: "h", id: "the-walkthrough-script", text: "The walkthrough script" },
        {
          kind: "p",
          text: "There is also a full end-to-end script in the repo at `docs/api-walkthrough.sh`. It runs search, poll, results, rerun, draft, confirm, send, double-send, retry, outbox, and asserts the two send responses are byte-identical. All it needs is `curl` and `python3`.",
        },
        {
          kind: "code",
          lang: "bash",
          code: `BASE_URL=${BASE_URL} API_KEY=uik_… ./docs/api-walkthrough.sh`,
        },
      ],
    },

    {
      id: "conventions",
      title: "Conventions",
      blocks: [
        { kind: "h", id: "shapes-and-rules", text: "Shapes and rules" },
        {
          kind: "list",
          items: [
            "**Field names are `snake_case`** in requests and responses, matching the spec. We also accept `camelCase` on request bodies, which is being liberal in what we take without being vague about what we mean.",
            "**Timestamps are ISO 8601 strings**, always UTC, always the same shape.",
            "**Ids are opaque strings.** Do not parse them. An id minted for one table gets rejected on a route for another, so `/sends/{a-draft-id}` is a clean 404 instead of a confusing internal error.",
            "**404, never 403.** Asking for another user's row looks exactly like asking for a row that does not exist. A 403 would confirm the row is there, which is a slow way to enumerate.",
            "**`OPTIONS` works** on every route and gives you a 204 with the CORS headers.",
            "**`HEAD` is treated as `GET`.**",
            "**Lists are capped.** Searches, sends and per-search source runs at 50, connections at 100, results at 200, attempt timelines at 32. There is no pagination cursor. This is an assessment surface, not a warehouse.",
          ],
        },
        { kind: "h", id: "versioning-and-aliases", text: "Versioning and aliases" },
        {
          kind: "p",
          text: "Every route lives under `/api/v1`. The draft POSTs are **also** reachable at the bare paths the spec writes literally, so `POST /drafts`, `POST /drafts/{id}/confirm` and `POST /drafts/{id}/send` all work without the prefix. Both mount points hit one routing table and one handler, so the alias cannot drift from the versioned route because there is only one implementation of it.",
        },
      ],
    },
  ];
}
