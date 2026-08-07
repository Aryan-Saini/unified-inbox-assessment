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

`/dashboard` and `/outbox` render one shell (`InboxApp`) with the pane switched, so
the sidebar, the dialogs and the toast deck exist once and cannot drift.

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

`app/(inbox)/` is presentation plus two hooks, `useSearch.ts` and
`useConnections.ts`. It holds no retry logic, no idempotency logic and no
provider knowledge. `convex/api/` is the REST shell, so it authenticates a bearer
key, resolves a `userId`, calls the same internal functions the UI calls, and
projects the row to public JSON.

The proof that the boundary is where I say it is: `docs/api-walkthrough.sh` drives
the whole product over `curl` with no browser open.

### The adapter contract

`convex/core/types.ts` is the entire surface between the merge layer and the
providers. `SearchAdapter` and `Result` are copied verbatim out of the spec and
not widened. The merge layer imports those two types and nothing else, so it has
no idea Gmail or Slack exist.

An adapter never sees the connection row and never sees a refresh token. It gets
an `AdapterContext`, which is an already-valid access token, the scopes the grant
actually holds so it can skip an optional call instead of spending a 403
discovering it, a result limit, and an `AbortSignal`. Token lifecycle is the
orchestrator's problem. That is what keeps an adapter small enough to be worth
writing.

Adapters do attach extra columns, `threadId`, `replyTo`, `unread`, `avatarUrl`,
`replyCount` and a few more, because the UI needs them, and those are stored as
real columns. The REST projection strips all of it, so the public `Result` stays
exactly the seven specified fields. The validator in `convex/api/views.ts` is
what enforces that, and Convex checks the returned object against it, so an
eighth field cannot leak into the API without that file changing and a test
going red.

### Search fan-out

```
searches.run (mutation)
  ├─ rate limit (10 fan-outs/min/user, since one search is up to 5 provider calls)
  ├─ insert searches row
  ├─ insert ONE searchSources row per enabled connection, plus one for web
  ├─ scheduler.runAfter(0, orchestrator.runSource) once per row   ← independent workers
  └─ scheduler.runAfter(25s, orchestrator.sweepSearch)            ← watchdog
```

The concurrency is structural, not cooperative. Two Gmail accounts, a Slack
workspace and web search are four separate Convex actions with four separate
isolates, transactions and failure domains. There is nothing shared for a slow
source to block on, and a source that crashes takes down its own row and nothing
else.

Each worker sets its row to `running` and bumps `attemptCount`, resolves a token,
calls the adapter under a 20 second `AbortSignal` through three attempts with
full jitter, and then commits results, terminal status, counts, duration and the
parent search's completion check in **one mutation**. That single-mutation rule is
why a subscriber never sees "succeeded with zero results" or half a batch
flickering past.

Partial results are one reactive query, `searches.watch`, returning
`{search, sources[], results[]}`. The UI appends in arrival order and never
re-sorts under the reader. Ordering comes from an explicit `seq` column because
`_creationTime` ties are not ordered. A write-time `score` exists in parallel and
REST exposes `?order=rank|arrival`, defaulting to rank.

Nothing spins forever. `sweepSearch` is scheduled at dispatch time and forces any
still-pending or still-running source to `failed`, classified `transient`, which
is the honest reading since the worker vanished and that says nothing about the
provider. A 5 minute cron backs it up for the case where the scheduled sweep
itself was lost to a deploy. Neither is load-bearing. If they were, the feature's
latency would be the cron's interval.

### Adding a source

The merge layer does not change. `orchestrator.ts`, ranking, REST, history and the
send gate reach providers only through `ADAPTERS[source]` and never name one, so a
new adapter inherits concurrent fan-out, partial results, retry with backoff,
error classification, the reconnect path and history for free.

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

Every one of those is an exhaustive `Record<Source, …>` or a union, so `tsc` fails
until each is filled in and the compiler hands you the list instead of leaving you
to grep for it. The last two are not plumbing at all, a display name and an icon
are new information nothing can derive for you.

`ALL_SOURCES` is derived from `Object.keys(ADAPTERS)` rather than written out
again. That used to be three hand-maintained `["gmail","slack","web"]` literals,
which was the one place a missing edit failed *silently*, so you got a registered
adapter that never ran with a green build. `convex/core/registry.test.ts` pins the
registry, the schema and `requiresGrant` to each other.

