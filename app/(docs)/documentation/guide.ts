/**
 * The prose half of the documentation.
 *
 * `spec.ts` is the reference — every route, field and status code. This is
 * everything a reader needs *around* it: how to get a key, why sending takes
 * three round trips, and what an autonomous client is expected to do when a send
 * comes back `unknown`.
 *
 * It is a small block tree rather than a markdown string because it has two
 * renderers — React for the page, markdown for the `curl`-able copies — and a
 * markdown string would have made the HTML renderer parse markdown, which is a
 * dependency and a class of bug this does not need. Inline markup is limited to
 * three forms (`` `code` ``, `**bold**`, `[text](url)`), which `inline.tsx`
 * renders and the markdown emitter passes through untouched.
 */

import { API_BASE, BASE_URL } from "./spec";

export type Block =
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
export const AGENT_BRIEF = `You are talking to Unified Inbox, a REST API that searches Gmail, Slack and the web
from one place and sends replies only after an explicit confirmation step.

Base URL: ${BASE_URL}
All routes are under ${API_BASE}. Authenticate with \`Authorization: Bearer uik_…\`.

THE ONE RULE THAT MATTERS: there is no endpoint that takes a recipient and a body
and delivers them. Sending is always four requests — create a draft, read it back,
confirm the hash you read, then send while repeating the recipient verbatim. Each
step exists to make an accidental send impossible, including an accidental send by
you. Do not try to route around it; there is no route around it.`;

/* ------------------------------------------------------------------- sections */

/**
 * The guide, parameterised by the origin serving it.
 *
 * A function rather than a constant because half the value of the agent section
 * is that its URLs are copy-pasteable, and the app origin is not knowable at
 * build time — it differs between `localhost:3000`, a Codespace and the deployed
 * hand-in. Callers read it off the incoming request (`docsOrigin` in
 * `origin.ts`) and every URL below comes out absolute and correct.
 */
