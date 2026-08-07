# Unified Inbox

Search Gmail, Slack and the web from one place, and send replies only after an
explicit confirm step.

The search is the easy half. The parts the code is actually shaped around are
that the same message cannot be sent twice, that a slow provider cannot hold up a
fast one, and that every failure gets classified before anything decides whether
to retry it.

| | |
| --- | --- |
| Deployed app | https://unified-inbox-assessment.vercel.app |
| Frontend | Next.js 16 (App Router, Turbopack) + Tailwind 4 |
| Backend, DB, scheduler, cron | Convex |
| Auth | Clerk for users, `uik_…` API keys for REST |
| Web search | Tavily, with a labelled deterministic mock as the fallback |

| Route | What it is |
| --- | --- |
| `/dashboard` | The unified inbox: search, compose, connections. Signed in only |
| `/outbox` | Send history, each reply under the message it answered. Signed in only |
| `/auth` | Sign in and sign up, one email-code flow. Signed out only |
| `/documentation` | The REST reference, plus markdown and OpenAPI copies for agents. **Public** |
| `/` | Redirects to whichever of these you belong on |

- [Architecture](#architecture)
- [Local setup](#local-setup)
- [GitHub Codespaces](#github-codespaces)
- [OAuth setup](#oauth-setup)
- [Web search](#web-search)
- [Seeding and fault injection](#seeding-and-fault-injection)
- [REST API](#rest-api)
- [Tests](#tests)
- [Deployments](#deployments)
- [Screenshots](#screenshots)
- [Known limits](#known-limits)

---

## Architecture

### The module boundary

Everything that talks to a provider, and everything that decides whether a
message may be delivered, lives in `convex/`. That is the standalone module. It
has two thin consumers and neither of them holds any policy:

```
                 ┌───────────────────────────────────────────────┐
                 │  convex/  : adapters, fan-out, send gate      │
  Next.js UI ───▶│                                               │
  (Clerk JWT)    │  oauth.ts        connections.ts   crypto      │
                 │  searches.ts     orchestrator.ts  registry    │
  curl / REST ──▶│  drafts.ts       sends.ts         crons       │
  (uik_ API key) │  adapters/{gmail,slack,web}.ts                │
                 └───────────────────────────────────────────────┘
```

`app/(inbox)/` is presentation plus two hooks. It holds no retry logic, no
idempotency logic and no provider knowledge. `convex/api/` is the REST shell, so
it authenticates a bearer key, resolves a `userId`, calls the same internal
functions the UI calls, and projects the row to public JSON.

The proof that the boundary is where I say it is: `docs/api-walkthrough.sh` drives
the whole product over `curl` with no browser open.

### The adapter contract

`convex/core/types.ts` is the entire surface between the merge layer and the
providers. `SearchAdapter` and `Result` are copied verbatim out of the spec and
not widened. The merge layer imports those two types and nothing else, so it has
no idea Gmail or Slack exist.

An adapter only gets what it needs: a valid access token, the scopes the grant
actually holds (so it can skip an optional call instead of firing it and eating
a 403), a result limit, and an `AbortSignal`. It never sees the connection row
or a refresh token. Token lifecycle is the orchestrator's problem, and that's
what keeps an adapter small enough that writing a new one is a morning's work.

The UI needed more than the seven fields. Multiple connectors, multiple accounts
in each, all merged into one list, and a row you can't place (which account,
which workspace, who wrote it) is the list not being usable. So a row carries an
avatar, a workspace label, a thread id, a reply-to. None of that fits in seven
fields. The answer is a separate `ResultExtras` interface and
`EnrichedResult = Result & Partial<ResultExtras>`. Every extra is optional, so a
plain `SearchAdapter` already satisfies the enriched interface, and the web
adapter has no idea any of this exists. The extras are stored as real typed
columns for the UI, and the REST projection strips them all, so the public
`Result` stays exactly the seven fields from the spec. A validator in
`convex/api/views.ts` enforces that, so an eighth field can't leak into the API
without that file changing and a test going red.

### Search fan-out

```
searches.run (mutation)
  ├─ rate limit (10 fan-outs/min/user, since one search is up to 5 provider calls)
  ├─ insert searches row
  ├─ insert ONE searchSources row per enabled connection, plus one for web
  ├─ scheduler.runAfter(0, orchestrator.runSource) once per row   ← independent workers
  └─ scheduler.runAfter(25s, orchestrator.sweepSearch)            ← watchdog
```

Every source runs on its own, isolated, separately. Two Gmail accounts, a Slack
workspace and web search are four separate workers with nothing shared, so a
slow one can't block anything, and a crashed one only takes down its own row.

Each worker resolves a token, calls the adapter under a 20 second timeout with
three attempts, and then commits everything (results, final status, counts,
duration, the parent search's completion check) in **one mutation**. That
one-mutation rule is why a subscriber never sees "succeeded with zero results"
or half a batch flicker past.

Partial results are one reactive query, `searches.watch`, returning
`{search, sources[], results[]}`. The UI appends in arrival order and never
re-sorts under the reader. A write-time `score` exists in parallel and REST
exposes `?order=rank|arrival`, defaulting to rank.

And nothing spins forever. A watchdog (`sweepSearch`) forces a still-running
source to `failed` after 25 seconds, classified `transient`, because the worker
vanished and that says nothing about the provider. A 5 minute cron backs the
watchdog up. Neither is load-bearing.

### Adding a source

The merge layer doesn't change. Nothing in the orchestrator, ranking, REST,
history or the send gate names a provider (they all go through
`ADAPTERS[source]`), so a new adapter inherits the concurrent fan-out, partial
results, retries, error classification, reconnect and history for free.

What you write is one adapter file plus one line in `convex/core/registry.ts`.
Then you widen a union in six places:

| File | Why |
|---|---|
| `convex/core/types.ts` | The `Source` union. |
| `convex/schema.ts` | `v.literal("<name>")` in `source`. |
| `convex/core/rank.ts` | A weight in `SOURCE_WEIGHT`. |
| `app/(inbox)/types.ts` | The UI's `Source`, which is a deliberate copy. |
| `app/(inbox)/mock-data.ts` | A display name. |
| `app/(inbox)/brand-icons.tsx` | A logo. |

Every one of those is an exhaustive `Record<Source, …>` or a union, so `tsc`
fails until each is filled in. The compiler hands you the list, you don't grep
for it. And the last two aren't really plumbing anyway, a display name and an
icon are new information nothing could derive for you.

`ALL_SOURCES` is derived from `Object.keys(ADAPTERS)` instead of being written
out again, so a source is declared in exactly one place and registering an
adapter automatically includes it everywhere. It used to be three hand-maintained
`["gmail","slack","web"]` literals, and forgetting one meant a registered adapter
that silently never ran, with a green build. That was the only silent failure in
the whole system, so it's the one that got removed.
`convex/core/registry.test.ts` pins the registry, the schema and `requiresGrant`
to each other.

The honest caveat: a source needing OAuth also touches the `provider` union,
`oauth.ts` and the callback route. That's a second grant type, not adapter
plumbing.

### The send gate

```
1. drafts.create        → a draft row + an idempotency key minted with it.
                          The response already shows the exact payload + its digest
2. drafts.reviewPayload → the same payload + digest, read back on demand
3. drafts.confirm       → takes that digest back, the server re-derives and compares
4. sends.send           → sends.claim: indexed unique read + insert, ONE mutation
                          → scheduler.runAfter(0, sends.deliver) in the same transaction
```

There is no function anywhere that takes a recipient and a body and just sends
them. Not in Convex, not in REST. Composing writes a draft, sending points at a
draft. The shape of `convex/drafts.ts` *is* the friction, not a check bolted
onto a one-shot path.

One honest note on step 2: nothing forces the separate read-back, because create
already returns the payload and its digest, so create, confirm, send is a valid
path. That's fine, because what the gate actually enforces is stronger. The
exact message was shown before it could be confirmed, the confirmation dies the
moment the draft changes, and the recipient has to be typed out again at send
time. The digest covers the draft's revision counter, so any edit kills a
previous confirmation, even editing A to B and back to A, byte for byte, because
the revision moved.

The digest is derived three times: at review, at confirm, and again inside the
claim. The third one is what actually gates delivery. Everything before it is
UI.

#### Why double-sending is impossible

`sends.claim` is one mutation on purpose. Every Convex mutation is one
all-or-nothing ACID transaction, and conflicts get caught and retried
automatically through OCC (optimistic concurrency control), so the check and the
claim happen together or not at all:

```ts
const existing = await ctx.db
  .query("sends")
  .withIndex("by_user_idempotency_key", (q) =>
    q.eq("userId", userId).eq("idempotencyKey", draft.idempotencyKey))
  .unique();                                            // indexed range read
if (existing !== null) return existing;                 // the receipt, unchanged
const sendId = await ctx.db.insert("sends", { … });      // insert into that same range
await ctx.scheduler.runAfter(0, internal.sends.deliver, { sendId });
```

Two double-taps arrive at once: both read "no row", both try to insert, one
loses the OCC conflict check, Convex retries it automatically, and on the retry
it finds the winner's row and just returns it. Exactly one claimant, no locks,
and no unique-constraint support needed from the database.

Three ways to get this wrong, all avoided on purpose:

1. **Scanning the table instead of using the index.** Still correct, but now
   every send conflicts with every other send and throughput dies.
2. **Looking it up by `draftId` instead of by key.** Then two drafts sharing a
   key don't conflict at all, which is the exact case the guarantee exists for.
3. **Splitting the check and the insert into separate steps.** That brings back
   the very race this closes.

A few more things happen in that same transaction. The payload gets copied onto
the claim, not referenced, so editing the draft afterwards can't change what's
being sent. Delivery gets scheduled inside the transaction, so a job can never
exist without its claim. And the same key with a different payload is refused
with `409 IDEMPOTENCY_KEY_REUSED` rather than silently delivering either
version.

> Neither Gmail nor Slack offers server-side idempotency on send, so there is no
> provider-side safety net underneath this and the claim row is the whole
> guarantee. Gmail sends do carry a deterministic `Message-ID` and an
> `X-Unified-Inbox-Key` header derived from the idempotency key, but those exist
> so an indeterminate outcome can be reconciled later *by reading*, via an
> `rfc822msgid:` search. They are not deduplication.

#### Failure taxonomy

Every attempt is recorded before and after the provider call, so the timeline
survives a worker dying mid-flight, and `in_flight` works as a lease, so mashing
retry does nothing. `beginAttempt` refuses four ways, and each refusal is a
provider call that didn't happen: already `succeeded`, someone's mid-attempt,
the outcome is `unknown`, or the auto-retry budget is spent.

Failures are classified where the provider response is parsed, stored as-is, and
the retry logic acts on the same verdict an operator later reads.

| Kind | What it means | What happens |
| --- | --- | --- |
| `transient` | 429, 5xx, network, Slack `ratelimited` | Full-jitter backoff up to 4 attempts, then left `failed_transient` with no scheduled retry so an operator can still act. Never relabelled permanent, that would be a lie about what the provider said. |
| `permanent` | 400, rejected recipient, `channel_not_found` | One attempt. No retry can help. |
| `needs_reconnect` | `invalid_grant`, 401, `token_revoked`, `missing_scope` | Connection flips to `revoked` with the verbatim reason, and the draft stays `confirmed`, so reconnect-then-retry reuses the same key and still cannot send twice. |
| `unknown` | Dispatched then silence, so a timeout after the bytes were on the wire, or a swept abandoned `in_flight` | Terminal for the key. Never auto-retried, and a manual retry is *refused*. |

That last row is the whole point. `toAdapterError` correctly calls a timeout
`transient` for a *read*, and then `classifySendFailure` reclassifies it to
`unknown` once the send was actually dispatched. That one reclassification is the
difference between a retry loop that is safe and one that occasionally sends two
emails.

Recovery from `unknown` is reconcile or clone, never retry. The Gmail `Message-ID`
is derived from the idempotency key, so `rfc822msgid:` answers "did this exact
claim already go out" without sending anything. Otherwise compose again, which
mints a new key, so the new claim is a genuinely new message and the old one stays
on the record.

Errors are stored redacted, no tokens, no auth headers, capped bodies, but
otherwise in full, and shown in full in the outbox with the provider's own words,
the HTTP status and every attempt's timestamps.

### Multi-account OAuth and tokens

```
browser ──▶ api.oauth.begin({provider, reconnectConnectionId?, returnTo})  [authenticated mutation]
                └─ inserts oauthStates {state, PKCE verifier, provider, expiry}
                └─ returns the provider authorize URL
browser ──▶ accounts.google.com / slack.com   (consent)
provider ─▶ https://<deployment>.convex.site/oauth/{google,slack}/callback  [httpAction]
                └─ consumeState()  single-use, expiring, provider-bound, one transaction
                └─ exchange code (PKCE for Google) → fetch identity → encrypt → upsert
                └─ 302 to the flow's resolved origin + sanitized returnTo
```

**The flow starts from the backend.** `begin` is an authenticated Convex
mutation, not an HTTP route, so identity is proven before anything happens and
nothing sensitive ever rides in a URL. The only thing in the URL is an opaque
single-use `state` that means nothing on its own.

**The callback lands on the Convex deployment**, which has a stable public URL.
That's why real Google and Slack OAuth work while the frontend is still just on
`localhost`, no tunnel needed. And the redirect URI is derived from
`CONVEX_SITE_URL` instead of configured by hand, because both providers demand a
byte-exact match, and a hand-set env var is exactly the thing that drifts
between deployments and then breaks with `redirect_uri_mismatch`.

**The `state` is single use, expires, and is bound to one provider.** The
provider gets passed in as an argument and has to match the stored row, because
reading it *off* the row would let a state minted for Slack be redeemed at the
Google callback. And `returnTo` gets reduced to a plain same-origin path, so
`//evil.test` and backslashes get dropped, not repaired.

**Where the callback sends the browser back is checked, not trusted**, because
an unchecked redirect is an open redirect. A deployment can't know the
frontend's origin (`next dev` picks whatever port it wants), so the browser
proposes its own origin and the backend checks it. Loopback is allowed on any
port, a deployed frontend gets registered once via `APP_BASE_URL` or
`APP_ORIGIN_ALLOWLIST`, and anything else falls back to `APP_BASE_URL`.
Private-network origins (a phone on the same Wi-Fi, via `pnpm dev:lan`) are only
allowed when `ALLOW_PRIVATE_NETWORK_ORIGINS="true"`, and only on dev. The
resolved origin is stored on the `oauthStates` row when the flow starts, so
nothing arriving at the callback later can influence it. `resolveAppOrigin` is
unit-tested in `convex/oauth.test.ts`, including lookalike hosts like
`localhost.evil.test` that a substring check would wave through.

**Identity-preserving reconnect.** The upsert key is
`(userId, provider, externalAccountId)`, so re-granting an existing account
patches the same `connections` row and keeps its `_id`. Every draft, send and
result pointing at that connection stays valid, since reconnecting is not a new
account. Reconnecting *as a different account* is rejected explicitly with "add it
as another account instead" rather than silently rebinding the row. Gmail's
identity is the email address, which is a documented tradeoff against the strictly
immutable `sub` and argued in `convex/http.ts`. Slack's is `T…:U…`, because the
same person in two workspaces is two connections.

**Tokens are encrypted at rest** with AES-256-GCM through Web Crypto, in a
versioned envelope whose authenticated data is
`v1|provider|connectionId|tokenType`. That buys two things. Tampered data fails
to decrypt instead of yielding garbage we would then hand to Google as a bearer
token. And a ciphertext is bound to its own connection and token slot, so it
can't be moved to a different row or swapped between the access and refresh
slots. A dump of the `connections` table gets you nothing without
`TOKEN_ENCRYPTION_KEY`, which only lives in the deployment environment.

**Refresh on use, with a lock.** There is no refresh cron. A token gets
refreshed at the moment something needs it, inside `resolveToken`, which is the
only place in the codebase that can touch a credential. The catch is that a
search and a send can hit the same connection at the same moment, and parallel
refreshes are wasteful with a static refresh token and actual data loss with a
rotating one, because the losers would store tokens the provider already
invalidated. So there's a lock: one caller refreshes, the others wait a beat and
re-read. And tokens get refreshed 120 seconds before they expire, so it happens
before a failure instead of after a 401. `invalid_grant` and `token_revoked`
flip the connection to `revoked` with the provider's exact words and surface
`needs_reconnect` in the UI.

Slack token rotation is disabled in the Slack app's settings, on purpose. With
it off the token never expires, so Slack has nothing to refresh, and the refresh
flow above is all for Gmail, where tokens expire hourly. The Slack refresh
branch is written and exported so turning rotation on later is a console change,
not new code. Nothing calls it today.

Disconnecting is a soft delete, so the row stays and the status becomes `revoked`,
which keeps `drafts.connectionId` and every historical send valid.

### Auth, briefly

Clerk issues a JWT from a template and Convex verifies it on every request (the
session token has to carry `aud: "convex"`). Three frontend layers (`proxy.ts`,
the `AuthGate` / `GuestGate` splash, and `useAuthedQuery` holding queries at
`"skip"`) exist just to cover the async window while Clerk resolves a session
and Convex trades it for its own token, so that window never renders a broken
shell.

But none of that is the real security. Every Convex function checks its own
owner through `requireUser`, so even a request that got past the frontend can't
read another user's data. A Clerk webhook (Svix-verified, idempotent upserts)
keeps `users` correct between sessions, and `user.deleted` cascades into
deleting connections and their tokens, so the token vault never outlives the
account.

---

## Local setup

Needs Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env.local     # then fill in the Clerk values
npx convex dev                 # provisions the deployment, writes CONVEX_* into .env.local
pnpm dev                       # in a second terminal
```

`pnpm exec convex dev` has to stay running in development, it pushes `convex/`
on save.

Two separate places hold config and mixing them up is the usual cause of a
confusing failure. `.env.local` is read by **Next.js only**. Everything the
backend needs is set on the **Convex deployment** with `npx convex env set`.

To open it on a phone use `pnpm dev:lan` instead of `pnpm dev`. A plain LAN
origin is not a secure context, so clerk-js silently never starts. `dev:lan`
generates a mkcert certificate for this machine's LAN address, serves HTTPS on
every interface, and sets `ALLOW_PRIVATE_NETWORK_ORIGINS` on the dev deployment
so an OAuth callback can return to the phone.

### `.env.local` (Next.js)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk frontend |
| `CLERK_SECRET_KEY` | Clerk backend |
| `CLERK_JWT_ISSUER_DOMAIN` | Clerk Frontend API URL, also set on Convex |
| `NEXT_PUBLIC_CONVEX_URL` | Convex deployment URL (written by `convex dev`) |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Convex HTTP-action base URL (written by `convex dev`) |
| `CONVEX_DEPLOYMENT` | Which deployment the CLI pushes to (written by `convex dev`) |

### Convex deployment env

Add `--prod` to set the same value on the hand-in deployment.

| Variable | Required? | What it does |
| --- | --- | --- |
| `CLERK_JWT_ISSUER_DOMAIN` | yes | Validates the incoming Clerk JWT. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | yes | Verifies the Clerk webhook signature. Per-endpoint, so dev and prod differ. |
| `TOKEN_ENCRYPTION_KEY` | yes | AES-256 key for the token envelope. `openssl rand -base64 32`. Per-deployment, one deployment's key must not decrypt another's tokens. |
| `GOOGLE_OAUTH_CLIENT_ID` | for Gmail | GCP, Credentials, OAuth client (Web application). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | for Gmail | Same client. |
| `SLACK_CLIENT_ID` | for Slack | Slack app, Basic Information. |
| `SLACK_CLIENT_SECRET` | for Slack | Same app. |
| `APP_BASE_URL` | yes | Fallback origin the OAuth callback returns the browser to, e.g. `http://localhost:3000`. The browser proposes its own origin and that wins when allowed. |
| `APP_ORIGIN_ALLOWLIST` | no | Comma-separated extra origins the callback may return to. Localhost never needs listing. |
| `ALLOW_PRIVATE_NETWORK_ORIGINS` | no | `"true"` also allows a private-network origin on any port, so a phone on the same Wi-Fi can finish an OAuth flow. `pnpm dev:lan` sets it on dev, leave it unset on hand-in. |
| `WEB_SEARCH_PROVIDER` | no | `tavily`, or unset for the mock. |
| `WEB_SEARCH_API_KEY` | no | Key for the chosen provider. Unset means mock. |
| `ALLOW_FAULT_INJECTION` | no | `"true"` enables the demo failure switches. Inert otherwise. |

```bash
npx convex env set TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"
npx convex env set APP_BASE_URL http://localhost:3000
npx convex env set ALLOW_FAULT_INJECTION true
```

`CONVEX_SITE_URL` is injected by Convex itself and is what the OAuth redirect URIs
are derived from, so they cannot drift between deployments.

### Clerk

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com)
   with Email and Google enabled.
2. Copy the publishable key and secret key into `.env.local`.
3. Make the session token carry `aud: "convex"`. Either create a JWT template
   named exactly `convex` from Clerk's Convex preset, or set the audience on the
   Sessions page in newer dashboards. Either works.
4. Copy the Issuer / Frontend API URL into `.env.local` as
   `CLERK_JWT_ISSUER_DOMAIN`, and onto Convex:

   ```bash
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
   ```
5. Clerk dashboard, Configure, Webhooks. One endpoint per deployment, pointed at
   `https://<deployment>.convex.site/clerk-webhook`, subscribed to `user.created`,
   `user.updated` and `user.deleted`. Copy that endpoint's signing secret onto the
   matching deployment as `CLERK_WEBHOOK_SIGNING_SECRET`, each endpoint has its
   own so they are not interchangeable.

Then sign in at `/auth`. If Convex rejects the session, the `aud` claim or
`CLERK_JWT_ISSUER_DOMAIN` on the deployment is wrong, and `users.viewer` is the
thing to check because it reports the Clerk user id resolved *by Convex* rather
than by the browser.

---

## GitHub Codespaces

[`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) gives a Node
20 image with pnpm via corepack, runs a frozen `pnpm install` on create, and
forwards port 3000.

Open the repository in a Codespace. If you store
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and
`CLERK_JWT_ISSUER_DOMAIN` as repository Codespaces secrets, they are already
available in the terminal. The devcontainer supplies the two public Convex URLs
for `judicious-wildcat-326`, so starting the app is one command:

```bash
pnpm dev
```

Open the forwarded port 3000 when Codespaces reports it. No Convex process is
needed merely to run the frontend against the existing backend.

Only run `pnpm exec convex dev` when changing files under `convex/`. That command
needs Convex authentication: either sign in interactively or provide a dev
deployment key as the `CONVEX_DEPLOY_KEY` Codespaces secret. Keep it running only
for the duration of backend development so it can push and watch those changes.

Gmail and Slack OAuth callbacks also need the Codespace origin registered as
`APP_BASE_URL` or in `APP_ORIGIN_ALLOWLIST`. Changing that backend environment
setting likewise requires Convex authentication; it is not required just to
start and inspect the app.

After Convex and Clerk, no third-party signup is needed to see the whole product.
Web search runs on the labelled deterministic mock so the fan-out has three real
sources with no API key, the demo data button fills history with every status,
`docs/api-walkthrough.sh` exercises the REST surface end to end, and `pnpm test`
needs nothing external at all.

Gmail and Slack still need their own OAuth apps, and their provider redirect URIs
continue to point at `convex.site`, not at the Codespace.

---

## OAuth setup

Both providers need the redirect URI to match byte for byte. It is always:

```
https://<your-convex-deployment>.convex.site/oauth/google/callback
https://<your-convex-deployment>.convex.site/oauth/slack/callback
```

`<your-convex-deployment>` is the slug in `NEXT_PUBLIC_CONVEX_SITE_URL`, written
into `.env.local` by `npx convex dev`. Note `.convex.site` and not
`.convex.cloud`, and note it is the *Convex* URL rather than `localhost`, which is
what makes real OAuth work without a tunnel.

### Google (Gmail)

1. [console.cloud.google.com](https://console.cloud.google.com), new project.
2. APIs & Services, Library, enable the **Gmail API** and the **People API**. The
   second one is only for sender avatars.
3. OAuth consent screen, External, fill in the app name and support email. Leave
   the publishing status as **Testing**.
4. Audience, Test users, add every Google account you intend to connect. In
   Testing mode an account that is not on this list cannot grant access at all.
5. Data access, Add scopes. Five, and no more: `openid`, `email`,
   `https://www.googleapis.com/auth/gmail.readonly`,
   `https://www.googleapis.com/auth/gmail.send`,
   `https://www.googleapis.com/auth/contacts.readonly`. Notably absent:
   `gmail.modify`, `gmail.compose`, and anything that can delete mail.
6. Credentials, Create credentials, OAuth client ID, Web application. Authorised
   redirect URI: `https://<deployment>.convex.site/oauth/google/callback`.
7. Set the client id and secret on Convex:

   ```bash
   npx convex env set GOOGLE_OAUTH_CLIENT_ID     <id>.apps.googleusercontent.com
   npx convex env set GOOGLE_OAUTH_CLIENT_SECRET GOCSPX-…
   ```

`contacts.readonly` buys exactly one thing: the sender's profile photo on a
result row. Gmail's search API gives you no avatar anywhere, so if you want a
face on a row, this is the narrowest scope Google offers that returns a photo at
all, and it's read-only. There's a fallback for everything that depends on it: a
grant without the scope keeps searching fine, and the row falls back to the
sender's domain favicon and then to their initial.

Two things to expect, both normal. A Testing-mode app shows the "Google hasn't
verified this app" interstitial, so click Advanced and continue, since
verification is a review process rather than a code change. And refresh tokens
expire after 7 days while the app is in Testing, which is Google's documented
behaviour and is not worked around. It is why the reconnect path is a routinely
demonstrable feature rather than a branch nobody ever exercises.

The authorization request sends `access_type=offline` and `prompt=consent` on
every authorization, because a re-consent for scopes already granted returns no
refresh token at all. Even then the code exchange may legitimately return none, in
which case the stored refresh token is kept rather than overwritten with nothing.
PKCE (S256) is used on the Google flow.

### Slack

Create the app from a manifest. Slack API, Your apps, Create New App, From an app
manifest, then paste this with your deployment slug substituted in:

```yaml
display_information:
  name: Unified Inbox
  description: Search and reply across Gmail, Slack and The Web from one place.
oauth_config:
  redirect_urls:
    - https://<deployment>.convex.site/oauth/slack/callback
  scopes:
    user:
      - search:read
      - chat:write
      - users:read
      - channels:history
      - groups:history
settings:
  token_rotation_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
```

Then Basic Information, App Credentials:

```bash
npx convex env set SLACK_CLIENT_ID     123…
npx convex env set SLACK_CLIENT_SECRET …
```

Install it into a throwaway workspace. Four Slack-specific notes:

- **`search.messages` requires a user token (`xoxp-`)**, a bot token cannot call
  it at all. So the install requests `user_scope` and the app reads
  `authed_user.access_token`, deliberately ignoring the top-level bot token. If
  you see "returned no user token", the manifest granted `scopes.bot` instead of
  `scopes.user`.
- **The two history scopes** exist only so `conversations.replies` can tell a
  result that has a thread hanging off it from one that does not. They are
  read-only and the adapter only ever asks about a message it already found, it
  never calls `conversations.history`, which is what reads a channel wholesale. A
  connection authorised before these were requested keeps working and just shows
  no reply counts until it reconnects.
- **Slack does not support PKCE** on `oauth.v2.access`, so the single-use,
  expiring, provider-bound `state` is the whole CSRF defence there.
- **Slack reports application errors as HTTP 200** with `{ok: false, error}`, so
  status-code classification is useless and the `error` string is mapped
  explicitly in `classifySlackError`. `token_revoked` becomes reconnect,
  `ratelimited` becomes transient, `channel_not_found` becomes permanent, and
  anything unrecognised becomes permanent, because an unclassified failure
  retrying forever is worse than one an operator has to look at. Slack `ts` values
  are `seconds.micros` so they get multiplied by 1000, and forgetting that puts
  every message in 1970.

For a reviewer to connect their own workspace, Manage Distribution, Activate
Public Distribution has to be on. Until it is, authorizing from any other
workspace fails with `invalid_team_for_non_distributed_app` before the consent
screen even renders.

---

## Web search

Web search is **Tavily**, and the reasons are boring, which is fine. A genuinely
free tier at 1,000 searches a month, no credit card, and one POST returns title,
url and content, which is exactly what the third source needs. Brave Search
would be a drop-in swap behind the same interface, and nothing above the adapter
would change.

```bash
npx convex env set WEB_SEARCH_PROVIDER tavily
npx convex env set WEB_SEARCH_API_KEY  tvly-…
```

With no key set the web source falls back to a clearly-labelled deterministic
mock, so a fresh clone or Codespace searches all three sources with zero signups.
The rules for that fallback, because demo data that can be mistaken for real data
is worse than no demo data:

- Every title is prefixed `[mock]`, and the source strip reads "Web search (mock
  provider)" rather than just "Web".
- Each snippet says how to switch to the real thing.
- URLs are real search pages on real sites, so clicking a result is not a dead
  end.
- Result count and ordering are a stable hash of the query, so the same query
  always returns the same results and screenshots and tests stay reproducible.
- A configured provider with a *missing* key falls back to the mock rather than
  failing the source, because a missing key is a setup state and not an outage.

Web results deliberately carry no `timestamp`. Tavily's `published_date` is absent
for most pages and wrong for a fair share of the rest, and an absent timestamp is
honest where a guessed one would poison ranking. The schema and the public
`Result` both allow it to be missing, which is one of three ways the web source is
unlike Gmail and Slack, no grant, no timestamp, no reply, that the merge layer has
to absorb without special-casing.

---

## Seeding and fault injection

### Load demo data

**Settings, Demo data, Load demo data.** It is an authenticated public mutation
(`api.seed.seed`) scoped to the calling user, so a reviewer runs it from the UI
with no CLI and no shared state.

It creates one full set of fixtures:

- **5 connections covering every status.** An active Gmail account and an active
  Slack workspace, a second Gmail in `expired`, a third in `errored`, and a Slack
  workspace in `revoked`.
- **6 searches** with their per-source runs and results, including two still
  `running` so the partial-results state is visible standing still, one where
  Slack came back `needs_reconnect`, one with a `failed` source, and one that
  legitimately matched nothing.
- **Drafts in every status**, so `draft`, `confirmed`, `sent` and `failed`.
- **A send in each of the seven states**, `queued`, `in_flight`, `succeeded`,
  `failed_transient`, `failed_permanent`, `needs_reconnect` and `unknown`, each
  with a realistic attempt timeline and a full error where one applies.

Three rules make it safe to ship. Every row is `isSeed: true` and scoped to the
caller, the UI badges them as demo data, and **Remove demo data** deletes only the
caller's own rows, with every top-level delete gated on `isSeed` and children
reached through their seeded parent rather than by a flag of their own. Seeded
connections hold no grant, since their ciphertext is the literal string `seed`,
`resolveToken` refuses `isSeed` rows *before* any provider call, and they are left
`enabled: false` so they never join a live fan-out, which means demo data cannot
spend a real API quota even on a failure. And running it twice changes nothing,
the mutation looks for its own connections first and returns what already exists.

Seeded error text is prefixed `[seed]` for the same reason injected faults are
prefixed `[simulated]`. An operator must never have to wonder whether an error in
front of them really happened.

### Fault injection

Gated behind `ALLOW_FAULT_INJECTION=true` on the deployment and completely inert
without it, so a demo flag left in a client build cannot break a real search.

| Affordance | Where | What it demonstrates |
| --- | --- | --- |
| `demo.delayMs: {web: 3600}` | on by default in `useSearch.ts`, also an argument to `searches.run` / `searches.rerun` | Gmail and Slack land and are readable while web is still working. Criterion: partial results. |
| `demo.injectFailure: {slack: "needs_reconnect"}` | same argument | A revoked grant renders as its own state with a reconnect action, not a generic error. |
| `demo.injectFailure: {gmail: "transient"}` | same argument | Backoff, the attempt counter climbing, then giving up honestly. |
| `drafts.create({injectFailure})` | compose | Any of the four send outcomes on demand, including `unknown`, the one that refuses to be retried. The fault is copied onto the frozen send so it survives retries. |
| `connections.simulateRevoke({connectionId})` | mutation | Breaks a real connection's tokens *without* touching its status, so the system has to discover the dead grant on next use, classify the provider's real 401 and flip the status itself. Setting the status directly would demo the UI and skip the mechanism. |

---

## REST API

The same module, no browser. Base URL is the Convex site URL,
`https://<deployment>.convex.site`.

**Auth.** Create a key in Settings, API keys. It is shown once and stored only as
a SHA-256 digest, because a database dump must not be a set of working
credentials. There is no "show key" endpoint and no REST route that mints, lists
or revokes keys, so key management is Clerk-authenticated only and a leaked key
cannot mint a fresh one and outlive its own revocation. Lookup is an indexed read
on the digest with a constant-time comparison.

```
Authorization: Bearer uik_…
```

A request for another user's row returns **404, not 403**, since 403 would confirm
the row exists and that is a slow enumeration oracle. Rate limits are token
buckets per user, 10 fan-outs a minute and 30 REST writes a minute, and
`Retry-After` comes from the bucket's own arithmetic so it says when a retry will
actually succeed.

Every route lives under `/api/v1`. `POST /drafts` and `POST /drafts/{id}/send` are
also mounted at the bare paths the spec writes literally, and both mount points
reach one routing table so the alias cannot drift from the versioned route.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/searches` | `{query, sources?}` → **202** + `search_url`, `results_url`. |
| `GET` | `/api/v1/searches` | The caller's history. |
| `GET` | `/api/v1/searches/{id}` | Status plus per-source status, attempts, duration and error. |
| `GET` | `/api/v1/searches/{id}/results` | `?order=rank\|arrival`. Exactly the seven public fields. |
| `POST` | `/api/v1/searches/{id}/rerun` | **202.** Creates a *new* search with `rerun_of`, history is never overwritten. |
| `POST` | `/api/v1/drafts` (also `/drafts`) | **201**, or **200** with `X-Idempotent-Replay: true` if the key was reused. |
| `GET` | `/api/v1/drafts/{id}` | Includes `canonical_payload` and `review_hash`. |
| `POST` | `/api/v1/drafts/{id}/confirm` | `{reviewed_hash}`. The server re-derives and compares. |
| `POST` | `/api/v1/drafts/{id}/send` (also `/drafts/{id}/send`) | `{acknowledged_destination}`. See below. |
| `GET` | `/api/v1/sends` | The outbox. |
| `GET` | `/api/v1/sends/{id}` | The send plus every attempt and the full redacted error. |
| `POST` | `/api/v1/sends/{id}/retry` | Allowed for a failed send, **409** for an `unknown` one. |
| `GET` | `/api/v1/connections` | Provider, account, status, enabled. |

Errors always have one shape, `{"error": {"code", "message"}}`, because a client
that has to guess whether today's 409 is `{error: "…"}` or `{message: "…"}` ends
up string-matching, and then our error text becomes their API contract.

### The confirm friction exists in the API too

Criterion 4 is not a UI feature. `POST /drafts/{id}/send` requires
`acknowledged_destination` and it has to repeat the draft's recipient verbatim, so
a mismatch is a 409. Combined with the `reviewed_hash` on confirm there is no
endpoint anywhere that accepts a recipient and a body and delivers them.

### Idempotent send semantics

Two calls with the same key return byte-identical response bodies. That the second
one claimed nothing is reported in the `X-Idempotent-Replay` header rather than in
the body, so "prove the double-tap sent once" is `diff` on two files.
`POST /drafts/{id}/send` then waits up to five seconds for the delivery to settle,
so a `curl` in a terminal usually shows the real outcome instead of a job id. Past
that budget it answers **202** with a `Retry-After` and a `send_url`, because
holding the connection open longer would be pretending the send is synchronous
when it is not.

### Documentation, for humans and for agents

`/documentation` on the Next.js app is the full REST reference, so every route,
field, status code and example. It needs no session, because the instructions for
getting a credential must not sit behind the credential, and `proxy.ts` bypasses
Clerk for the whole path so a `curl` gets content rather than a handshake redirect.

The same content is served in four other shapes from one source, so none of them
can drift from the site or from each other:

| URL | What it is |
| --- | --- |
| `/documentation/llms.txt` (also `/llms.txt`) | The [llms.txt](https://llmstxt.org) index: every route and the send protocol in full |
| `/documentation/llms-full.txt` | The entire reference as markdown. One fetch, no navigation |
| `/documentation/openapi.json` | OpenAPI 3.1, for client generation |
| `/documentation/AGENTS.md` | Drop-in instructions to commit into a repository |

```bash
# Hand a coding agent the whole API in one command.
curl -sS https://<app-origin>/documentation/llms-full.txt
```

`app/(docs)/documentation/docs.test.ts` holds the documentation to the code. It
compares the documented endpoint list against the real routing table in
`convex/api/routes.ts`, checks the documented `Result` against the response
validator the backend enforces, and re-derives the worked example's `review_hash`
from its `canonical_payload`. A route added without being documented fails a test.

### Walkthrough

[`docs/api-walkthrough.sh`](docs/api-walkthrough.sh) runs the whole product over
`curl`, so search, poll, results, rerun, draft, confirm, send, double-send, retry
and outbox, and it asserts the two send responses are byte-identical. It needs
only `curl` and `python3`.

```bash
BASE_URL=https://<deployment>.convex.site API_KEY=uik_… ./docs/api-walkthrough.sh
```

Some individual calls:

```bash
API=https://<deployment>.convex.site/api/v1
KEY=uik_…

# 1. Fan out. 202, scheduled, not finished.
curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"invoice"}' "$API/searches"

# 2. Partial results are real, so poll while it runs.
curl -sS -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID"
curl -sS -H "Authorization: Bearer $KEY" "$API/searches/$SEARCH_ID/results?order=arrival"

# 3. Compose. No endpoint takes a recipient and sends.
curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "channel": "gmail",
  "connection_id": "'"$CONNECTION_ID"'",
  "to": "someone@example.com",
  "subject": "Re: invoice INV-2041",
  "body": "Attaching the corrected copy.",
  "idempotency_key": "demo-001"
}' "$API/drafts"

# 4. Read it back: the exact payload and its review_hash.
curl -sS -H "Authorization: Bearer $KEY" "$API/drafts/$DRAFT_ID"

# 5. Confirm with that hash. An edit after this clears the confirmation.
curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"reviewed_hash":"'"$HASH"'"}' "$API/drafts/$DRAFT_ID/confirm"

# 6. Send, echoing the recipient back. Run it twice: identical bodies, one delivery.
curl -sS -D - -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"acknowledged_destination":"someone@example.com"}' \
  "$API/drafts/$DRAFT_ID/send"

# 7. The attempt timeline and the full error.
curl -sS -H "Authorization: Bearer $KEY" "$API/sends/$SEND_ID"
```

---

## Tests

```bash
pnpm test          # vitest run
pnpm test:watch
pnpm typecheck
pnpm lint
```

153 tests across 17 files on `convex-test`, running against a fake provider
`fetch` router that records every call, so "how many times did we hit the
provider" is a direct assertion, not an inference. What they prove, roughly in
order of importance:

- **Idempotency.** A double-send makes exactly one provider call, concurrent
  claims produce exactly one `sends` row, a retry after success makes zero calls,
  the same key with a different payload is a 409, and an `in_flight` send is a
  no-op.
- **Fan-out.** A deferred web source does not stop Gmail's results from being
  readable while it runs, and arrival order is stable.
- **Normalization.** The public `Result` has exactly the seven fields from every
  source, a Slack `ts` lands in the right year, and the REST projection's key set
  is exact.
- **Reconnect.** `invalid_grant` and a Slack `200 {ok:false}` both become
  `needs_reconnect` plus `revoked` with zero wasted provider calls, the upsert
  preserves `_id`, and the same key sends successfully after a reconnect.
- **Failure handling.** A 503 backs off to the attempt ceiling, a 400 fails
  permanently after one attempt, a timeout becomes `unknown`, retrying an
  `unknown` is refused, and the sweeper resolves an abandoned `in_flight`.
- **Confirm friction.** Unconfirmed and edited-after-confirm claims are refused, a
  mismatched `acknowledged_destination` is a 409, and a snapshot of the public
  function list fails if anyone ever adds a one-shot send path.
- **API keys, crypto, canonicalization.** 401s and cross-user 404s, digest-only
  storage, AEAD round-trip, tamper detection, an AAD swap failing, and canonical
  payload stability across revisions.
- **The registry is the only source list.** The derived `ALL_SOURCES`, the schema
  union, every adapter's own `source` and `requiresGrant` all have to agree, so a
  source that is registered but unsearchable fails a test rather than silently
  never running.

### The honest caveat

`convex-test` is an in-memory implementation, and it does **not** reproduce
Convex's real OCC retry. So the concurrent-claim test proves the logic is a
single-transaction indexed read-then-insert, but on its own it can't prove the
behaviour that makes that logic safe under real contention.

So the guarantee is also verified against the real deployed API:

```bash
BASE_URL=… API_KEY=uik_… RECIPIENT=… npx tsx scripts/double-tap.ts
```

It fires N genuinely parallel `POST /drafts/{id}/send` calls at the real API with
one key, and asserts N byte-identical responses, exactly one `sends` row and
exactly one provider message id. Then it checks the recipient's actual inbox or
channel for exactly one copy, which is the only assertion here that is not
ultimately trusting our own bookkeeping.

The same function is the last check in [`pnpm deploy`](#the-pipeline), so every
deploy ends by sending one real message and proving it was sent once.

---

## Deployments

Two Convex deployments, one Clerk instance. Convex only has the deployment types
`dev` and `prod`, so the hand-in deployment *is* the `prod` one, which makes it
Convex's production tier rather than a production application.

| Name | Convex deployment | Purpose |
| --- | --- | --- |
| dev | `judicious-wildcat-326` | `npx convex dev`, pushes on save |
| hand-in (`prod`) | `scintillating-moose-307` | The submitted deployment, deployed build, real OAuth |

```bash
pnpm deploy:handin   # convex deploy → scintillating-moose-307
pnpm dev:handin      # next dev on localhost, pointed at the hand-in deployment
```

`CLERK_JWT_ISSUER_DOMAIN` is identical on both because they share one Clerk
instance. The webhook secret and `TOKEN_ENCRYPTION_KEY` are per-deployment.

The frontend is a third thing, on Vercel, and it does **not** deploy on push:
`vercel.json` sets `git.deploymentEnabled: false`, so the build is made locally
and uploaded with `pnpm deploy:vercel`. The script pulls the production env
first, because `NEXT_PUBLIC_*` values are inlined into the bundle at build time,
and it refuses to build if any of them pulls empty. `main` is the production
branch, and the two halves are independent, so a change touching both `convex/`
and the app needs `pnpm deploy:handin` as well.

### The pipeline

Both halves plus a check that the result works, in one command:

```bash
pnpm deploy                # preflight → convex → frontend → verify
pnpm deploy -- --dry-run   # print the plan, touch nothing (`--` or pnpm eats the flag)
```

[`scripts/deploy-all.mjs`](scripts/deploy-all.mjs) runs four stages and stops at
the first failure, naming it:

| Stage | What runs |
| --- | --- |
| 0. preflight | the smoke credentials exist, checked *before* anything ships |
| 1. convex | `pnpm deploy:handin`, unless stage 2 is doing it (below) |
| 2. frontend | `pnpm deploy:vercel` |
| 3. verify | [`scripts/verify-deploy.ts`](scripts/verify-deploy.ts) against what was just deployed |

Stage 0 is there because the alternative is finding out the verification cannot
run once a deployment is already live and unchecked.

Stage 3 uses the deployed system rather than inspecting it: an authenticated
`GET /connections` answers 200, the same call with no key and with an unissued
`uik_` key answers 401, `/documentation/llms.txt` on the app origin comes back
non-empty, and then the double-tap fires N parallel sends at one idempotency key
and asserts one delivery. It can be run on its own against any deployment:

```bash
BASE_URL=… API_KEY=uik_… RECIPIENT=… [APP_URL=… N=10] pnpm verify:deploy
```

### `CONVEX_DEPLOY_KEY`, and where it lives

Given a Convex production deploy key, stage 2 becomes Convex's documented Vercel
integration, `convex deploy --cmd '<build>'`, which pushes `convex/` and then
runs the build with that deployment's URL in the environment. The backend and
the frontend that calls it go out together, so stage 1 folds into stage 2 and is
skipped. Without a key nothing changes: the script says so in one line and both
stages run as before.

One-time setup: Convex dashboard → the hand-in deployment → Settings → Deploy
Keys → **Generate Production Deploy Key**, then put it in `.env.deploy` at the
repo root, which is git-ignored.

```bash
# .env.deploy
CONVEX_DEPLOY_KEY=prod:scintillating-moose-307|…
SMOKE_API_KEY=uik_…          # Settings → API keys in the deployed app, shown once
SMOKE_RECIPIENT=you@example.com
SMOKE_APP_URL=https://unified-inbox-assessment.vercel.app   # optional
```

The key is not stored on Vercel, because it can't work there. The build runs on
this machine, and a *sensitive* Vercel variable is never handed back by
`vercel pull`, it arrives as an empty string. Storing it `plain` instead would
put a credential that can deploy code in a dashboard, for a remote builder this
project doesn't use. Vercel needs no deploy key at runtime.

The build step under `convex deploy --cmd` is
[`scripts/vercel-build.mjs`](scripts/vercel-build.mjs) rather than `pnpm build`,
because the upload is `--prebuilt` and needs Vercel's output directory. It also
refuses to build when the URL Convex just deployed to and the one pulled from
the Vercel project disagree, because that means the deploy key and the project
point at different Convex deployments, and Vercel's value is the one that gets
inlined.

---

## Screenshots

In [`docs/screenshots/`](docs/screenshots).

| | |
| --- | --- |
| [The lift, idle to results](docs/screenshots/01-hero.png) | [Partial results streaming in](docs/screenshots/02-streaming-partial.png) |
| [Settled, merged, per-source status](docs/screenshots/03-results-settled.png) | [Compose → review, not send](docs/screenshots/04-compose-draft.png) |
| [The review payload and its key](docs/screenshots/05-compose-review.png) | [Delivered, with the attempt log](docs/screenshots/06-send-delivered.png) |
| [Retry with the same key, deliveries stay at 1](docs/screenshots/07-send-deduped.png) | [Connections](docs/screenshots/08-settings-connections.png) |
| [The demo-data panel](docs/screenshots/09-settings-demo.png) | [A revoked grant as its own state](docs/screenshots/10-needs-reconnect.png) |
| [Sidebar collapsed](docs/screenshots/11-sidebar-collapsed.png) | [Archive with undo](docs/screenshots/12-archive-toast.png) |
| [Mobile results](docs/screenshots/13-mobile-results.png) | [Mobile navigation sheet](docs/screenshots/14-mobile-drawer.png) |

Keyboard: `⌘K` focuses the search field, `⌘\` collapses the sidebar, `Esc`
dismisses a dialog or the mobile nav sheet.

Layout regressions are caught with a development-only stress route,
`/ui-stress?scene=…`, which renders the long-string surfaces against awkward
fixtures with no Clerk and no Convex, plus `scripts/screenshots/overflow.mjs`,
which names which element ran past which box and exits 1 if anything did.

---

## Known limits

Stated because a reviewer will find them anyway, and most of them are choices
rather than omissions.

- **No provider-side send idempotency exists**, so the claim row is the whole
  guarantee. The deterministic Gmail `Message-ID` makes an `unknown` outcome
  reconcilable by reading, but reconciliation is a manual `rfc822msgid:` lookup
  today and there is no one-click reconcile button. The outbox refuses the retry
  and says what to do instead.
- **`convex-test` does not reproduce OCC**, which is why `scripts/double-tap.ts`
  exists.
- **Google Testing-mode refresh tokens expire after 7 days**, and the app shows
  the unverified-app interstitial. Both are consequences of not going through
  Google verification.
- **Slack token rotation is off**, so that code path ships unexercised.
- **Gmail connection identity is the email address**, not `sub`. Immutable enough
  in practice and far more legible in a connections list, and the tradeoff is
  argued where it is acted on.
- **Fault injection has no toggle UI.** The slow-web-source demo is on by default
  and the failure injections are arguments to `searches.run`, `drafts.create` and
  `connections.simulateRevoke`. All of them are inert unless
  `ALLOW_FAULT_INJECTION=true`.
- **Results are capped at 20 per source**, which is also the single-mutation
  transaction budget that keeps a source's terminal state atomic.