The honest caveat: a source needing OAuth also touches the `provider` union,
`oauth.ts` and the callback route in `http.ts`. That is a second grant type, not
adapter plumbing.

### The send gate

```
1. drafts.create        → a draft row + an idempotency key minted with it
2. drafts.reviewPayload → the EXACT payload + its digest  (the only source of the digest)
3. drafts.confirm       → takes that digest back, the server re-derives and compares
4. sends.send           → sends.claim: indexed unique read + insert, ONE mutation
                          → scheduler.runAfter(0, sends.deliver) in the same transaction
```

There is no function anywhere that takes a recipient and a body and sends them.
Not in Convex, not in REST. Composing writes a row, sending names a draft. The
shape of `convex/drafts.ts` *is* the friction, rather than a check bolted onto a
one-shot path.

The digest is derived three times, at review, at confirm, and again inside the
claim. The third one is what actually gates delivery and everything before it is
UI. The canonical payload includes a schema-version marker and the draft's
revision counter, and any edit bumps the revision and clears the confirmation.
That closes the edit A to B to A hole, so a digest captured before the edit cannot
authorise the new payload even if the text was put back byte for byte.

#### Why double-sending is impossible

`sends.claim` is one mutation on purpose. Convex mutations are serializable ACID
transactions under optimistic concurrency control, so this sequence is atomic with
respect to the key:

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

Two concurrent double-taps both read "no row" and both try to insert. One loses
the OCC check on the range it read, Convex retries it automatically, and on the
retry it sees the winner's row and returns it. Exactly one claimant, no locks, and
no unique-constraint support required from the database.

Three ways to get this wrong, all avoided on purpose:

1. **A `.filter()` or a table scan instead of an indexed range read.** Still
   correct, but the read set is the whole table, so every send conflicts with
   every other send and throughput collapses.
2. **Reading by `draftId` instead of by key.** No conflict at all when two drafts
   share a key, which is the exact case the guarantee is for.
3. **Splitting the read and the insert** across a query and a mutation, or doing
   the check inside an action. That puts back precisely the race it closes.

Two more properties fall out of the same mutation. The payload is copied onto the
claim rather than referenced, so the guard survives the draft being edited
afterwards. And delivery is scheduled *inside* the transaction, so there is no
window where a job is pending for a claim that does not exist. The same key with a
different payload is refused with `409 IDEMPOTENCY_KEY_REUSED` rather than
silently delivering either version.

> Neither Gmail nor Slack offers server-side idempotency on send, so there is no
> provider-side safety net underneath this and the claim row is the whole
> guarantee. Gmail sends do carry a deterministic `Message-ID` and an
> `X-Unified-Inbox-Key` header derived from the idempotency key, but those exist
> so an indeterminate outcome can be reconciled later *by reading*, via an
> `rfc822msgid:` search. They are not deduplication.

#### Failure taxonomy

Every attempt is bracketed by two mutations, `beginAttempt` before the provider
call and `finishAttempt` or `failAttempt` after, so the timeline survives a worker
dying mid-flight and `in_flight` acts as a lease that makes mashing retry a no-op.
`beginAttempt` refuses four ways, and each refusal is a provider call that did not
happen: already `succeeded`, someone is `in_flight`, the outcome is `unknown`, or
the auto-retry budget is `exhausted`.

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

### Scheduled backstops

Everything in `convex/crons.ts` is a backstop rather than a mechanism:

| Cron | Interval | Why |
| --- | --- | --- |
| `sweep stuck searches` | 5 min | Catches only what a per-search watchdog missed, such as a deploy mid-fan-out. |
| `sweep stale in-flight sends` | 1 min | `in_flight` blocks all further attempts, so an abandoned one is both unretryable and unexplained. Resolves to `unknown`, never `failed_transient`. |
| `collect expired oauth states` | 1 hour | Consumed rows are kept a full TTL past expiry, so a replay is answered "replayed" rather than "unknown" while it still can be. |

Both sweepers skip seeded rows. A seeded `in_flight` send is a frozen illustration
of that state, and sweeping it would quietly delete the example a reviewer came to
see.

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

