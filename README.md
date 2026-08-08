# Unified Inbox

Search Gmail, Slack and the web from one place.

| | |
| --- | --- |
| **Deployed app** | **https://unified-inbox-assessment.vercel.app** — the graded URL, real Gmail and Slack OAuth, on Vercel |
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

The Convex backend is what the REST API and the OAuth callbacks live on, so its
base URL is separate from the app's. There are two, and every `curl` example in
this README takes one of them:

| Convex deployment | Base URL | Used by |
| --- | --- | --- |
| deployed | `https://scintillating-moose-307.convex.site` | The deployed Vercel app above. Use this to exercise the REST API against the submitted deployment |
| dev | `https://judicious-wildcat-326.convex.site` | Local and Codespaces. It is `NEXT_PUBLIC_CONVEX_SITE_URL` in `.env.local` |

- [Reviewer login](#reviewer-login)
- [Architecture](#architecture)
- [Local setup](#local-setup)
- [GitHub Codespaces](#github-codespaces)
- [OAuth setup](#oauth-setup)
- [Web search](#web-search)
- [Demo data and fault injection](#demo-data-and-fault-injection)
- [REST API](#rest-api)
- [Tests](#tests)
- [Deployments](#deployments)
- [Known limits](#known-limits)

---

## Reviewer login

The same test account works on both the [deployed Vercel app](https://unified-inbox-assessment.vercel.app)
and a local or Codespaces copy:

- Email: `test+clerk_test@test.com`
- Verification code: `424242`

This uses Clerk's documented [test email and verification-code flow](https://clerk.com/docs/guides/development/testing/test-emails-and-phones).

---

## Architecture

### The module boundary

`convex/` contains the backend: serverless functions, the database schema,
queries, database changes, provider integrations, and the REST API.

```
Next.js frontend ──┐
                   ├──▶ convex/ ──▶ Gmail, Slack, web, and the database
REST API / curl ───┘
```

`app/(inbox)/` is just the frontend. To try the `curl` version, create an API key
under Settings → API keys, then provide the base URL, key, and recipient. The
base URL is either Convex base URL from the table at the top:

```bash
UNIFIED_INBOX_BASE_URL=https://scintillating-moose-307.convex.site \
UNIFIED_INBOX_API_KEY=uik_… \
UNIFIED_INBOX_RECIPIENT=you@example.com ./docs/api-walkthrough.sh
```

### The adapter contract

Every provider uses the same `SearchAdapter` and returns the same seven-field
`Result` from the brief. This lets the app merge results without knowing whether
they came from Gmail, Slack, or the web. Each adapter only receives what it needs
to search, such as a valid access token, scopes, and a result limit.

The original result shape was too limited for the UI. With multiple accounts and
Slack workspaces connected, it was hard to tell where a result came from or who
wrote it. I added optional `ResultExtras` for details such as profile pictures,
workspace names, and sender information. The UI can use those details, while the
REST API still returns exactly the seven fields required by the brief.

### Search fan-out

When a search starts, Convex creates a separate worker for every connected
account and one for the web. Each worker runs independently, so a slow or failed
source does not block the others.

```
Search
  ├── Gmail account 1 worker ──▶ results
  ├── Gmail account 2 worker ──▶ results
  ├── Slack workspace worker ──▶ results
  └── Web worker ──────────────▶ results
```

Each worker saves its results as soon as it finishes. The UI uses a Convex
reactive query, so those results appear immediately without polling or waiting
for the whole search. Workers also have retries and a time limit, so anything
that takes too long is stopped and the search cannot stay stuck forever.

### Adding a source

Adding a source is mostly writing one adapter and registering it. The new source
then uses the same fan-out, partial results, retries, error handling, and history
as every other provider. TypeScript points out the few small places that still
need a source name, display label, or icon.

```
New adapter ──▶ registry ──▶ shared search, retries, results, and history
```

If the source needs OAuth, it also needs its own connection and login flow.

The main files to update are:

| File | Change |
|---|---|
| `convex/adapters/<source>.ts` | Add the provider adapter. |
| `convex/core/registry.ts` | Register the adapter. |
| `convex/core/types.ts` | Add the source name. |
| `convex/schema.ts` | Allow the source in the database. |
| `convex/core/rank.ts` | Add its ranking weight. |
| `app/(inbox)/types.ts` | Add the source to the frontend type. |
| `app/(inbox)/mock-data.ts` | Add its display name. |
| `app/(inbox)/brand-icons.tsx` | Add its icon. |

### The send gate

```
Create draft ──▶ Review exact message ──▶ Confirm ──▶ Claim and send
     │                    │                              │
     └─ creates key       └─ creates digest             └─ checks both again
```

There is no function that accepts a recipient and message and sends immediately.
Creating a message only saves a draft. The user must review the exact payload,
confirm its digest, and enter the recipient again before it can be sent.

The digest is checked again when the send is claimed. If the draft changes, the
old confirmation stops working and the message must be reviewed again.

#### Why double-sending is impossible

`sends.claim` checks the idempotency key and creates the send in one Convex
mutation:

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

If two sends arrive at the same time, both may initially see that the key is
unused. Convex detects the conflict, retries one of them, and that retry finds
and returns the send that already won. Only one delivery job is created.

The message payload and delivery job are saved in that same transaction. This
means editing the draft later cannot change the claimed message, and a delivery
job cannot exist without its send record.

#### Failure taxonomy

Different failures need different retry behaviour. Every attempt and its result
is saved so the Outgoing page can show the full history.

| Kind | What it means | What happens |
| --- | --- | --- |
| `transient` | A temporary issue such as a 503 or rate limit. | Retry with a delay, up to four attempts, then wait for a person. |
| `permanent` | The request cannot work, such as an invalid recipient. | Stop after one attempt because retrying will not help. |
| `needs_reconnect` | The provider token is expired or revoked. | Ask the user to reconnect, then allow the same send to be retried safely. |
| `unknown` | A rare failure where the message may have been sent, but the result was not confirmed. | Do not retry automatically or manually because the message may already have arrived. |

`unknown` is treated carefully because a send timeout is different from a search
timeout. The system can check Gmail using the message ID, or the user can create
a new draft with a new key, but it will not risk sending the same message again.

### Multi-account OAuth and tokens

```
App ──▶ Convex starts OAuth ──▶ Google or Slack consent
 ▲                                  │
 └──── checked redirect ◀── Convex callback ──▶ encrypted connection
```

OAuth starts from the authenticated backend, so the app already knows which user
is connecting an account. The callback goes directly to the stable Convex URL,
which lets Google and Slack OAuth work even when the frontend runs on localhost.
The login state can only be used once, expires, and is tied to the correct
provider. The redirect back to the app is also checked before it is used.

Each Gmail account or Slack workspace is stored as its own connection. Reconnecting
the same account updates that connection so its existing drafts, sends, and
results still work. Trying to reconnect as a different account is refused and
the user is asked to add it separately.

Tokens are encrypted before they are stored, and the encryption key only lives
in the Convex environment. Tokens refresh only when they are needed. If two jobs
need the same refresh at once, one refreshes while the other waits and uses the
result. If the provider says access is no longer valid, the connection changes
to revoked and the UI asks the user to reconnect.

Slack token rotation is currently disabled, so this refresh flow is mainly used
for Gmail tokens, which expire regularly.

### Auth, briefly

I used Clerk because authentication was not the main focus of the project, and
it let me spend more time on the adapter layer and send gate.

```
Clerk sign-in ──▶ JWT ──▶ Convex verifies user ──▶ function checks data ownership
```

Clerk signs the user in and gives Convex a JWT. Every backend function verifies
the user and checks that the requested data belongs to them, so one user cannot
read or change another user's data.

---

## Local setup

Needs Node 22.13+ and pnpm 11.13.0.

```bash
pnpm install
cp .env.example .env.local     # then fill in the Clerk values
npx convex dev                 # provisions the deployment, writes CONVEX_* into .env.local
pnpm dev                       # in a second terminal
```

`pnpm exec convex dev` only has to stay running while you are changing backend
code, it pushes `convex/` on save. To just run the app against the backend that
already exists, `pnpm dev` on its own is enough.

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

Add `--prod` to set the same value on the deployed environment.

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
| `ALLOW_PRIVATE_NETWORK_ORIGINS` | no | `"true"` also allows a private-network origin on any port, so a phone on the same Wi-Fi can finish an OAuth flow. `pnpm dev:lan` sets it on dev, leave it unset on deployed. |
| `ALLOW_CODESPACES_ORIGINS` | no | `"true"` also allows an HTTPS GitHub Codespaces forwarded-port origin (`*.app.github.dev`) as an OAuth return target. Set it only on the dev deployment used from Codespaces, leave it unset on deployed. |
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
22 image with pnpm via corepack, runs a frozen `pnpm install` on create, and
forwards port 3000.

**[Create a Codespace on `main`](https://codespaces.new/Aryan-Saini/unified-inbox-assessment?ref=main)**

Use that direct link if GitHub does not show the Codespaces option under the
repository's **Code** button. Then:

1. Sign in to GitHub and click **Create codespace**.
2. Wait for the automatic dependency installation to finish.
3. Upload the provided `.env.reviewer` file and rename it to `.env.local`.
4. Run `pnpm dev` and open forwarded port 3000.
5. Sign in with the [reviewer account](#reviewer-login).

If you instead store
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and
`CLERK_JWT_ISSUER_DOMAIN` as repository Codespaces secrets, they are already
available in the terminal. The devcontainer points the app at the local-dev
Convex deployment, `judicious-wildcat-326`, so starting the app is one command:

```bash
pnpm dev
```

Open the forwarded port 3000 when Codespaces reports it. No Convex process is
needed merely to run the frontend against the existing backend.

Only run `pnpm exec convex dev` when changing files under `convex/`. That command
needs Convex authentication: either sign in interactively or provide a dev
deployment key as the `CONVEX_DEPLOY_KEY` Codespaces secret. Keep it running only
for the duration of backend development so it can push and watch those changes.

Gmail and Slack OAuth callbacks also need the Codespace origin accepted by the
backend: either register it as `APP_BASE_URL` / in `APP_ORIGIN_ALLOWLIST`, or set
`ALLOW_CODESPACES_ORIGINS` to `true` on the dev deployment, which accepts any
HTTPS `*.app.github.dev` forwarded-port origin and so survives a new Codespace
getting a new hostname. It is off by default because that namespace is shared by
every Codespaces tenant, and it stays unset on the deployed environment.

```bash
npx convex env set ALLOW_CODESPACES_ORIGINS true
```

Changing that backend environment setting likewise requires Convex
authentication; it is not required just to start and inspect the app.

After Convex and Clerk, no third-party signup is needed to see the whole product.
Web search runs on the labelled deterministic mock so the fan-out has three real
sources with no API key, the demo data button fills history with every status,
`docs/api-walkthrough.sh` exercises the REST surface end to end, and `pnpm test`
needs nothing external at all.

Gmail and Slack still need their own OAuth apps, and their provider redirect URIs
continue to point at `convex.site`, not at the Codespace.

---

## OAuth setup

Use these callback URLs, replacing `<deployment>` with the slug from
`NEXT_PUBLIC_CONVEX_SITE_URL`:

```text
https://<deployment>.convex.site/oauth/google/callback
https://<deployment>.convex.site/oauth/slack/callback
```

### Google (Gmail)

1. Create a project at [Google Cloud Console](https://console.cloud.google.com).
2. Enable the Gmail API and People API.
3. Configure the OAuth consent screen as External and Testing.
4. Add every Google account you will connect under Test users.
5. Add these scopes:

```text
openid
email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/contacts.readonly
```

6. Create a Web application OAuth client.
7. Add this redirect URI:

```text
https://<deployment>.convex.site/oauth/google/callback
```

8. Set the credentials on Convex:

```bash
npx convex env set GOOGLE_OAUTH_CLIENT_ID <id>.apps.googleusercontent.com
npx convex env set GOOGLE_OAUTH_CLIENT_SECRET GOCSPX-…
```

Google Testing mode shows an unverified-app warning and expires refresh tokens
after seven days.

### Slack

1. Go to Slack API → Your apps → Create New App → From an app manifest.
2. Paste this manifest after replacing `<deployment>`:

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
      - channels:history
      - groups:history
settings:
  token_rotation_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
```

3. Set the credentials from Basic Information → App Credentials:

```bash
npx convex env set SLACK_CLIENT_ID 123…
npx convex env set SLACK_CLIENT_SECRET …
```

4. Install the app into a workspace.
5. To allow other workspaces, enable Manage Distribution → Public Distribution.

## Web search

1. Create a Tavily API key.
2. Set the provider and key:

```bash
npx convex env set WEB_SEARCH_PROVIDER tavily
npx convex env set WEB_SEARCH_API_KEY tvly-…
```

Without a key, web search uses clearly labelled mock results.

## Demo data and fault injection

### Load demo data

1. Open Settings → Demo data.
2. Select Load demo data.
3. Use Remove demo data to delete it.

Demo data is private to the signed-in user, labelled in the UI, and cannot call
a real provider. It includes sample connections, searches, drafts, sends, and
failure states.

### Fault injection

Set this only on a test deployment:

```bash
npx convex env set ALLOW_FAULT_INJECTION true
```

| Option | Demonstrates |
|---|---|
| Slow web source | Partial results while web is still running. |
| Slack `needs_reconnect` | Reconnect handling. |
| Gmail `transient` | Retry and backoff. |
| Draft failure | Send failure states, including `unknown`. |
| Simulate revoke | Detecting a revoked real connection. |

## REST API

1. Open Settings → API keys.
2. Create a key and save it when shown.
3. Use the Convex base URL from the table at the top, matching the deployment
   you made the key on.
4. Send the key as a bearer token:

```bash
API=https://scintillating-moose-307.convex.site/api/v1
KEY=uik_…

curl -H "Authorization: Bearer $KEY" "$API/connections"
```

| Method | Path |
|---|---|
| POST | `/api/v1/searches` |
| GET | `/api/v1/searches` |
| GET | `/api/v1/searches/{id}` |
| GET | `/api/v1/searches/{id}/results` |
| POST | `/api/v1/searches/{id}/rerun` |
| POST | `/api/v1/drafts` |
| GET | `/api/v1/drafts/{id}` |
| POST | `/api/v1/drafts/{id}/confirm` |
| POST | `/api/v1/drafts/{id}/send` |
| GET | `/api/v1/sends` |
| GET | `/api/v1/sends/{id}` |
| POST | `/api/v1/sends/{id}/retry` |
| GET | `/api/v1/connections` |

All errors use:

```json
{"error":{"code":"…","message":"…"}}
```

### Documentation

| URL | Format |
|---|---|
| `/documentation` | Web documentation |
| `/documentation/llms.txt` | API index |
| `/documentation/llms-full.txt` | Full Markdown reference |
| `/documentation/openapi.json` | OpenAPI 3.1 |
| `/documentation/AGENTS.md` | Agent instructions |

### Walkthrough

Requires `curl`, `python3`, a created API key, and a recipient:

```bash
UNIFIED_INBOX_BASE_URL=https://scintillating-moose-307.convex.site \
UNIFIED_INBOX_API_KEY=uik_… \
UNIFIED_INBOX_RECIPIENT=you@example.com ./docs/api-walkthrough.sh
```

The script searches, creates and confirms a draft, sends it, checks a duplicate
send, retries eligible failures, and reads the outbox.

## Tests

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

The tests cover idempotency, parallel search, result normalization, reconnects,
failure handling, confirmation, API keys, encryption, and adapter registration.

To verify parallel sends against a deployed API:

```bash
BASE_URL=… API_KEY=uik_… RECIPIENT=… npx tsx scripts/double-tap.ts
```

## Deployments

| Name | Convex deployment | Purpose |
|---|---|---|
| dev | `judicious-wildcat-326` | Local development |
| deployed | `scintillating-moose-307` | Submitted deployment |

```bash
pnpm deploy:deployed
pnpm dev:deployed
pnpm deploy:vercel
```

Deploy everything and verify it:

```bash
pnpm deploy
pnpm deploy -- --dry-run
```

For the combined deploy, create `.env.deploy`:

```bash
CONVEX_DEPLOY_KEY=prod:scintillating-moose-307|…
SMOKE_API_KEY=uik_…
SMOKE_RECIPIENT=you@example.com
SMOKE_APP_URL=https://unified-inbox-assessment.vercel.app
```

The frontend deploy is manual. Pushing to GitHub does not deploy it.

## Known limits

- Results are limited to 20 per source.
- Google Testing-mode refresh tokens expire after seven days.
- Slack token rotation is disabled.
- Gmail connection identity uses the email address.
- Unknown Gmail sends require a manual message-ID check.
- `convex-test` does not reproduce Convex OCC, so deployed double-send behavior
  is also checked by `scripts/double-tap.ts`.

## What I would do next

- Add backend pagination and infinite scrolling.
- Improve Slack threads and distinguish DMs, private groups, and public channels.
- Add email signatures and To/CC details.
- Add adapters for Jira, Linear, ClickUp, Confluence, Outlook, and Discord.
