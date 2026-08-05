# Unified Inbox

Search Gmail, Slack and the web from one place, and send replies only after an
explicit confirmation step.

The interesting part is not the search. It is that **the same message cannot be
sent twice**, that a slow provider cannot hold up a fast one, and that every
failure is classified before anything decides whether to retry it. Those three
properties are what the code is shaped around, and this README says where each of
them lives.

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Next.js 16 (App Router, Turbopack) + Tailwind |
| Backend  | Convex (TypeScript functions, scheduler, cron)|
| Database | Convex                                        |
| Auth     | Clerk (users) + `uik_…` API keys (REST)       |
| Web search | Tavily, with a labelled deterministic mock fallback |

| Route        | What it is                                                        |
| ------------ | ----------------------------------------------------------------- |
| `/dashboard` | The unified inbox: search, compose, connections, outbox. Signed-in only |
| `/auth`      | Sign in / sign up, one email-code flow. Signed-out only           |
| `/`          | Redirects to whichever of the two you belong on                   |

Each lives in its own route group with its own root layout
(`app/(inbox)/layout.tsx`, `app/(auth)/layout.tsx`). The gate is two layers:
`proxy.ts` redirects on the Clerk session before anything renders, and
`app/AuthGate.tsx` / `app/GuestGate.tsx` hold the page on a loading splash
through the window the server cannot see — Clerk resolving its session in the
browser, then Convex trading it for its own token. See
[Auth gating](#auth-gating).

---

## Contents

- [Architecture](#architecture)
- [Local setup](#local-setup)
- [OAuth setup](#oauth-setup)
- [Web search](#web-search)
- [Demo data and fault injection](#demo-data-and-fault-injection)
- [REST API](#rest-api)
- [Tests](#tests)
- [GitHub Codespaces](#github-codespaces)
- [Deployments](#deployments)
- [Screenshots](#screenshots)
- [Known limits](#known-limits)

---

## Architecture

### The module boundary

Everything that talks to a provider, and everything that decides whether a
message may be delivered, lives in `convex/`. That is the standalone module. It
has **two thin consumers** and neither of them holds any policy:

```
                 ┌───────────────────────────────────────────────┐
                 │  convex/  — adapters, fan-out, send gate      │
  Next.js UI ───▶│                                               │
  (Clerk JWT)    │  oauth.ts        connections.ts   crypto      │
                 │  searches.ts     orchestrator.ts  registry    │
  curl / REST ──▶│  drafts.ts       sends.ts         crons       │
  (uik_ API key) │  adapters/{gmail,slack,web}.ts                │
                 └───────────────────────────────────────────────┘
```

- `app/(inbox)/` is presentation plus two hooks (`useSearch.ts`,
  `useConnections.ts`). It contains no retry logic, no idempotency logic and no
  provider knowledge.
- `convex/api/` is the REST shell: authenticate a bearer key, resolve a `userId`,
  call the same internal functions the UI calls, project the row to public JSON.
- `docs/api-walkthrough.sh` drives the entire product over `curl` with no browser
  open, which is the proof that the module is not entangled with the UI.

Adding a fourth source is one file in `convex/adapters/` and one line in
`convex/core/registry.ts`.

### OAuth: begin as a mutation, callback on `convex.site`

```
browser ──▶ api.oauth.begin({provider, reconnectConnectionId?, returnTo})  [authenticated mutation]
                └─ inserts oauthStates {state, PKCE verifier, provider, expiry}
                └─ returns the provider authorize URL
browser ──▶ accounts.google.com / slack.com   (consent)
provider ─▶ https://<deployment>.convex.site/oauth/{google,slack}/callback  [httpAction]
                └─ consumeState()  single-use, expiring, provider-bound, one transaction
                └─ exchange code (PKCE for Google) → fetch identity → encrypt → upsert
                └─ 302 to APP_BASE_URL + sanitized returnTo
```

Four decisions worth naming:

- **`begin` is an authenticated Convex mutation, not an HTTP route.** The browser
  already holds a Convex session, so the flow starts with identity proven and no
  token ever rides in a URL where it would land in logs, referrers and history.
  What rides in the URL is an opaque single-use `state` that means nothing alone.
- **The callback is a Convex `httpAction`.** A Convex deployment has a stable
  public URL, so real OAuth works while the frontend is still only on
  `localhost` — no tunnel, no public deploy.
- **`state` is consumed in one transaction**, and the provider is passed as an
  argument that must match the stored row. Reading the provider *off* the row
  would let a state minted for Slack be redeemed at the Google callback.
  `returnTo` is reduced to a plain same-origin path (`//evil.test` and
  backslashes are dropped, not repaired), which is what stops it being an open
  redirect.
- **The redirect URI is derived from `CONVEX_SITE_URL`**, not configured. Google
  and Slack both require a byte-exact match, and a hand-set env var is exactly
  the thing that drifts between deployments and fails with
  `redirect_uri_mismatch` at the worst moment.

**Identity-preserving reconnect.** The upsert key is
`(userId, provider, externalAccountId)`, so re-granting an existing account
patches the same `connections` row and keeps its `_id`. Every draft, send and
result pointing at that connection stays valid — reconnecting is not a new
account. Reconnecting *as a different account* is rejected explicitly ("add it as
another account instead") rather than silently rebinding the row. Gmail's identity
is the email address (a documented tradeoff against the strictly-immutable `sub`,
argued in `convex/http.ts`); Slack's is `T…:U…`, because the same person in two
workspaces is two connections.

### Tokens at rest

AES-256-GCM via Web Crypto, in a **versioned AEAD envelope** whose additional
authenticated data is `v1|provider|connectionId|tokenType`. GCM rather than CBC
because it is authenticated: a tampered ciphertext fails to decrypt instead of
yielding garbage we would then hand to Google as a bearer token. Binding the AAD
to the connection id and token type means a ciphertext cannot be swapped between
rows or between the access and refresh slots — a `connections` table dump on its
own grants nobody anything without `TOKEN_ENCRYPTION_KEY`, which lives only in the
deployment environment.

**Refresh-on-use with a single-flight lease.** There is no refresh cron. A token
is refreshed at the moment something needs it, inside `resolveToken`, which is the
only door to a credential in the whole codebase. A fan-out across two Gmail
accounts plus a concurrent send can hit one connection three times in the same
second; without a lease that is three parallel refreshes — wasteful with a static
refresh token and outright data loss with a rotating one, because the losers would
store tokens the provider has already invalidated. So:

- `refreshLockedUntil` is claimed in a mutation. The winner refreshes.
- Losers do a bounded re-read (250 ms × 3) and then surface `transient`.
- A 120 s skew window means a token about to expire is refreshed before use
  rather than after a 401.
- `invalid_grant` / `token_revoked` → connection `revoked`, the verbatim provider
  reason stored, `needs_reconnect` surfaced in the UI.

Slack token rotation is deliberately left **off** on the app: with rotation
disabled a user token does not expire, so there is no refresh to get wrong. The
refresh branch is written and exported so enabling rotation later is a Slack
console change rather than new code — but nothing calls it today.

### Search fan-out

```
searches.run (mutation)
  ├─ rate limit (10 fan-outs/min/user — one search is up to 5 provider calls)
  ├─ insert searches row
  ├─ insert ONE searchSources row per enabled connection, plus one for web
  ├─ scheduler.runAfter(0, orchestrator.runSource) once per row   ← independent workers
  └─ scheduler.runAfter(25s, orchestrator.sweepSearch)            ← watchdog
```

The concurrency is **structural, not cooperative**. Two Gmail accounts, a Slack
workspace and web search are four separate Convex actions with four separate
isolates, transactions and failure domains. A slow source cannot block a fast one
because there is nothing shared to block on, and a source that crashes takes down
its own row and nothing else.

Each worker: `beginSourceRun` (status `running`, `attemptCount++`) →
`resolveToken` → adapter call under a 20 s `AbortSignal` through `retryTransient`
(3 attempts, full jitter, every attempt recorded) → **one mutation** that commits
results, the terminal status, counts, duration *and* the parent search's
completion check together. That single-mutation rule is why a subscriber never
sees "succeeded with zero results" or half a batch flicker past.

**Partial results** are one reactive query, `searches.watch`, returning
`{search, sources[], results[]}`. The UI appends in arrival order and never
re-sorts under the reader — ordering comes from an explicit `seq` column, because
`_creationTime` ties are not ordered. A write-time `score` exists in parallel, and
REST exposes `?order=rank|arrival` (default `rank`).

**Nothing can spin forever.** `sweepSearch` is scheduled at dispatch time and
forces every still-`pending`/`running` source to `failed`, classified `transient`
— the honest reading, since the worker vanished and that says nothing about the
provider. A 5-minute cron backs it up for the case where the scheduled sweep
itself was lost to a deploy. Neither is load-bearing; if they were, the feature's
latency would be the cron's interval.

Adapters may attach enrichment (`externalId`, `threadId`, `replyTo`, `context`,
`unread`) and it is stored as real columns for the UI — then **stripped by the
REST projection**, so the public `Result` stays exactly the specification's seven
fields. The validator in `convex/api/views.ts` *is* that contract: Convex checks
the returned object against it, so an eighth column cannot leak into the API
without that file changing and a test failing.

### The send gate

This is the part that matters most, so it is the part with the most structure.

```
1. drafts.create        → a draft row + an idempotency key minted with it
2. drafts.reviewPayload → the EXACT payload + its digest  (the only source of the digest)
3. drafts.confirm       → takes that digest back; the server re-derives and compares
4. sends.send           → sends.claim: indexed unique read + insert, ONE mutation
                          → scheduler.runAfter(0, sends.deliver) in the same transaction
```

**There is no function anywhere that takes a recipient and a body and sends
them.** Not in Convex, not in REST. Composing writes a row; sending names a
draft. The shape of `convex/drafts.ts` *is* the friction, rather than a check
bolted onto a one-shot path.

The digest is derived three times — at review, at confirm, and again inside the
claim. The third one is what actually gates delivery; everything before it is UI.
The canonical payload includes a schema-version marker **and the draft's revision
counter**, and any edit bumps the revision and clears the confirmation. That closes
the edit-A→B→A hole: a digest captured before the edit cannot authorise the new
payload even if the text was put back byte for byte.

#### Why double-sending is impossible

`sends.claim` is one mutation on purpose. Convex mutations are serializable ACID
transactions under optimistic concurrency control, so this sequence is atomic
*with respect to the key*:

```ts
const existing = await ctx.db
  .query("sends")
  .withIndex("by_user_idempotency_key", (q) =>
    q.eq("userId", userId).eq("idempotencyKey", draft.idempotencyKey))
  .unique();                                            // indexed range read
if (existing !== null) return existing;                 // …the receipt, unchanged
const sendId = await ctx.db.insert("sends", { … });      // insert into that same range
await ctx.scheduler.runAfter(0, internal.sends.deliver, { sendId });
```

Two concurrent double-taps both read "no row" and both try to insert. One loses
the OCC check on the range it read, Convex retries it automatically, and on the
retry it sees the winner's row and returns it. **Exactly one claimant, no locks,
no unique-constraint support required from the database.**

Three ways to get this wrong, all avoided deliberately:

1. **A `.filter()` or table scan instead of an indexed range read.** Still
   correct, but its read set is the whole table, so every send conflicts with
   every other send and throughput collapses.
2. **Reading by `draftId` instead of by key.** No conflict at all when two drafts
   share a key — the exact case the guarantee is *for*.
3. **Splitting the read and the insert** across a query and a mutation, or doing
   the check in an action. That reintroduces precisely the race it closes.

Two more properties fall out of the same mutation. The payload is **copied, not
referenced**, so the guard survives the draft being edited afterwards; and the
delivery is scheduled *inside* the transaction, so there is no window where a job
is pending for a claim that does not exist. The same key with a different payload
is refused (`409 IDEMPOTENCY_KEY_REUSED`) rather than silently delivering either
version.

> **Neither Gmail nor Slack offers server-side idempotency on send.** There is no
> provider-side safety net underneath this — the claim row *is* the guarantee.
> Gmail sends do carry a deterministic `Message-ID` and an `X-Unified-Inbox-Key`
> header derived from the idempotency key, but those exist so an indeterminate
> outcome can later be *reconciled by reading* (`rfc822msgid:` search). They are
> not deduplication.

#### The delivery loop and the failure taxonomy

Every attempt is bracketed by two mutations — `beginAttempt` before the provider
call, `finishAttempt`/`failAttempt` after — so the timeline survives a worker
dying mid-flight, and so `in_flight` acts as a lease that makes mashing "retry" a
no-op. `beginAttempt` refuses four ways, and each refusal is a provider call that
did not happen:

| Refusal | Meaning |
| --- | --- |
| `succeeded` | Already delivered. The receipt is the answer. |
| `in_flight` | Someone is mid-attempt; a retry must not race them. |
| `unknown` | Indeterminate — retrying could double-send. |
| `exhausted` | The auto-retry budget is spent; a human decides from here. |

Failures are classified where the provider response is parsed, stored as-is, and
the retry logic acts on the same verdict an operator later reads:

| Kind | What it means | What happens |
| --- | --- | --- |
| `transient` | 429, 5xx, network, Slack `ratelimited` | Full-jitter backoff, up to 4 attempts; then left `failed_transient` with no scheduled retry so an operator can still act. Never relabelled "permanent" — that would be a lie about what the provider said. |
| `permanent` | 400, rejected recipient, `channel_not_found` | One attempt. No retry can help. |
| `needs_reconnect` | `invalid_grant`, 401, `token_revoked`, `missing_scope` | The connection is flipped to `revoked` with the verbatim reason, and **the draft stays `confirmed`** — so reconnect-then-retry reuses the same key and still cannot send twice. |
| `unknown` | Dispatched, then silence: a timeout after the bytes were on the wire, or a swept abandoned `in_flight` | **Terminal for the key.** Never auto-retried, and a manual retry is *refused*. |

That last row is the whole point. `toAdapterError` correctly calls a timeout
`transient` for a *read*; `classifySendFailure` reclassifies it to `unknown` once
the send was actually dispatched. That single reclassification is the difference
between a retry loop that is safe and one that occasionally sends two emails.

**Recovery from `unknown`** is therefore reconcile-or-clone, never retry:

- **Reconcile (reads only).** The Gmail `Message-ID` is derived from the
  idempotency key, so `rfc822msgid:` answers "did this exact claim already go
  out?" without sending anything.
- **Clone with a new key.** Compose again; the new draft mints a new key, so the
  new claim is a genuinely new message and the old one stays on the record.

Errors are stored **redacted** (no tokens, no auth headers, capped bodies) but
otherwise in full, and shown in full in the outbox — the provider's own words, the
HTTP status, and every attempt's timestamps.

### Scheduled backstops

Everything in `convex/crons.ts` is a backstop, not a mechanism:

| Cron | Interval | Why |
| --- | --- | --- |
| `sweep stuck searches` | 5 min | Catches only what a per-search watchdog missed (a deploy mid-fan-out). |
| `sweep stale in-flight sends` | 1 min | `in_flight` blocks all further attempts, so an abandoned one is both unretryable and unexplained. Resolves to `unknown`, never `failed_transient`. |
| `collect expired oauth states` | 1 hour | Consumed rows are kept a full TTL past expiry, so a replay is answered "replayed" rather than "unknown" while it still can be. |

Seeded rows are skipped by both sweepers: a seeded `in_flight` send is a frozen
illustration of that state, and sweeping it would quietly delete the example a
reviewer came to see.

### Lifecycle

Disconnecting is a **soft delete** — the row stays, the status becomes `revoked` —
so `drafts.connectionId` and every historical send stay valid. A Clerk
`user.deleted` webhook cascades into deleting connections and their tokens, so the
token vault never outlives the account.

---

## Local setup

Requires Node 20+ and pnpm. (In a Codespace both are already there — see
[GitHub Codespaces](#github-codespaces).)

```bash
pnpm install
cp .env.example .env.local     # then fill in the Clerk values
npx convex dev                 # provisions the deployment, writes CONVEX_* into .env.local
pnpm dev                       # in a second terminal
```

`npx convex dev` must stay running in development — it pushes `convex/` on save.

Everything in `.env.local` is read by **Next.js**. Everything the backend needs is
set on the **Convex deployment**, which is a separate environment.

### `.env.local` (Next.js)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk frontend |
| `CLERK_SECRET_KEY` | Clerk backend |
| `CLERK_JWT_ISSUER_DOMAIN` | Clerk Frontend API URL; also set on Convex |
| `NEXT_PUBLIC_CONVEX_URL` | Convex deployment URL (written by `convex dev`) |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Convex HTTP-action base URL (written by `convex dev`) |
| `CONVEX_DEPLOYMENT` | Which deployment the CLI pushes to (written by `convex dev`) |

### Convex deployment env (`npx convex env set …`)

Add `--prod` to set the same value on the hand-in (`prod`) deployment. The
commented block in [`.env.example`](.env.example) carries the same list with the
console paths spelled out.

| Variable | Required? | What it does |
| --- | --- | --- |
| `CLERK_JWT_ISSUER_DOMAIN` | yes | Validates the incoming Clerk JWT. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | yes | Verifies the Clerk webhook signature. Per-endpoint, so dev and prod differ. |
| `TOKEN_ENCRYPTION_KEY` | yes | AES-256 key for the token envelope. Generate with `openssl rand -base64 32`. **Per-deployment** — one deployment's key must not decrypt another's tokens. |
| `GOOGLE_OAUTH_CLIENT_ID` | for Gmail | GCP → Credentials → OAuth client (Web application). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | for Gmail | Same client. |
| `SLACK_CLIENT_ID` | for Slack | Slack app → Basic Information. |
| `SLACK_CLIENT_SECRET` | for Slack | Same app. |
| `APP_BASE_URL` | yes | Origin the OAuth callback returns the browser to, e.g. `http://localhost:3000`. Every `returnTo` is resolved against it, which is what stops it being an open redirect. |
| `WEB_SEARCH_PROVIDER` | no | `tavily`, or unset for the mock. |
| `WEB_SEARCH_API_KEY` | no | Key for the chosen provider. Unset ⇒ mock. |
| `ALLOW_FAULT_INJECTION` | no | `"true"` enables the demo failure switches. Inert otherwise. |

`CONVEX_SITE_URL` is injected by Convex itself and is what the OAuth redirect URIs
are derived from, so they cannot drift between deployments.

```bash
npx convex env set TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"
npx convex env set APP_BASE_URL http://localhost:3000
npx convex env set ALLOW_FAULT_INJECTION true
```

### Clerk setup

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com)
   with Email and Google enabled.
2. Copy the **Publishable key** and **Secret key** into `.env.local`.
3. Make the session token carry `aud: "convex"` — either create a JWT template
   named exactly `convex` from Clerk's Convex preset, or set the audience on the
   Sessions page in newer dashboards. `convex@1.43`'s `ConvexProviderWithClerk`
   uses the default session token when its `aud` is already `convex`, and
   otherwise fetches a JWT template named `convex`; either works.
4. Copy the **Issuer** / Frontend API URL (`https://<slug>.clerk.accounts.dev`)
   into `.env.local` as `CLERK_JWT_ISSUER_DOMAIN`, and onto Convex:

   ```bash
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
   ```

Sign in on `/auth`. If Convex rejects the session — the shell sits on "setting up
your account", or a query throws — the `aud` claim or `CLERK_JWT_ISSUER_DOMAIN` on
the deployment is wrong. `users.viewer` is the thing to check: it reports the
Clerk user id resolved *by Convex*, not by the browser.

Two Clerk/Next.js details that differ from most tutorials: Next.js 16 names the
middleware file **`proxy.ts`** (same API, new name), and `@clerk/nextjs` v7
removed `<SignedIn>`/`<SignedOut>`/`<Protect>` in favour of a single `<Show>`,
with `ClerkProvider` going *inside* `<body>`.

### Auth gating

Three checks, and each exists because the one outside it cannot cover the case:

1. **`proxy.ts`** decides on the Clerk session cookie, before a route renders:
   `/` and the legacy `/sign-in` go wherever you belong, `/dashboard` bounces to
   `/auth` when signed out, and `/auth` bounces to `/dashboard` when signed in —
   so the gate closes behind you and the sign-in form is unreachable once you are
   in. No data is read here, which keeps it the optimistic check Next.js
   documents rather than the authorization boundary.
2. **`AuthGate` / `GuestGate`** cover the async window the server cannot see.
   Clerk resolves its session in the browser and Convex then exchanges it for its
   own token; until both land, the page shows `AuthSplash` instead of a shell
   whose queries would throw. `AuthGate` also waits for `viewer.stored`, so a
   brand-new user waits for their row rather than reading "your account is still
   syncing". `GuestGate` is what finishes sign-in: `LoginForm` never navigates, so
   the redirect happens the moment Clerk reports a session.

   **Only Clerk sends anyone back to `/auth`**, and that rule is load-bearing:
   Clerk is the only thing `proxy.ts` can see, so redirecting because *Convex*
   rejected the session would bounce off a proxy that still sees a valid Clerk
   cookie, and loop between the two forever. Clerk can disagree with itself the
   same way — the proxy only *verifies* the session token, while clerk-js sees a
   session revoked in the dashboard or ended in another tab seconds earlier — so a
   client-driven bounce carries `?signed_out=1` (`app/authParams.ts`) and the proxy
   takes the client's word for that one request. `useHardRedirect` strips the param
   from anything it carries onward, so it never outlives the bounce. Signed into Clerk but not ready is
   therefore an error state rather than a redirect — after a few seconds the splash
   becomes `AuthTrouble`, which offers **Try again** (a reload, which retries the
   upsert through `StoreUser`) and **Sign out** (which clears the Clerk cookie, and
   so is what makes `/auth` reachable again). Without that panel the two dead ends
   have no exit: the shell never mounts, so its own sign-out never renders.
3. **`useAuthedQuery`** holds every query at `"skip"` until Convex reports an
   authenticated identity. The gates already make an early call unlikely; this
   makes it impossible, including during SSR and on the frame after a sign out.
   Conditional skips compose with it, so `open ? {} : "skip"` still works.

None of that is the authorization boundary. Every Convex function resolves its
own owner through `requireUser`, so a route that slipped through all three still
cannot read another user's row — the layers above only decide what the browser is
asked to render.

The one thing this arrangement demands: sign-out has to live *inside* the shell
(the sidebar footer), because `/auth` is closed to a signed-in visitor. `AuthGate`
carries its own copy for the same reason — it renders instead of the shell.

One Next.js 16 detail worth knowing before changing a redirect here: `/auth` and
`/dashboard` sit in route groups with **separate root layouts**, which the App
Router only crosses with a full page load. `router.replace` between them leaves the
browser on the old route, so both gates go through `useHardRedirect`
(`window.location.replace`) instead. That also re-runs `proxy.ts` on the way in, so
the server and the client can never disagree about where you belong.

### Clerk webhook (user sync)

`ctx.auth.getUserIdentity()` proves who is calling, but it only fires while
someone is using the app — it never hears about a profile edit or a deletion made
in Clerk. The webhook keeps `users` correct in between, and it is served by
**Convex**, not Next.js, at `https://<deployment>.convex.site/clerk-webhook`
(`convex/http.ts`), for the same reason the OAuth callbacks are: a stable public
URL in development.

1. Clerk dashboard → **Configure → Webhooks**, one endpoint per deployment:

   | Deployment | Endpoint URL |
   | --- | --- |
   | dev | `https://judicious-wildcat-326.convex.site/clerk-webhook` |
   | hand-in (prod) | `https://scintillating-moose-307.convex.site/clerk-webhook` |

2. Subscribe each to `user.created`, `user.updated`, `user.deleted`.
3. Copy that endpoint's **Signing Secret** onto the matching deployment — each
   endpoint has its own, so they are not interchangeable:

   ```bash
   npx convex env set        CLERK_WEBHOOK_SIGNING_SECRET whsec_...   # dev
   npx convex env set --prod CLERK_WEBHOOK_SIGNING_SECRET whsec_...   # hand-in
   ```

The handler verifies every request with Svix before reading it (an unverified body
is an unauthenticated write to `users`); shares one idempotent upsert between
`user.created` and `user.updated`, because Svix retries on any non-2xx and can
deliver out of order; picks the **primary** email rather than the first; answers
unknown event types with 200; and returns 400 on a bad signature but 500 on a
missing secret — 400 stops Svix retrying something that can never verify, 500
makes it retry a misconfiguration a human can still fix.

---

## OAuth setup

Both providers need the redirect URI to match **byte for byte**. It is always:

```
https://<your-convex-deployment>.convex.site/oauth/google/callback
https://<your-convex-deployment>.convex.site/oauth/slack/callback
```

`<your-convex-deployment>` is the slug in `NEXT_PUBLIC_CONVEX_SITE_URL`, written
into `.env.local` by `npx convex dev`. Note `.convex.site`, not `.convex.cloud`,
and note it is the *Convex* URL rather than `localhost` — that is what makes real
OAuth work without a tunnel.

### Google (Gmail)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **OAuth consent screen** → External → fill in the app name and support email.
   Leave the publishing status as **Testing**.
4. **Audience → Test users** → add every Google account you intend to connect. In
   Testing mode an account that is not on this list cannot grant access at all.
5. **Data access → Add scopes** — the four the app requests, and no more:
   `openid`, `email`,
   `https://www.googleapis.com/auth/gmail.readonly`,
   `https://www.googleapis.com/auth/gmail.send`.
   Notably absent: `gmail.modify`, `gmail.compose`, and anything that can delete
   mail.
6. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorised redirect URI:
   `https://<deployment>.convex.site/oauth/google/callback`.
7. Set the client id and secret on Convex:

   ```bash
   npx convex env set GOOGLE_OAUTH_CLIENT_ID     <id>.apps.googleusercontent.com
   npx convex env set GOOGLE_OAUTH_CLIENT_SECRET GOCSPX-…
   ```

Two things to expect, both normal:

- **The unverified-app interstitial.** A Testing-mode app shows "Google hasn't
  verified this app". Click *Advanced → Go to … (unsafe)*. Verification is a review
  process, not a code change, and is out of scope for an assessment build.
- **Refresh tokens expire after 7 days** while the app is in Testing. That is
  Google's documented behaviour for all testing apps, and it is not worked around
  — it is why the reconnect path is a routinely demonstrable feature rather than a
  branch nobody ever exercises. The connection surfaces as `needs_reconnect` with
  Google's verbatim `invalid_grant` reason, and reconnecting preserves the row and
  everything hanging off it.

The authorization request sends `access_type=offline` **and `prompt=consent` on
every authorization**, because a re-consent for scopes already granted returns no
refresh token at all. Even so, the code exchange may legitimately return none — in
which case the stored refresh token is kept rather than overwritten with nothing.
PKCE (S256) is used on the Google flow.

### Slack

Create the app from a manifest — **Slack API → Your apps → Create New App → From
an app manifest** — and paste this, substituting your deployment slug:

```yaml
display_information:
  name: Unified Inbox
  description: Search and reply across Gmail, Slack and the web from one place.
oauth_config:
  redirect_urls:
    - https://<deployment>.convex.site/oauth/slack/callback
  scopes:
    user:
      - search:read
      - chat:write
      - users:read
settings:
  token_rotation_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
```

Then **Basic Information → App Credentials**:

```bash
npx convex env set SLACK_CLIENT_ID     123…
npx convex env set SLACK_CLIENT_SECRET …
```

Install it into a throwaway workspace. Three Slack-specific notes:

- **`search.messages` requires a user token (`xoxp-`)** — a bot token cannot call
  it at all. So the install requests `user_scope`, and the app reads
  `authed_user.access_token`; the top-level `access_token` (the bot token) is
  deliberately ignored. If you see "returned no user token", the manifest granted
  `scopes.bot` instead of `scopes.user`.
- **Slack does not support PKCE** on `oauth.v2.access`, so the single-use,
  expiring, provider-bound `state` is the whole CSRF defence there.
- **Slack reports application errors as HTTP 200** with `{ok: false, error}`.
  Status-code classification is useless; the `error` string is mapped explicitly in
  `classifySlackError` (`token_revoked` → reconnect, `ratelimited` → transient,
  `channel_not_found` → permanent, anything unrecognised → permanent, because an
  unclassified failure retrying forever is worse than one an operator must look
  at). Slack `ts` values are `seconds.micros`, so they are multiplied by 1000 —
  forgetting that puts every message in 1970.

**Token rotation is off on purpose.** With rotation disabled a Slack user token
does not expire, so there is no refresh to get wrong.

---

## Web search

**Tavily.** It has a genuinely free tier (1,000 searches/month), needs no credit
card, and returns title/url/content in one POST — which is all the third source
has to produce. Brave Search is a drop-in alternative behind the same interface.

```bash
npx convex env set WEB_SEARCH_PROVIDER tavily
npx convex env set WEB_SEARCH_API_KEY  tvly-…
```

**With no key set, the web source falls back to a clearly-labelled deterministic
mock**, so a fresh clone or Codespace searches all three sources with zero
signups. The rules for that fallback, because demo data which can be mistaken for
real data is worse than no demo data:

- Every title is prefixed **`[mock]`**, and the source strip in the UI reads
  **"Web search (mock provider)"** rather than just "Web".
- Each snippet says how to switch to the real thing.
- URLs are real search pages on real sites (Wikipedia, MDN, Hacker News, Stack
  Overflow, arXiv), so clicking a result is not a dead end.
- Result count and ordering are a stable hash of the query — the same query always
  returns the same results, so screenshots and tests are reproducible.
- A configured provider with a *missing* key falls back to the mock rather than
  failing the source. A missing key is a setup state, not an outage.

Web results deliberately carry no `timestamp`: Tavily's `published_date` is absent
for most pages and wrong for a fair share of the rest, and an absent timestamp is
honest where a guessed one would poison ranking. The schema and the public
`Result` both allow it to be missing — one of three ways the web source is unlike
Gmail and Slack (no grant, no timestamp, no reply) that the merge layer has to
absorb without special-casing.

---

## Demo data and fault injection

### One-click seed

**Settings → Demo data → Load demo data.** It is an authenticated public mutation
(`api.seed.seed`) scoped to the calling user, so a reviewer can run it from the UI
with no CLI and no shared state.

It creates one full set of fixtures:

- **3 connections** — an active Gmail account, a second Gmail in `expired`, and a
  Slack workspace in `revoked`.
- **4 searches** with their per-source runs and results, including one still
  `running` (so the partial-results state is visible standing still), one where
  Slack came back `needs_reconnect`, and one with a `failed` Gmail source.
- **Drafts in every status** — `draft`, `confirmed`, `sent`, `failed`.
- **A send in each of the seven states** — `queued`, `in_flight`, `succeeded`,
  `failed_transient`, `failed_permanent`, `needs_reconnect`, `unknown` — each with
  a realistic attempt timeline and a full error where one applies.

Three rules make it safe to ship:

1. **Every row is `isSeed: true` and scoped to the caller.** The UI badges them as
   demo data, and **Remove demo data** deletes only the caller's own rows — every
   top-level delete is gated on `isSeed`, and children are reached through their
   seeded parent rather than by a flag of their own, so a real search's results
   cannot be reached from there at all.
2. **Seeded connections hold no grant.** Their ciphertext is the literal string
   `seed`, `resolveToken` refuses `isSeed` rows *before* any provider call, and
   they are left `enabled: false` so they never join a live fan-out. Demo data
   cannot spend a real API quota, not even on a failure.
3. **Running it twice changes nothing.** The mutation looks for its own
   connections first and returns what already exists.

Seeded error text is prefixed `[seed]` for the same reason injected faults are
prefixed `[simulated]`: an operator must never have to wonder whether an error in
front of them really happened.

### Fault injection

Gated behind `ALLOW_FAULT_INJECTION=true` on the deployment and completely inert
without it — a demo flag left in a client build cannot break a real search.

| Affordance | Where | What it demonstrates |
| --- | --- | --- |
| `demo.delayMs: {web: 3600}` | on by default in `useSearch.ts`; also an argument to `searches.run` / `searches.rerun` | Gmail and Slack land and are readable while web is still working. Criterion: partial results. |
| `demo.injectFailure: {slack: "needs_reconnect"}` | same argument | A revoked grant renders as its own state with a reconnect action, not a generic error. |
| `demo.injectFailure: {gmail: "transient"}` | same argument | Backoff, the attempt counter climbing, then giving up honestly. |
| `drafts.create({injectFailure})` | compose | Any of the four send outcomes on demand, including `unknown` — the one that refuses to be retried. The fault is copied onto the frozen send, so it survives retries. |
| `connections.simulateRevoke({connectionId})` | mutation | Breaks a real connection's tokens **without** touching its status, so the system has to *discover* the dead grant on next use, classify the provider's real 401, and flip the status itself. Setting the status directly would demo the UI and skip the mechanism. |

Every injected fault is prefixed **`[simulated]`** in the stored error text.

---

## REST API

The same module, no browser. The base URL is the Convex site URL:
`https://<deployment>.convex.site`.

**Auth.** Create a key in **Settings → API keys**; it is shown once and stored only
as a SHA-256 digest, because a database dump must not be a set of working
credentials. There is no "show key" endpoint and no REST route that mints, lists or
revokes keys — key management is Clerk-authenticated only, so a leaked key cannot
mint a fresh one and outlive its own revocation. Lookup is an indexed read on the
digest with a constant-time comparison.

```
Authorization: Bearer uik_…
```

A request for another user's row returns **404, not 403** — 403 would confirm the
row exists, which is a slow enumeration oracle. Rate limits are token buckets per
user (10 fan-outs/min, 30 REST writes/min) and `Retry-After` comes from the
bucket's own arithmetic, so it says when a retry will actually succeed.

Every route lives under `/api/v1`; `POST /drafts` and `POST /drafts/{id}/send` are
**also** mounted at the bare paths the specification writes literally. Both mount
points reach one routing table, so the alias cannot drift from the versioned route.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/searches` | `{query, sources?}` → **202** + `search_url`, `results_url`. |
| `GET` | `/api/v1/searches` | The caller's history. |
| `GET` | `/api/v1/searches/{id}` | Status plus **per-source** status, attempts, duration and error. |
| `GET` | `/api/v1/searches/{id}/results` | `?order=rank\|arrival`. Exactly the seven public fields. |
| `POST` | `/api/v1/searches/{id}/rerun` | **202.** Creates a *new* search with `rerun_of` — history is never overwritten. |
| `POST` | `/api/v1/drafts` (also `/drafts`) | **201**, or **200** with `X-Idempotent-Replay: true` if the key was reused. |
| `GET` | `/api/v1/drafts/{id}` | Includes `canonical_payload` and `review_hash`. |
| `POST` | `/api/v1/drafts/{id}/confirm` | `{reviewed_hash}`. The server re-derives and compares. |
| `POST` | `/api/v1/drafts/{id}/send` (also `/drafts/{id}/send`) | `{acknowledged_destination}`. See below. |
| `GET` | `/api/v1/sends` | The outbox. |
| `GET` | `/api/v1/sends/{id}` | The send plus every attempt and the full redacted error. |
| `POST` | `/api/v1/sends/{id}/retry` | Allowed for a failed send; **409** for an `unknown` one. |
| `GET` | `/api/v1/connections` | Provider, account, status, enabled. |

Errors always have one shape — `{"error": {"code", "message"}}` — because a client
that has to guess whether today's 409 is `{error: "…"}` or `{message: "…"}` ends up
string-matching, and then our error text becomes their API contract. `OPTIONS` and
permissive CORS are supported: the credential is a header, never a cookie, so `*`
grants nothing except the ability to try.

### The confirm friction exists in the API too

Criterion 4 is not a UI feature. `POST /drafts/{id}/send` requires
`acknowledged_destination`, and it must repeat the draft's recipient **verbatim**;
a mismatch is a 409. Combined with the `reviewed_hash` on confirm, that is three
round trips minimum — and there is no endpoint anywhere that accepts a recipient
and a body and delivers them.

### Idempotent send semantics

Two calls with the same key return **byte-identical response bodies**. That the
second one claimed nothing is reported in the `X-Idempotent-Replay` header rather
than in the body, so "prove the double-tap sent once" is `diff` on two files.
`POST /drafts/{id}/send` then *waits* up to five seconds for the delivery to
settle, so a `curl` in a terminal usually shows the real outcome instead of a job
id; past that budget it answers **202** with a `Retry-After` and a `send_url`,
because holding the connection open longer would be pretending the send is
synchronous when it is not.

### Walkthrough

[`docs/api-walkthrough.sh`](docs/api-walkthrough.sh) runs the whole product over
`curl` — search → poll → results → rerun → draft → confirm → send → double-send →
retry → outbox — and asserts the two send responses are byte-identical. It needs
only `curl` and `python3`.

```bash
BASE_URL=https://<deployment>.convex.site API_KEY=uik_… ./docs/api-walkthrough.sh
```

Some individual calls:

```bash
API=https://<deployment>.convex.site/api/v1
KEY=uik_…

# 1. Fan out. 202 — scheduled, not finished.
curl -sS -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"invoice"}' "$API/searches"

# 2. Partial results are real: poll while it runs.
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

# 4. Read it back — review_hash comes only from reading the payload.
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

The suite runs on `convex-test` under `@edge-runtime/vm`, against a fake-provider
`fetch` router that also records every call — so "how many times did we hit the
provider" is an assertion rather than an inference. What it proves, in rough order
of importance:

- **Idempotency.** A double-send makes exactly one provider call; concurrent
  claims produce exactly one `sends` row; a retry after success makes zero calls;
  the same key with a different payload is a 409; an `in_flight` send is a no-op.
- **Fan-out.** A deferred web source does not stop Gmail's results from being
  readable while it runs, and arrival order is stable.
- **Normalization.** The public `Result` has exactly the seven fields, from every
  source; a Slack `ts` lands in the right year; the REST projection's key set is
  exact.
- **Reconnect.** `invalid_grant` and a Slack `200 {ok:false}` both become
  `needs_reconnect` + `revoked` with zero wasted provider calls; the upsert
  preserves `_id`; the same key sends successfully after a reconnect.
- **Failure handling.** A 503 backs off to the attempt ceiling; a 400 fails
  permanently after one attempt; a timeout becomes `unknown`; retrying an
  `unknown` is refused; the sweeper resolves an abandoned `in_flight`.
- **Confirm friction.** Unconfirmed and edited-after-confirm claims are refused; a
  mismatched `acknowledged_destination` is a 409; and a **snapshot of the public
  function list** fails if anyone ever adds a one-shot send path.
- **API keys, crypto, canonicalization.** 401s and cross-user 404s; digest-only
  storage; AEAD round-trip, tamper detection, and an AAD swap failing; canonical
  payload stability across revisions.

### The honest caveat

`convex-test` runs mutations against an in-memory implementation. It does **not**
reproduce Convex's real optimistic-concurrency retry, so the concurrent-claim test
demonstrates that the *logic* is a single-transaction indexed read-then-insert; it
cannot, by itself, prove the OCC behaviour that makes that logic safe under real
contention.

So the guarantee is also verified against a **deployed** deployment:

```bash
BASE_URL=… API_KEY=uik_… RECIPIENT=… npx tsx scripts/double-tap.ts
```

It fires N genuinely parallel `POST /drafts/{id}/send` calls at the real API with
one key, and asserts N byte-identical responses, exactly one `sends` row and
exactly one provider message id — then **checks the recipient's actual inbox or
channel** for exactly one copy. That last step is the only assertion that is not
ultimately trusting our own bookkeeping.

---

## GitHub Codespaces

[`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) gives a Node
20 image with pnpm via corepack, runs `pnpm install` on create, and forwards port
3000.

**Open in a Codespace, then:**

```bash
cp .env.example .env.local        # paste your Clerk keys
npx convex dev                    # links a deployment, writes CONVEX_* into .env.local
npx convex env set TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
npx convex env set APP_BASE_URL "https://$CODESPACE_NAME-3000.app.github.dev"
npx convex env set ALLOW_FAULT_INJECTION true
pnpm dev                          # second terminal; open the forwarded port 3000
```

After Convex and Clerk, **no third-party signup is needed to see the whole
product**:

- Web search runs on the labelled deterministic mock, so the fan-out has three
  real sources with no API key.
- **Settings → Demo data → Load demo data** populates connections, search history
  with partial and failed states, drafts in every status, and a send in each of the
  seven states with full attempt timelines.
- **Settings → API keys → Create key**, then run `docs/api-walkthrough.sh` against
  `NEXT_PUBLIC_CONVEX_SITE_URL` to exercise the REST surface end to end.
- `pnpm test` needs nothing external at all.

Gmail and Slack still need their own OAuth apps (see
[OAuth setup](#oauth-setup)); the redirect URIs point at `convex.site` rather than
at the Codespace, so they work from a Codespace unchanged. Set `APP_BASE_URL` to
the forwarded Codespace origin so the callback returns you to the right place.

---

## Deployments

Two Convex deployments, one Clerk instance:

| Name | Convex deployment | Purpose |
| --- | --- | --- |
| dev | `judicious-wildcat-326` | `npx convex dev`, pushes on save |
| hand-in (`prod`) | `scintillating-moose-307` | The submitted deployment: deployed build, real OAuth |

Convex only has the deployment types `dev` and `prod`, so the hand-in deployment
*is* the `prod` one here — Convex's production tier, not a production
application. `CLERK_JWT_ISSUER_DOMAIN` is identical on both because they share one
Clerk instance; the webhook secret and `TOKEN_ENCRYPTION_KEY` are per-deployment.

```bash
pnpm deploy:handin   # convex deploy → scintillating-moose-307
pnpm dev:handin      # next dev on localhost, pointed at the hand-in deployment
```

`dev:handin` sets the Convex URLs inline rather than through a `.env.handin` file
on purpose: Next.js only auto-loads `.env.$(NODE_ENV)`, and `NODE_ENV` accepts
nothing but `production`, `development` and `test` — a `.env.handin` would
silently never load. Inline `process.env` sits at the top of Next's lookup order,
so it wins over `.env.local`.

---

## Screenshots

In [`docs/screenshots/`](docs/screenshots). These were captured during the
UI-first phase, against the mock harness the components were built on — which is
why several still carry a **"MOCK"** badge. The components themselves are
unchanged and are now driven by live Convex subscriptions, so the layouts are
current even where those badges are not.

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

---

## Known limits

Stated because a reviewer will find them anyway, and because most of them are
choices rather than omissions.

- **No provider-side send idempotency exists.** The claim row is the whole
  guarantee. The deterministic Gmail `Message-ID` makes an `unknown` outcome
  *reconcilable by reading*, but reconciliation is a manual `rfc822msgid:` lookup
  today — there is no one-click reconcile button. The outbox instead refuses the
  retry and says what to do.
- **`convex-test` does not reproduce OCC**, which is why
  `scripts/double-tap.ts` exists (see [Tests](#tests)).
- **Google Testing-mode refresh tokens expire after 7 days**, and the app shows
  the unverified-app interstitial. Both are consequences of not going through
  Google verification.
- **Slack token rotation is off**, so that code path ships unexercised.
- **Gmail connection identity is the email address**, not `sub`. Immutable enough
  in practice and far more legible in a connections list; the tradeoff is argued
  where it is acted on.
- **Fault injection has no toggle UI.** The slow-web-source demo is on by default;
  the failure injections are arguments to `searches.run`, `drafts.create` and
  `connections.simulateRevoke`. All of them are inert unless
  `ALLOW_FAULT_INJECTION=true`.
- **Results are capped at 20 per source**, which is also the single-mutation
  transaction budget that keeps a source's terminal state atomic.
