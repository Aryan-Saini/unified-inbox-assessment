# Sol (GPT 5.6) plan — Unified Inbox backend

Gaps identified in current repo:
- `connections.enabled` and `searches.archived` exist in the UI contract but not the schema.
- Multi-account searches produce multiple runs for the same source; the UI currently keys runs only by `source`.
- Convex can guarantee a single transactional send claim, but Gmail/Slack cannot guarantee an externally atomic "provider accepted + Convex recorded" operation. Ambiguous outcomes must become `unknown` and must never be blindly retried.

## 1. Architecture

### Authentication and ownership
- UI-facing Convex functions authenticate through Clerk/Convex JWTs.
- REST endpoints authenticate `Authorization: Bearer uik_…`.
- API keys ≥256 bits entropy, stored only as SHA-256 hashes, shown once.
- Every query/mutation derives the user server-side. No public function accepts an authoritative `userId`.
- Internal scheduled workers receive database IDs, then revalidate ownership before doing work.

### OAuth and connection lifecycle
Convex HTTP actions: POST /oauth/{google,slack}/start, GET /oauth/{google,slack}/callback.
Start carries Clerk bearer token; resolves user, generates state + PKCE verifier, persists expiring oauthStates row, returns authorize URL. Callbacks atomically consume state before exchanging code. `returnTo` restricted to configured origins/relative paths.