**`begin` is an authenticated Convex mutation, not an HTTP route.** The browser
already holds a Convex session, so the flow starts with identity proven and no
token ever rides in a URL where it would land in logs, referrers and history. What
rides in the URL is an opaque single-use `state` that means nothing on its own.

**The callback is a Convex `httpAction`.** A Convex deployment has a stable public
URL, so real OAuth works while the frontend is still only on `localhost`, with no
tunnel and no public deploy. The redirect URI is derived from `CONVEX_SITE_URL`
rather than configured, because Google and Slack both want a byte-exact match and
a hand-set env var is exactly the thing that drifts between deployments and fails
with `redirect_uri_mismatch` at the worst moment.

**`state` is consumed in one transaction**, and the provider is passed as an
argument that has to match the stored row. Reading the provider *off* the row
would let a state minted for Slack be redeemed at the Google callback. `returnTo`
is reduced to a plain same-origin path, so `//evil.test` and backslashes get
dropped rather than repaired, and that is what stops it being an open redirect.

**Which origin the callback returns to.** A deployment cannot know the frontend's
origin, since `next dev` picks whatever port it wants and one deployment
legitimately serves both a local browser and a deployed one. So the browser
proposes its own origin and the backend checks it instead of trusting it, because
this is a redirect and an unchecked origin here is a plain open redirect.

| Proposed origin | Allowed? | Why |
|---|---|---|
| `http://localhost:3001`, `http://127.0.0.1:5173`, `http://[::1]:3000` | yes, any port | Loopback names the visitor's own machine and nobody else's, so there is nobody to redirect them *to*. This is what makes the dev port stop mattering. |
| `https://10.0.0.124:3000`, `http://192.168.1.5:5173`, `https://my-mac.local:3000` | only when `ALLOW_PRIVATE_NETWORK_ORIGINS="true"` | A phone on the same Wi-Fi. See below. |
| Anything in `APP_BASE_URL` or `APP_ORIGIN_ALLOWLIST` | yes | A deployed frontend, registered once. Compared by origin, so a trailing slash is not a different site. |
| Anything else, or not a parseable `http(s)` URL | no | Falls back to `APP_BASE_URL`. |

The resolved origin is stored on the `oauthStates` row, so it is fixed when the
flow starts and nothing arriving at the callback later can influence it.
`resolveAppOrigin` is unit-tested against every row of that table in
`convex/oauth.test.ts`, including lookalike hosts like `localhost.evil.test` that
a substring check would wave through.

**Connecting an account from a phone.** `pnpm dev:lan` serves the app on this
machine's LAN address so a phone can reach it. That origin is not loopback, so
before this existed the callback fell back to `APP_BASE_URL`, which is
`http://localhost:3000`, and *on a phone* that is the phone. The flow completed
and the browser landed on nothing.

