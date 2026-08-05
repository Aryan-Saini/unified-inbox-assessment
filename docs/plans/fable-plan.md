# Fable plan — Unified Inbox backend

Premise: the schema and core module already committed are good; build on them, don't redesign. UI stays as-is; wire it via a drop-in replacement for `useMockSearch`.

## 1. Architecture

**Everything in Convex.** Adapters + send gate live entirely in `convex/` as the standalone module; the REST API is the Convex HTTP router (`https://<slug>.convex.site/api/v1/...`); the Next.js UI is a pure consumer via Convex reactive queries (and the REST API works with no UI present).

**OAuth (Convex HTTP actions).**
- Routes: `GET /oauth/:provider/start` and `GET /oauth/:provider/callback` on the Convex HTTP router.
- `start`: authenticated via a short-lived signed handoff (the browser hits a Next route or carries the Convex auth token), creates an `oauthStates` row (state, PKCE verifier for Google, optional `reconnectConnectionId`, `returnTo`), 302 to provider consent.
- `callback`: validates + consumes state (single use, expiry), exchanges code, fetches identity (Google `userinfo` / Slack `auth.test` or the token response's `authed_user`+`team`), encrypts tokens with `core/crypto`, **upserts connection on `(userId, provider, externalAccountId)`** so reconnect preserves `_id` and dependent state, sets status `active`, redirects to `returnTo`.
- Reconnect = same start route with `reconnectConnectionId`; identity mismatch on callback (reconnected as a different account) is surfaced as an error, not a silent new connection.

**Token lifecycle (lazy refresh at point of use).**
- A `core/tokens.ts` helper `getFreshAccessToken(connection)`: if `tokenExpiresAt` within ~2 min, refresh (Google refresh_token grant; Slack rotation only if enabled — plain xoxp tokens don't expire), re-encrypt, patch row, bump `lastRefreshedAt`.
- Refresh failure with `invalid_grant` / `token_revoked` → connection status `expired`/`revoked` + `statusReason`, and the calling operation lands in `needs_reconnect`. No background refresh cron needed for the POC (lazy is simpler and sufficient); optional cron is a stretch goal.

**Unified search fan-out (Convex scheduler = background workers).**
- `searches.run` (mutation): create `searches` row + one `searchSources` row per enabled source (status `pending`), then `ctx.scheduler.runAfter(0, internal.search.worker.runSource, {...})` per source — each source is an independent scheduled action, so a slow one cannot block a fast one.
- Worker action: mark `running`, resolve token (lazy refresh), call adapter through `retryTransient` (already written), insert `searchResults` rows with a rank score, mark source `succeeded/failed/needs_reconnect` with errorKind/message/attemptCount/duration. Last source to settle flips the search to `complete` (done in a mutation, race-safe).
- Partial results streaming = the UI subscribes to `searchSources` + `searchResults` by `searchId`; rows appear as workers land. No SSE/websocket work needed — Convex reactivity is the stream.
- Adapter registry: `convex/adapters/registry.ts` maps source → adapter/sender; the orchestrator only knows the registry.

**Send gate (the most-scrutinized part).**
- `drafts.create` (mutation): validates connection ownership + channel, generates `idempotency_key` if absent; if a draft with `(userId, idempotencyKey)` exists, return it.
- `drafts.confirm` (mutation): stores `confirmationHash = sha256(channel|connectionId|to|subject|body)` — the exact payload shown to the user — and status `confirmed`.
- `sends.claim` (mutation — the idempotency core): requires a `confirmed` draft whose current content matches `confirmationHash` (confirm-then-mutate is refused). Look up `sends` by `(userId, idempotencyKey)`: if a send exists → **return it unchanged** (this is what makes double-tap/retry safe). Else insert a `sends` row with payload frozen from the draft, status `queued`, and schedule the delivery action. Convex mutations are serializable transactions, so concurrent claims cannot both insert.
- Delivery action loop: mutation transitions `queued → in_flight` + opens a `sendAttempts` row; action calls the provider sender; a follow-up mutation records the outcome:
  - success → `succeeded` + providerMessageId
  - transient → if attempts < maxAttempts schedule retry at `backoffMs(attempt)` (full jitter), else `failed_transient`
  - permanent → `failed_permanent`, no auto-retry
  - needs_reconnect → `needs_reconnect` + flip connection status
  - crash/timeout after dispatch with no provider confirmation → `unknown`, **never auto-retried** (blind retry is the double-send); operator may manually retry with an explicit warning.
- Operator retry (`sends.retry`): allowed from `failed_*`/`needs_reconnect`/`unknown`, records attempt with trigger `manual`.
- Confirm friction: there is no mutation or HTTP route that goes from text → provider in one step; `send` only accepts a draft id whose confirmed hash matches.

**REST API (Convex HTTP router, `/api/v1`).**
- Auth: `Authorization: Bearer uik_...` → sha256 → `apiKeys.by_hash` (+ timingSafeEqual), scoped to that key's user. Key management: mutation + small settings UI; plaintext shown once.
- Routes: `POST /search`, `GET /searches/{id}` (status + sources), `GET /searches/{id}/results` (normalized Result[]), `POST /drafts`, `POST /drafts/{id}/confirm`, `POST /drafts/{id}/send`, `POST /sends/{id}/retry`, `GET /sends/{id}`, `GET /connections`, `GET /history`.
- `POST /search` returns the searchId immediately; the client polls GET (async fan-out preserved). Documented in README with curl examples.

**Adapters to write.**
- Slack (`convex/adapters/slack.ts`): `search.messages` (requires **user token xoxp** with `search:read`), normalize matches (permalink, channel, user, ts→ISO). Sender: `chat.postMessage` with user token (`chat:write`). Detect `{ok:false, error}` on HTTP 200: `token_revoked`/`invalid_auth`/`account_inactive` → needs_reconnect; `ratelimited` → transient; `channel_not_found`/`not_in_channel` → permanent.
- Web (`convex/adapters/web.ts`): **Brave Search API** (simple key, free tier) with a clearly-labeled mock fallback when no key is set (README documents the choice).

**Seed + demo.**
- `convex/seed.ts` internalMutation, run via `npx convex run seed:default` (and/or a settings-panel button): connections, searches, sends in every status, all `isSeed: true` (UI already badges seed rows).
- Demo/fault panel: wire the existing SettingsDialog demo toggles to real params — `artificialDelayMs` on web, `injectFailure` on sends — gated by `ALLOW_FAULT_INJECTION`.

**UI glue (no redesign).**
- `useSearch` hook with the same return shape as `useMockSearch` (documented as a one-file swap), backed by `searches.run` + subscriptions.
- ConnectionsDialog → `connections.list` + connect/reconnect URLs + enable toggle (needs an `enabled` field added to connections schema — small addition).
- ComposeDialog → drafts create/confirm/send mutations; history sidebar → `searches.list`/`sends.list`.

## 2. Files
- `convex/core/tokens.ts` (refresh), `convex/adapters/{slack,web,registry}.ts`
- `convex/oauth/{google,slack,shared}.ts` + routes in `convex/http.ts`
- `convex/search.ts` (run/list/get queries+mutations), `convex/searchWorker.ts` (actions)
- `convex/drafts.ts`, `convex/sends.ts`, `convex/sendWorker.ts`
- `convex/apiKeys.ts`, `convex/api/v1.ts` (HTTP handlers), `convex/connections.ts`
- `convex/seed.ts`
- Tests: `convex/*.test.ts` (idempotency incl. concurrent claims, fan-out non-blocking, normalization fixtures, revoked→reconnect, error classification, crypto roundtrip) + `vitest.config.ts`
- `app/(inbox)/useSearch.ts` + wiring edits; README rewrite; `.devcontainer` for Codespaces.

## 3. Keys / env
Convex env (`npx convex env set`): `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET`, `BRAVE_SEARCH_API_KEY` (optional → mock), `CLERK_WEBHOOK_SIGNING_SECRET` (already set), `ALLOW_FAULT_INJECTION=true`, `APP_ORIGIN`.
Frontend `.env.local`: `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
From Aryan: Google Cloud OAuth client (consent screen in Testing + test Gmail accounts), Slack app in a throwaway workspace (user-token scopes `search:read`, `chat:write` + identity), Brave Search API key (optional), Vercel project for deploy.

## 4. Tests (convex-test + vitest + @edge-runtime/vm per guidelines)
Idempotent send is the flagship: same key twice → one `sends` row, second call returns identical result; concurrent claims → one row. Provider calls faked at the adapter/sender boundary (registry injection or fetch stub).

## 5. Risks
- Slack `search.messages` needs a paid-plan? (No — available on free plan but only user tokens; confirm.) Slack app review not needed for own workspace installs.
- Google testing-mode refresh tokens expire after 7 days? (Only for `prompt=consent` in testing mode — acceptable for assessment; document.)
- Convex HTTP action auth for OAuth start (Clerk JWT on a browser redirect) — solved by starting from an authenticated Next route or passing the Convex token via cookie/query handoff.
- `unknown` outcome semantics must be tested explicitly.

## 6. Order
1) OAuth + connections + tokens (Google, then Slack) 2) adapters (slack, web) + registry 3) fan-out orchestrator + UI search wiring 4) send gate + compose wiring 5) REST API + api keys 6) history wiring + seed + fault injection 7) tests throughout, README, Codespaces, deploy.