Connection identity:
- Gmail: authenticated Gmail address as `externalAccountId`; reject reconnect returning a different account. (Production follow-up: store Google's immutable `sub`.)
- Slack: `externalAccountId = team.id + ":" + authed_user.id`.
- Upsert by `(userId, provider, externalAccountId)`; reconnect preserves connectionId. Different account during reconnect rejected with "add as another account."

Token lifecycle:
- AES-256-GCM encrypted tokens. Add a versioned ciphertext envelope with authenticated context so ciphertext cannot be swapped between connections.
- Refresh before expiry with safety window. Atomic refresh lease/version in `connections` so simultaneous workers don't rotate the same token twice.
- Preserve old Google refresh token when Google omits a replacement.
- Support Slack token rotation, persist replacement refresh token atomically.
- `invalid_grant`/`token_revoked` → needs_reconnect; never repeatedly refresh them.

### Search fan-out
startSearch mutation creates search + one searchSource per enabled connection + one web searchSource, schedules every worker atomically (`ctx.scheduler.runAfter(0)` from a mutation is atomic; scheduled actions are at-most-once).
Each worker: atomically mark running + increment attemptCount → get token → call registry adapter → validate/normalize → commit that worker's results + terminal status immediately. Transient errors persist and atomically schedule next attempt with full-jitter backoff (no sleeping in actions; every retry visible in history). Permanent/reconnect settle immediately.

Two orderings: live UI = arrival order; final/API = stored merge score via score index. Public result stays exactly the 7-field Result. A separate ReplyResolver resolves Gmail message ID / composite Slack locator when creating a draft (routing data stays out of the Result contract).

### Adapter registry
`Record<Source, SearchAdapter>`; orchestrator imports only registry + fixed interface. Slack search.messages requires a user token (xoxp) with search:read; bot tokens cannot.

### Safe-send state machine
Two-step REST: POST /drafts, POST /drafts/{id}/send. /drafts returns draft + digest of canonical payload shown for review. /send requires:
```json
{ "idempotency_key": "…", "confirm": true, "confirmation_hash": "…", "acknowledged_destination": "recipient@example.com" }
```
Confirmation hash covers: schema/version marker, draft ID + revision, channel + connection, recipient, subject, body, thread/reply ids, idempotency key. Any edit clears confirmation and increments revision.

Send claim = one Convex mutation: authenticate → load owned draft → recompute/validate hash + acknowledged destination → query sends by (userId, idempotencyKey) → if exists return unchanged → same key with different draft/payload = 409 Conflict → insert frozen send row + schedule exactly one worker in the same transaction.

Worker atomically claims queued/approved-retry state as in_flight, creates sendAttempt, calls provider once. Repeated /send never creates another attempt.

#### Unknown provider outcomes
- Explicit 429/5xx → transient (backoff). Explicit invalid recipient/quota/policy → permanent. Explicit revoked → needs reconnect.
- Timeout, connection loss during POST, worker crash after dispatch, stale in_flight → `unknown`.
- `unknown` is terminal for that idempotency key. /send and operator retry return the existing unknown result without dispatching again.
- Recovery: Gmail — deterministic RFC Message-ID derived from send/key; search Sent Mail for it (found = succeeded; not found ≠ proof to retry). Slack — deterministic client_msg_id where supported (not a documented exactly-once guarantee). Cron marks stale in_flight sends unknown. Operator who verifies no delivery creates a NEW draft/key. The system never silently converts an unknown send into another provider call. Gmail's send API exposes no application idempotency key — say so honestly.

### REST API
POST /api/v1/searches (202 + id), GET /searches/{id}, GET /searches/{id}/results, POST /searches/{id}/retry (rerun as new recorded search), POST /drafts, GET /drafts/{id} (exact review payload), POST /drafts/{id}/send, GET /sends/{id} (outcome + attempts), POST /sends/{id}/retry (eligible failed states only). API key CRUD stays Clerk-authenticated Convex functions (no API-key self-escalation). Exact `http.route` for static paths, `pathPrefix` for ID-bearing paths.

## 2. Files
Schema: add connections.enabled, refresh lease/version fields, searches.archived, arrival sequencing, searchSources.nextRetryAt + worker timestamps, indexes (history/ranked results/stale sends/retries), draft revision, deterministic provider request/message ID on sends. convex.config.ts (typed env). core/crypto (versioned AES-GCM envelope, canonical confirmation hash). core/http (shared provider parsing, Retry-After, redacted errors). oauth/{google,slack,state,tokens}.ts, connections.ts. adapters/{slack,web,registry}. searches.ts, workers/search.ts. drafts.ts, sends.ts, workers/send.ts, crons.ts (stale in-flight → unknown; stale search workers). apiKeys.ts, rest/{auth,searches,drafts,responses}.ts. seed.ts (idempotent, every status, isSeed). UI: useInbox.ts replaces mock hook; key runs by run ID not just source; mount providers.

## 3. Services/keys/env
Google: GCP project, Gmail API, consent screen (Testing) + test users, Web OAuth client, callbacks on convex.site. Scopes: openid, email, gmail.readonly, gmail.send. Vars: GOOGLE_OAUTH_CLIENT_ID/SECRET.
Slack: app w/ OAuth V2, both callback URLs, user_scope: search:read, chat:write — store authed_user.access_token, not bot token. Enable token rotation. Vars: SLACK_CLIENT_ID/SECRET. No signing secret/bot scopes needed.
Web: Brave Search API (X-Subscription-Token). Var: BRAVE_SEARCH_API_KEY; else clearly-labeled deterministic mock.
Clerk/Convex/Vercel: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, CONVEX_DEPLOYMENT, NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CONVEX_SITE_URL; Convex: CLERK_JWT_ISSUER_DOMAIN, CLERK_WEBHOOK_SIGNING_SECRET, TOKEN_ENCRYPTION_KEY, GOOGLE_OAUTH_*, SLACK_*, BRAVE_SEARCH_API_KEY, APP_ORIGINS, OAUTH_CALLBACK_BASE_URL, ALLOW_FAULT_INJECTION.
Accounts: Clerk app, Convex envs, Vercel, GCP OAuth project, Slack app + test workspaces, Brave subscription, throwaway Gmail sender/recipient + Slack workspace/channel.

## 4. Testing (convex-test + vitest)
- Two simultaneous confirmed sends, one key → one send, one attempt, one scheduled worker, one provider call.
- Repeating /send before dispatch / in flight / after success / after failure → same send.
- Same key, changed payload → 409. Edit after review invalidates hash. Raw one-shot send impossible.
- Timeout after dispatch → unknown, never auto-retried. Operator retry rejected for unknown.
- 503 schedules backoff; permanent/reconnect don't.
- Slow web worker stays running while Gmail results are queryable. Multiple Gmail accounts create separate source runs.
- Fixtures conform to exact Result shape. token_revoked / invalid_grant update connection + source run. Reconnect preserves connection ID.
- OAuth state expiring, single-use, provider-bound, rejects account swapping. Concurrent refresh → one lease.
- API keys can't cross user boundaries; revoked keys fail immediately. Seed idempotent, all isSeed.

## 5. Risks
- Absolute exactly-once cannot be proved across Convex + providers without provider idempotency; terminal `unknown` is the safe answer.
- Gmail restricted scopes: test-mode reviewers must be allowlisted.
- Slack search reflects the installing user's visibility, not a workspace index. Rate limits require bounded result counts + backoff.
- "Full error" = full relevant provider payload after redacting tokens/headers/oversized HTML.
- Multi-account runs need small UI key/view-model adjustments (no redesign).
- Seed connections cannot contain usable OAuth tokens; visibly labeled.
- Codespaces frontend URLs vary; keep the stable OAuth callback on convex.site with allowlisted return origins.
- Search Result alone lacks reply routing data; resolve reply metadata via provider registry at draft time.

## 6. Order
1 Schema+test harness → 2 OAuth+tokens → 3 Search core → 4 UI search wiring → 5 Safe-send core (idempotency tests before broader UI) → 6 Compose/history UI → 7 REST+API keys → 8 Seed+failure demos+ops → 9 Deploy+docs.