Registering the address is the obvious fix and the wrong one, since DHCP
reassigns it and a different network hands out a different one, so the
registration is stale exactly when you next need it. Instead `resolveAppOrigin`
accepts any private-network host on any port, so `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, IPv4 and IPv6 link-local, and `*.local`.

That is a real widening, so it is off unless `ALLOW_PRIVATE_NETWORK_ORIGINS` is
`"true"`, and `pnpm dev:lan` sets that on the **dev** deployment only, which ties
"the LAN may be returned to" to "I am deliberately serving the LAN". The hand-in
deployment leaves it unset and keeps the strict loopback-plus-allowlist rule. The
set it opens is "a machine on the LAN the visitor is already on" rather than
"anywhere", which is the same argument that lets loopback through, one hop wider,
and the redirect carries no secret anyway, just `connected` and `account`, or
`oauth_error`. Tokens are exchanged and encrypted inside the callback, before it.
Ranges are matched on the hostname `URL` parsed, so `10.0.0.124.evil.test` is a
DNS name and gets refused.

**Identity-preserving reconnect.** The upsert key is
`(userId, provider, externalAccountId)`, so re-granting an existing account
patches the same `connections` row and keeps its `_id`. Every draft, send and
result pointing at that connection stays valid, since reconnecting is not a new
account. Reconnecting *as a different account* is rejected explicitly with "add it
as another account instead" rather than silently rebinding the row. Gmail's
identity is the email address, which is a documented tradeoff against the strictly
immutable `sub` and argued in `convex/http.ts`. Slack's is `T…:U…`, because the
same person in two workspaces is two connections.

**Tokens at rest** are AES-256-GCM via Web Crypto, in a versioned AEAD envelope
whose additional authenticated data is `v1|provider|connectionId|tokenType`. GCM
rather than CBC because it is authenticated, so a tampered ciphertext fails to
decrypt instead of yielding garbage we would then hand to Google as a bearer
token. Binding the AAD to the connection id and token type means a ciphertext
cannot be swapped between rows or between the access and refresh slots. A
`connections` table dump on its own grants nobody anything without
`TOKEN_ENCRYPTION_KEY`, which only exists in the deployment environment.

**Refresh on use, with a single-flight lease.** There is no refresh cron. A token
is refreshed at the moment something needs it, inside `resolveToken`, which is the
only door to a credential in the whole codebase. A fan-out across two Gmail
accounts plus a concurrent send can hit one connection three times in the same
second, and without a lease that is three parallel refreshes, which is wasteful
with a static refresh token and outright data loss with a rotating one, because
the losers would store tokens the provider already invalidated. So
`refreshLockedUntil` is claimed in a mutation and the winner refreshes, losers do
a bounded re-read of 250ms times 3 and then surface `transient`, and a 120 second
skew window means a token about to expire is refreshed before use rather than
after a 401. `invalid_grant` and `token_revoked` flip the connection to `revoked`,
store the verbatim provider reason, and surface `needs_reconnect` in the UI.

Slack token rotation is deliberately left off on the app. With rotation disabled a
user token does not expire, so there is no refresh to get wrong. The refresh
branch is written and exported so enabling rotation later is a Slack console
change rather than new code, but nothing calls it today.

### Auth, briefly

Clerk gates the browser in three layers, and each one exists because the layer
outside it cannot cover the case. `proxy.ts` (Next.js 16's middleware, renamed)
redirects on the Clerk session cookie before a route renders. `AuthGate` and
`GuestGate` hold the page on a splash through the async window the server cannot
see, which is Clerk resolving its session in the browser and then Convex trading
it for its own token, and `AuthGate` also issues the user row straight out of the
JWT so a brand-new user whose webhook is late still gets one. `useAuthedQuery`
holds every query at `"skip"` until Convex reports an authenticated identity.

None of that is the authorization boundary. Every Convex function resolves its own
owner through `requireUser`, so a route that slipped through all three still
cannot read another user's row.

**Only Clerk sends anyone back to `/auth`**, and that rule is load-bearing. Clerk
is the only thing `proxy.ts` can see, so redirecting because *Convex* rejected the
session would bounce off a proxy that still sees a valid Clerk cookie and loop
between the two forever. Clerk can also disagree with itself, since the proxy only
verifies the session token while clerk-js sees a session revoked in the dashboard
or ended in another tab seconds earlier, so a client-driven bounce carries
`?signed_out=1` (`app/authParams.ts`) and the proxy takes the client's word for
that one request. `useHardRedirect` strips the param from anything it carries
onward, so it never outlives the bounce.

Only the two states nobody can resolve by waiting reach `AuthTrouble`: clerk-js
never started (`unreachable`, which is what a non-secure origin looks like), and
Convex settled on "not authenticated" after Clerk confirmed a session
(`rejected`, so an `aud` claim or a `CLERK_JWT_ISSUER_DOMAIN` pointing at the
other deployment). Everything else is a load, including a failing `users.store`,
which retries on a capped backoff rather than showing a panel. Sign-out has to
live *inside* the shell, in the sidebar footer, because `/auth` is closed to a
signed-in visitor, and `AuthTrouble` carries its own copy since it renders instead
of the shell.

One Next.js 16 detail worth knowing before changing a redirect here: `/auth` and
`/dashboard` sit in route groups with separate root layouts, which the App Router
only crosses with a full page load. `router.replace` between them leaves the
browser on the old route, so both gates go through `useHardRedirect`
(`window.location.replace`). That also re-runs `proxy.ts` on the way in, so the
server and the client can never disagree about where you belong.

A Clerk webhook at `https://<deployment>.convex.site/clerk-webhook` keeps `users`
correct between sessions, since `ctx.auth.getUserIdentity()` only fires while
someone is using the app and never hears about a profile edit or a deletion. It is
served by Convex rather than Next.js for the same reason the OAuth callbacks are,
a stable public URL in development. It verifies every request with Svix before
reading it, because an unverified body is an unauthenticated write to `users`. It
shares one idempotent upsert between `user.created` and `user.updated`, since Svix
retries on any non-2xx and can deliver out of order, picks the *primary* email
rather than the first, answers unknown event types with 200, and returns 400 on a
bad signature but 500 on a missing secret — 400 stops Svix retrying something that
can never verify, 500 makes it retry a misconfiguration a human can still fix.
`user.deleted` cascades into deleting connections and their tokens, so the token
vault never outlives the account.