export function guide(origin: string): Guide[] {
  return [
    {
      id: "quickstart",
      title: "Quickstart",
      blocks: [
        {
          kind: "p",
          text: "Create a key in the app under **Settings → API keys**. It is shown once and stored only as a SHA-256 digest, so there is no way to read it back — if you lose it, revoke it and make another.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Set these once; every example below uses them.",
          code: `export API=${API_BASE}
export KEY=uik_your_key_here

# Prove the key works and find an account to send through.
curl -sS -H "Authorization: Bearer $KEY" "$API/connections"`,
        },
        {
          kind: "p",
          text: "No connections listed? Connect Gmail or Slack in the web app, or load **Settings → Demo data** — seeded connections are enough to exercise the whole draft-confirm-send path, and a send through one fails `permanent` with an explicit \"holds no real grant\", which is itself worth seeing.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Search, and read the results once they land.",
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
        {
          kind: "p",
          text: "One credential, one header. Keys are prefixed `uik_` so they are recognisable in a log or a shell history, and the prefix is checked before the digest is taken — which is how pasting a Clerk token by mistake gets a useful 401 instead of a silent failure.",
        },
        {
          kind: "code",
          lang: "http",
          code: `Authorization: Bearer uik_…`,
        },
        {
          kind: "list",
          items: [
            "**Only the digest is stored.** The plaintext exists for exactly one response and is then unrecoverable. There is no *show key* endpoint, because a database dump must not be a set of working credentials.",
            "**Key management is Clerk-authenticated only.** No REST route mints, lists or revokes keys. A leaked key can spend its own rate limit; it cannot mint a fresh key, so it cannot outlive the revocation of itself.",
            "**Revoked and unknown answer identically.** Both are a bare 401. Telling them apart would confirm to a thief that the key they hold was real before it was turned off.",
            "**A key dies with its owner.** Deleting the account revokes every key, and a key whose user row is gone resolves to nobody rather than authenticating against orphaned grants.",
          ],
        },
        {
          kind: "note",
          tone: "info",
          title: "CORS is permissive on purpose",
          text: "`Access-Control-Allow-Origin: *`. The credential is a bearer token in a header and never a cookie, so a browser on another origin cannot make an authenticated request by accident — it has to be handed a key. The wildcard grants nothing except the ability to try, and it means a reviewer can poke the API from a scratch page.",
        },
      ],
    },

    {
      id: "send-protocol",
      title: "The send protocol",
      blocks: [
        {
          kind: "p",
          text: "This is the part worth reading twice, and the part an automated client is most likely to get wrong. **Four requests, in order.** Each one is a gate, and none of them can be skipped or precomputed.",
        },
        {
          kind: "list",
          ordered: true,
          items: [
            "`POST /drafts` — the message comes into existence, unsent. Supply your own `idempotency_key` so a retried request is recognisable as the same message rather than a second one.",
            "`GET /drafts/{id}` — read it back. This is the only place `review_hash` is returned, so holding the hash *proves the payload was fetched*. That is the entire mechanism.",
            "`POST /drafts/{id}/confirm` — send the hash back. The server re-derives the digest from the current row and compares, so a draft edited in between fails rather than being authorised on a stale review.",
            "`POST /drafts/{id}/send` — repeat the recipient verbatim in `acknowledged_destination`. A mismatch is a 409 and nothing is delivered.",
          ],
        },
        {
          kind: "note",
          tone: "warn",
          title: "Do not construct `acknowledged_destination` from your own state",
          text: "Copy it out of the draft you just read. The check is worth nothing if the value comes from the same place the recipient came from — the point is to force a round trip through the stored payload, so that an agent working from a stale plan names the wrong address and is stopped.",
        },
        {
          kind: "p",
          text: "`canonical_payload` is returned alongside the hash so a client can verify the digest itself rather than trusting ours. The layout is `v1|<revision>|<channel>|<connection_id>|<to>|<subject>|<body>`, every field written as `<byteLength>:<value>` — length-prefixed rather than merely joined, because a plain separator collides (`to = \"a|b\", subject = \"c\"` and `to = \"a\", subject = \"b|c\"` would produce the same string) and a collision here is a confirmed-payload bypass. An absent field is `-`, which no real value can be mistaken for. Newlines are normalised to `\\n`.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Verify the hash yourself before confirming.",
          code: `DRAFT=$(curl -sS -H "Authorization: Bearer $KEY" "$API/drafts/$DRAFT_ID")

printf '%s' "$DRAFT" | python3 -c '
import hashlib, json, sys
d = json.load(sys.stdin)
mine = hashlib.sha256(d["canonical_payload"].encode()).hexdigest()
print("match" if mine == d["review_hash"] else "MISMATCH — do not confirm")
'`,
        },
        {
          kind: "p",
          text: "`revision` is folded into the digest, which is what closes the confirm-then-mutate hole: editing a draft A → B → A would otherwise make a stale confirmation of *A* valid again. Every edit bumps the revision, so every confirmation is bound to one specific version.",
        },
      ],
    },

    {
      id: "idempotency",
      title: "Idempotency and the double tap",
      blocks: [
        {
          kind: "p",
          text: "Two calls to `/send` on the same draft return **byte-identical bodies**. Nothing in the response says which call produced it — that the second one claimed nothing is reported in the `X-Idempotent-Replay` header instead, so proving a double tap sent once is a `diff` of two files rather than a careful reading of two JSON blobs.",
        },
        {
          kind: "code",
          lang: "bash",
          caption: "The proof, in four lines.",
          code: `curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"acknowledged_destination":"someone@example.com"}' "$API/drafts/$DRAFT_ID/send" > first.json
curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"acknowledged_destination":"someone@example.com"}' "$API/drafts/$DRAFT_ID/send" > second.json

diff first.json second.json && echo "identical — one delivery"`,
        },
        {
          kind: "p",
          text: "An idempotency key names **one message**, not one request. Presenting a different payload under a key you have already used is a 409 `IDEMPOTENCY_KEY_REUSED`, not a silent overwrite — so a client that reuses keys carelessly is told, rather than quietly sending something other than what it thinks it sent.",
        },
        {
          kind: "note",
          tone: "info",
          title: "`/send` waits, but only for five seconds",
          text: "It polls for a terminal outcome so a terminal usually shows what actually happened instead of a job id. Past that budget it answers **202** with `Retry-After: 2` and a `send_url` — because holding the connection open longer would be pretending the send is synchronous when it is not. On a 202, poll `send_url`; the delivery is still in progress and is not yours to re-issue.",
        },
      ],
    },

    {
      id: "failures",
      title: "Failures, retries, and the one you must not retry",
      blocks: [
        {
          kind: "p",
          text: "A send that fails is not a send that vanished. `GET /sends/{id}` returns the full attempt timeline — what was tried, when, what the provider answered, and how the error was classified — so a failure is explainable rather than merely reported. Errors are classified *before* anything decides whether to retry them.",
        },
        {
          kind: "note",
          tone: "warn",
          title: "`unknown` is a refusal to guess, not a failure",
          text: "It means the attempt returned no verdict: the message may or may not have gone out. Retrying under the same key could double-send, so `POST /sends/{id}/retry` answers **409 `INDETERMINATE`** and stays refused. An autonomous client must escalate here — reconcile at the provider, or clone the draft under a *new* idempotency key. Never loop on it.",
        },
        {
          kind: "p",
          text: "A `failed_transient` with `next_retry_at` set is still in progress: the scheduler will try again on its own, and a manual retry on top of that is wasted work. Only retry when the field is absent.",
        },
      ],
    },

    {
      id: "agents",
      title: "Using this from an agent",
      blocks: [
        {
          kind: "p",
          text: "Everything on this page is available as plain text at a stable URL, so a coding agent can read the API without a browser and without HTML parsing. Point Claude Code, Codex, Cursor or anything else that can run `curl` at one of these.",
        },
        {
          kind: "table",
          head: ["URL", "What it is"],
          rows: [
            [`\`${origin}/documentation/llms.txt\``, "The [llms.txt](https://llmstxt.org) index: what this API is, where the other files are, and the send protocol in full. Start here."],
            [`\`${origin}/documentation/llms-full.txt\``, "This entire page as markdown — every endpoint, field, error code and example. One fetch, no navigation."],
            [`\`${origin}/documentation/openapi.json\``, "OpenAPI 3.1. Feed it to a client generator, or to any tool that already speaks OpenAPI."],
            [`\`${origin}/documentation/AGENTS.md\``, "A drop-in instruction file. Save it into a repo as `AGENTS.md` or `CLAUDE.md` and the agent working there knows the protocol without being told."],
            [`\`${origin}/llms.txt\``, "Site root, for crawlers and agents that look there by convention. Points at the above."],
          ],
        },
        {
          kind: "code",
          lang: "bash",
          caption: "Give an agent the whole API in one command.",
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
          text: "The documentation is served by the Next.js app; the API itself is served by the Convex deployment at `" + BASE_URL + "`. The `.txt` and `.json` files live on the app origin, every `/api/v1` route lives on the Convex one. Both are public — the docs need no credential at all.",
        },
        {
          kind: "p",
          text: "There is also a full end-to-end script in the repository at `docs/api-walkthrough.sh`, which drives search → poll → results → rerun → draft → confirm → send → double-send → retry → outbox and asserts the two send responses are byte-identical. It needs only `curl` and `python3`.",
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
        {
          kind: "list",
          items: [
            "**Field names are `snake_case`** in requests and responses, matching the specification. `camelCase` is accepted on request bodies too — being liberal in what we accept without being ambiguous in what we mean.",
            "**Timestamps are ISO 8601 strings**, always UTC, always the same shape.",
            "**Ids are opaque strings.** Do not parse them. An id minted for one table is rejected on a route for another, so `/sends/{a-draft-id}` is a clean 404 rather than a confusing internal error.",
            "**`404`, never `403`.** A request for another user's row is indistinguishable from a request for a row that does not exist. A 403 would confirm the row exists, which is a slow enumeration oracle.",
            "**`OPTIONS` is supported** on every route, with a 204 and the CORS headers.",
            "**`HEAD` is treated as `GET`.**",
            "**Lists are capped** at 50 rows, results at 200, attempt timelines at 32. There is no pagination cursor; this is an assessment surface, not a warehouse.",
          ],
        },
        {
          kind: "p",
          text: "Every route lives under `/api/v1`. `POST /drafts` and `POST /drafts/{id}/send` are **also** mounted at the bare paths the specification writes literally. Both mount points reach one routing table and one handler, so the alias cannot drift from the versioned route — there is only one implementation of it.",
        },
      ],
    },
  ];
}