Disconnecting is a soft delete, so the row stays and the status becomes `revoked`,
which keeps `drafts.connectionId` and every historical send valid.

---

## Local setup

Needs Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env.local     # then fill in the Clerk values
npx convex dev                 # provisions the deployment, writes CONVEX_* into .env.local
pnpm dev                       # in a second terminal
```

`npx convex dev` has to stay running in development, it pushes `convex/` on save.

Two separate places hold config and mixing them up is the usual cause of a
confusing failure. `.env.local` is read by **Next.js only**. Everything the
backend needs is set on the **Convex deployment** with `npx convex env set`.

### Opening it on a phone

```bash
pnpm dev:lan                   # instead of pnpm dev
```

`pnpm dev` over the LAN, on `http://192.168.x.x:3000`, cannot sign anyone in. That
origin is not a secure context, so the browser withholds `crypto.subtle` and
`crypto.randomUUID`, and clerk-js stops before its first Frontend API call without
throwing. The only symptom is a splash that never resolves, and `localhost` is
exempt, which is why it only shows up on a second device. The gates now give up
after six seconds and say so rather than spinning.

`dev:lan` resolves this machine's LAN address, generates one mkcert certificate
covering it *and* `localhost`, and serves HTTPS on every interface, so
`https://localhost:3000` still works for desktop while the phone gets a secure
origin. It prints the address to open, and that first visit warns about the
certificate, which accepting is enough for. It also sets
`ALLOW_PRIVATE_NETWORK_ORIGINS` on the **dev** deployment so an OAuth callback can
return to the phone. `allowedDevOrigins` in [`next.config.ts`](next.config.ts) is
detected the same way, without which the phone's `/_next/*` requests come back 403.

The t3 **Dev** script runs `dev:lan`. Plain `pnpm dev` is unchanged, for Codespaces
and for working without a certificate.

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

Two Clerk and Next.js details that differ from most tutorials: Next.js 16 names
the middleware file `proxy.ts` (same API, new name), and `@clerk/nextjs` v7
removed `<SignedIn>` / `<SignedOut>` / `<Protect>` in favour of a single `<Show>`,
with `ClerkProvider` going *inside* `<body>`.

---

## GitHub Codespaces

[`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) gives a Node
20 image with pnpm via corepack, runs `pnpm install` on create, and forwards port
3000.

Open in a Codespace, then:

```bash
cp .env.example .env.local        # paste your Clerk keys
npx convex dev                    # links a deployment, writes CONVEX_* into .env.local
npx convex env set TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
npx convex env set APP_BASE_URL "https://$CODESPACE_NAME-3000.app.github.dev"
npx convex env set ALLOW_FAULT_INJECTION true
pnpm dev                          # second terminal, open the forwarded port 3000
```

After Convex and Clerk, no third-party signup is needed to see the whole product.
Web search runs on the labelled deterministic mock so the fan-out has three real
sources with no API key, the demo data button fills history with every status,
`docs/api-walkthrough.sh` exercises the REST surface end to end, and `pnpm test`
needs nothing external at all.

Gmail and Slack still need their own OAuth apps, and their redirect URIs point at
`convex.site` rather than at the Codespace, so they work from a Codespace
unchanged. A Codespace origin is not loopback though, so it has to be registered
as `APP_BASE_URL` or added to `APP_ORIGIN_ALLOWLIST` for the callback to return
you to it.

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

`contacts.readonly` buys exactly one thing, the sender's profile photo on a result
row, because Gmail's search API returns no avatar anywhere in a message. It is the
narrowest scope Google offers that returns a contact photo at all, and it is
read-only. Everything depending on it degrades instead of failing, so
`contactPhotos` in `convex/adapters/gmail.ts` swallows its own errors and a grant
issued without the scope keeps searching, with the row falling back to the
sender's domain favicon and then to their initial on a colour derived from their
address.

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

**Tavily.** It has a genuinely free tier at 1,000 searches a month, needs no
credit card, and returns title, url and content in one POST, which is all the
third source has to produce. Brave Search is a drop-in alternative behind the same
interface.

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
up string-matching, and then our error text becomes their API contract. `OPTIONS`
and permissive CORS are supported, since the credential is a header and never a
cookie, so `*` grants nothing except the ability to try.

### The confirm friction exists in the API too

Criterion 4 is not a UI feature. `POST /drafts/{id}/send` requires
`acknowledged_destination` and it has to repeat the draft's recipient verbatim, so
a mismatch is a 409. Combined with the `reviewed_hash` on confirm that is three
round trips minimum, and there is no endpoint anywhere that accepts a recipient
and a body and delivers them.

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

It is a documentation *site*, not one long page: a guide, an endpoint reference and
an appendix, each a page of its own, with a section switcher and tree on the left, a
contents rail on the right, and previous/next at the foot of every page.
`app/(docs)/documentation/pages.ts` is the arrangement — the routing, the
navigation, the rails and the per-page metadata all read from it, so a sidebar link
cannot point at a page that does not exist. The pages themselves are still composed
out of `spec.ts` and `guide.ts`, which is why splitting them changed no content.

The same content is served in four other shapes from one source
(`app/(docs)/documentation/spec.ts` and `guide.ts`), so none of them can drift from
the site or from each other:

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

# 4. Read it back. review_hash comes only from reading the payload.
curl -sS -H "Authorization: Bearer $KEY" "$API/drafts/$DRAFT_ID"

# 5. Confirm with that hash.
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

153 tests on `convex-test` under `@edge-runtime/vm`, against a fake-provider
`fetch` router that also records every call, so "how many times did we hit the
provider" is an assertion rather than an inference. What they prove, in rough
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

`convex-test` runs mutations against an in-memory implementation. It does **not**
reproduce Convex's real optimistic-concurrency retry, so the concurrent-claim test
demonstrates that the *logic* is a single-transaction indexed read-then-insert. It
cannot, on its own, prove the OCC behaviour that makes that logic safe under real
contention.

So the guarantee is also verified against a deployed deployment:

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
`vercel.json` sets `git.deploymentEnabled: false`, so the build is made locally and
uploaded. `main` is the production branch.

```bash
pnpm deploy:vercel   # pull, vercel build --prod, vercel deploy --prebuilt --prod
```

[`scripts/deploy-vercel.mjs`](scripts/deploy-vercel.mjs) pulls the production
environment first, because `NEXT_PUBLIC_*` values are inlined into the bundle at
build time and the building machine is now this one. Without it the build falls
back to `.env.local` and the deployment quietly talks to the *dev* Convex
deployment. The three public values are stored **plain** on the project so the
pull actually returns them — a sensitive variable comes back empty — while
`CLERK_SECRET_KEY` and the rest stay sensitive and are read at runtime by the
server. The script refuses to build if any of the three pulls empty.

A push should be free — `staging` gets pushed often and mid-change, and none of
those pushes are a deliverable. This also means the build a reviewer opens is one
somebody watched succeed.

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
| 0. preflight | the smoke credentials exist — checked *before* anything ships |
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
integration — `convex deploy --cmd '<build>'` — which pushes `convex/` and then
runs the build with that deployment's URL in the environment. The backend and the
frontend that calls it go out together, so stage 1 folds into stage 2 and is
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

Not on Vercel, and not because it is awkward there. The build runs on this
machine, and a *sensitive* Vercel variable is never handed back by `vercel pull`
— it arrives as an empty string, which is the same trap the three public
variables document. Storing it `plain` instead would put a credential that can
deploy code in a dashboard, to serve a remote builder this project does not use.
Vercel needs no deploy key at runtime.

The build step under `convex deploy --cmd` is
[`scripts/vercel-build.mjs`](scripts/vercel-build.mjs) rather than `pnpm build`,
because the upload is `--prebuilt` and needs Vercel's output directory. It also
refuses to build when the URL Convex just deployed to and the one pulled from the
Vercel project disagree — that means the deploy key and the project point at
different Convex deployments, and Vercel's value is the one that gets inlined.

`dev:handin` sets the Convex URLs inline rather than through a `.env.handin` file
on purpose. Next.js only auto-loads `.env.$(NODE_ENV)`, and `NODE_ENV` accepts
nothing but `production`, `development` and `test`, so a `.env.handin` would
silently never load. Inline `process.env` sits at the top of Next's lookup order,
so it wins over `.env.local`.

### Before submitting

Two things that only bite on the deployed URL, so local work never catches them.

1. **Register the deployed frontend origin on the hand-in deployment.** A browser
   on the deployed URL is not loopback, so the OAuth callback will not return to it
   until its origin is named. Otherwise a reviewer finishing a connect flow is
   redirected to `APP_BASE_URL`, which is currently `http://localhost:3000`, so
   *their own* machine.

   ```bash
   npx convex env set APP_BASE_URL "https://<deployed-origin>" --prod
   # or, to keep APP_BASE_URL as-is and add to the allowlist:
   npx convex env set APP_ORIGIN_ALLOWLIST "https://<deployed-origin>" --prod
   ```

2. **Turn on Slack public distribution.** Until it is on, the Slack app can only be
   installed into the workspace that created it, and any reviewer authorizing from
   their own workspace gets `invalid_team_for_non_distributed_app` before the
   consent screen even renders. api.slack.com/apps, then the app, then Manage
   Distribution, tick the hard-coded-information review box, Activate Public
   Distribution. Both deployments' callback URLs are already registered under OAuth
   & Permissions, which is the other checklist item.

---

## Screenshots

In [`docs/screenshots/`](docs/screenshots). These were captured during the UI-first
phase against the mock harness the components were built on, which is why several
still carry a "MOCK" badge. The components themselves are unchanged and are now
driven by live Convex subscriptions, so the layouts are current even where those
badges are not. Two are now in a different place: a successful send is a toast
rather than a receipt dialog, and the delivered row, with its attempt log, delivery
count and the "retry with the same key" button that proves the count stays at one,
lives on the `/outbox` card.

| | |
| --- | --- |
| [The lift — idle to results](docs/screenshots/01-hero.png) | [Partial results streaming in](docs/screenshots/02-streaming-partial.png) |
| [Settled, merged, per-source status](docs/screenshots/03-results-settled.png) | [Compose → review, not send](docs/screenshots/04-compose-draft.png) |
| [The review payload and its key](docs/screenshots/05-compose-review.png) | [Delivered, with the attempt log](docs/screenshots/06-send-delivered.png) |
| [Retry with the same key — deliveries stay at 1](docs/screenshots/07-send-deduped.png) | [Connections](docs/screenshots/08-settings-connections.png) |
| [The demo-data panel](docs/screenshots/09-settings-demo.png) | [A revoked grant as its own state](docs/screenshots/10-needs-reconnect.png) |
| [Sidebar collapsed](docs/screenshots/11-sidebar-collapsed.png) | [Archive with undo](docs/screenshots/12-archive-toast.png) |
| [Mobile results](docs/screenshots/13-mobile-results.png) | [Mobile navigation sheet](docs/screenshots/14-mobile-drawer.png) |

Keyboard: `⌘K` focuses the search field, `⌘\` collapses the sidebar, `Esc`
dismisses a dialog or the mobile nav sheet.

### The stress harness

Layout regressions are found and re-captured with a development-only route,
`/ui-stress?scene=…`, which renders the surfaces that carry an arbitrarily long
string, so the result row, the reply dialog and the remove-account confirm, against
the same awkward fixtures `convex/seed.ts` loads. It has no Clerk provider and no
live Convex client, so it renders identically on a machine with no deployment and
no session, and two captures across a change differ only where the code did.

```bash
pnpm exec playwright install chromium          # once
node scripts/screenshots/capture.mjs /tmp/after   # phone + desktop PNGs
node scripts/screenshots/overflow.mjs             # names what is cut off, exits 1 if any
```

`overflow.mjs` is the useful half. A screenshot shows *that* something bled, while
it says which element ran past which box and by how many pixels, and it knows the
difference between a deliberate `truncate` ellipsis and a string that was simply
cut off. Before/after pairs live in
[`docs/screenshots/before-after/`](docs/screenshots/before-after).

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
