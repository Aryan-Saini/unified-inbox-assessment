# Unified Inbox backend — FINAL PLAN
Merged from three independent plans (Fable 5, Opus 5, GPT 5.6 Sol) plus a cross-critique round. Disagreements adjudicated below. Companion files: fable-plan.md, opus-plan.md, sol-plan.md.

## 0. Ground rules
- Existing UI is untouched in design/components; only prop-level wiring plus ONE new additive surface (Outbox, §6) required by success criterion 7.
- The Clerk webhook + user sync (convex/http.ts webhook route, convex/clerk.ts) is load-bearing and MUST keep working; the `users` table may be reshaped if a change earns it, but `clerkUserId` remains the join key the webhook writes.
- The rest of the existing scaffolding (schema, core/*, adapters/gmail.ts) is NOT a constraint — implementers may modify or replace it freely. In practice it survived three independent plan reviews, so the default is to build on it and change it where the critiques demand (AEAD envelope, schema fields, etc.) rather than rewrite for its own sake.
- Adapters + send gate live entirely in Convex = the standalone module; UI and REST are two thin consumers.

## 1. Architecture (settled decisions)

### OAuth
- **Start = authenticated Convex mutation** `api.oauth.begin({provider, reconnectConnectionId?, returnTo})` → creates `oauthStates` row (state, PKCE S256 verifier for Google, expiry), returns authorize URL; browser navigates. No JWT ever rides a URL. *(unanimous after critique)*
- **Callback = Convex httpAction** at `https://<slug>.convex.site/oauth/{google,slack}/callback`: atomically consume state (single-use, expiring, **provider-bound**), exchange code, fetch identity, encrypt, upsert on `(userId, provider, externalAccountId)` — reconnect preserves `_id` and all dependent state. Reconnect-as-different-account → explicit rejection ("add as another account"). `returnTo` allowlisted to a path under `APP_BASE_URL`.
- Gmail identity = email (documented tradeoff vs `sub`); Slack = `team.id:authed_user.id`. Google: `access_type=offline` **and `prompt=consent` on every auth** (else re-grants return no refresh token); keep the existing refresh token if an exchange omits one; `login_hint` on reconnect. Testing-mode refresh tokens expire after **7 days for all testing apps** — documented, and it makes reconnect a routinely demonstrable feature.

### Tokens
- AES-256-GCM (existing crypto) upgraded to a **versioned AEAD envelope with AAD = `v1|provider|connectionId|tokenType`** so ciphertext can't be swapped between rows. *(Sol)*
- **Refresh-on-use with a single-flight lease** (`refreshLockedUntil`); losers do a bounded re-read (250ms × 3) then surface transient. 120s expiry skew window. `invalid_grant`/`token_revoked` → connection `revoked` + verbatim reason + `needs_reconnect`. No refresh cron.
- Slack token rotation left **disabled**; refresh branch written and gated. *(Opus, upheld)*

### Search fan-out
- `searches.run` mutation inserts search + one `searchSources` row **per enabled connection** (+ web), schedules **one independent Convex action per source-connection** (`runAfter(0)`) — the "independent background workers". Slow can't block fast by construction.
- Worker: begin (running, attempt++) → resolveToken → adapter via retryTransient (3 attempts, jitter; every attempt recorded) with 20s AbortSignal + demo `artificialDelayMs` → **one mutation** commits results + terminal status + sibling-completion check (no flicker).
- **`sweepSearch` watchdog** scheduled at deadline + 5-min cron backstop: UI can never spin forever. *(Opus, adopted by Sol)*
- Partial results = one reactive query `searches.watch` → `{search, sources[], results[]}`. Ordering: arrival order in the live UI (append, never re-sort; explicit **`seq` field** — `_creationTime` ties aren't ordered *(Sol)*); write-time `score`; REST offers `?order=rank|arrival` (default rank).
- Registry `Record<Source, EnrichedAdapter>`; adapters may attach extras (externalId, threadId, replyTo, context, unread) stored as columns and **stripped by the REST projection** — the public `Result` stays exactly the spec's 7 fields. Adding a source = one file + one registry line.

### Send gate
- Draft → confirm → send; **no recipient+body one-shot path anywhere** (guarded by a public-function-list snapshot test).
- `drafts`: **revision counter** incremented on every edit; `canonicalPayload` includes a schema-version marker + revision (fixes the edit A→B→A stale-confirmation hole). *(Sol)* Confirm requires `reviewedHash` obtainable only from the `reviewPayload` query. Any edit clears confirmation.
- **`sends.claim`** — one mutation: validate confirmed + hash match, indexed `.unique()` read on `sends.by_user_idempotency_key`, existing → return unchanged; **same key + different payload → 409**; else insert frozen send + schedule delivery in the same transaction. Race-safe via Convex serializable OCC (indexed range read + insert in one mutation).
- REST `POST /drafts/{id}/send` additionally requires **`acknowledged_destination`** echoing the recipient verbatim (confirm friction exists in the API too, per criterion 4). *(Sol)* Response: bounded ~5s poll for a settled result, else 202 + status URL (compromise: reviewer ergonomics for criterion 3 vs not holding requests).
- Delivery: begin-attempt lease (in_flight = no-op; succeeded = skip; **unknown = terminal for the key, never auto- or manually retried**) → provider send → outcome mutation. transient: backoff retries to maxAttempts=4 then operator decides; permanent: immediate, no retry; needs_reconnect: flips connection, **draft stays confirmed** so reconnect-then-retry reuses the same key; unknown: cron sweeps stale in_flight → unknown.
- Unknown recovery: **Reconcile (reads only)** — Gmail deterministic Message-ID derived from the key (`rfc822msgid:` search), Slack history scan; or **Send anyway = clone draft with a NEW key**. Providers offer no server-side idempotency on send; the claim row is the guarantee — stated plainly in README.
- Errors stored **redacted** (no tokens/headers, capped bodies) but otherwise full, per "full error" with honesty.

### REST API (`/api/v1` on convex.site + bare `/drafts`, `/drafts/{id}/send` aliases per spec)
- Auth `Bearer uik_…` → sha256 → by_hash + timingSafeEqual; cross-user = 404. **API-key CRUD is Clerk-auth only** (no self-escalation). *(Sol)*
- Routes: POST/GET searches, GET searches/{id}, GET searches/{id}/results (exact-7-field projection, tested), POST searches/{id}/rerun (**creates a new search with `rerunOf`**), POST drafts, GET drafts/{id}, POST drafts/{id}/confirm, POST drafts/{id}/send, GET sends (outbox), GET sends/{id} (+attempts), POST sends/{id}/retry, GET connections. CORS + OPTIONS.
- **Rate limiting** via `@convex-dev/rate-limiter` on searches.run and REST mutations (a leaked key must not burn Gmail quota unbounded).
- Committed **`docs/api-walkthrough.sh`**: curl-only search→results→draft→confirm→send→double-send→retry.

### Ops / lifecycle
- Disconnect = soft-delete (status revoked, row kept — `drafts.connectionId` stays valid). Clerk `user.deleted` → cascade job deletes connections/tokens (no orphaned token vault).
- Crons: stale in_flight → unknown (1m), stuck searches (5m), oauthStates GC (1h).
- Seed: **authed public mutation behind a Settings button** (reviewer-runnable), per-user scoped; connections/searches/drafts in all statuses, sends in all 7, realistic attempt timelines; `resolveToken` refuses `isSeed` rows; reset deletes own seed only.
- Fault injection (existing `core/faults.ts`, `ALLOW_FAULT_INJECTION`): demo panel wires artificial delay + injectFailure; `connections.simulateRevoke` for criterion 5 on camera.

## 2. UI work (additive only)
- `useSearch.ts` drop-in for `useMockSearch` (identical return tuple); aggregates per-connection rows to per-source runs (worst-status-wins, "2 accounts" labels).
- Wire ConnectorSwitchboard/ConnectionsDialog (oauth.begin, setEnabled, reconnect), ComposeDialog (create/reviewPayload/confirm/send; deduped = !claimed), SettingsDialog (connections, API keys shown once, demo panel, seed button), sidebar history (live, rerun creates new search).
- **NEW: Outbox surface** — sends list + send-detail drawer (payload, recipient, outcome, attempt timeline, full redacted error, operator Retry / Reconcile / Clone-with-new-key). Mobile-first; this is criterion 7 and was missing from all three original plans.
- Mobile acceptance matrix (connections / search / compose / confirm / history at phone widths) checked before demo.

## 3. Schema changes (additive)
`connections.enabled`, `connections.refreshLockedUntil`, `searches.archivedAt`, `searchResults.{seq, replyTo, context, unread}`, `drafts.revision`, `drafts/sends.injectFailure`, envelope version prefix in cipher format. Typed env via `convex.config.ts`.

## 4. Web search
**Tavily** (free 1k/mo, no card) default when key present; **deterministic labeled mock** (`[mock]`-prefixed titles) auto-fallback when unset — fresh Codespace works with zero signups. Brave documented as drop-in alternative. Web results may omit `timestamp` (schema anticipates).

## 5. Slack specifics
User token (xoxp) only — `search.messages` requires it. **Narrow user scopes: `search:read`, `chat:write`, `users:read`** (history scopes only if the reconciliation fallback ships). App from a manifest in the README; install into throwaway workspace. HTTP-200 `{ok:false,error}` classification map (token_revoked→reconnect, ratelimited→transient +Retry-After, channel_not_found→permanent, unrecognized→permanent). `ts` is seconds.micros — ×1000 (regression test). Day-1 curl check of search.messages availability; conversations.history fallback pre-designed behind the same interface.

## 6. Tests (convex-test + vitest + @edge-runtime/vm)
fakeProviders fetch-router with call recorder. Files: **sends.idempotency ⭐** (double-send → 1 provider call; concurrent → one claimed; retry-after-success → 0 calls; same-key-different-payload → 409; in_flight no-op), orchestrator.fanout (deferred web; fast results readable while slow runs; arrival order), normalization (exact Result shape; Slack ts year; REST exact key set), reconnect (invalid_grant / 200 ok:false → needs_reconnect + revoked, 0 wasted calls; upsert preserves _id; same-key send succeeds after reconnect), sends.failures (503 backoff → 4 attempts; 400 → 1 attempt permanent; timeout → unknown; retry-on-unknown refused; sweeper), confirmFriction (unconfirmed/edited claims refused; API 409; function-list snapshot; acknowledged_destination mismatch), apiKeys (401s, cross-user 404, digest-only), crypto (round-trip, tamper throws, AAD swap fails), canonical (stability, revision).
Plus **`scripts/double-tap.ts`** against the DEPLOYED API — N parallel sends, assert one delivery **verified in the actual recipient inbox/channel**, N identical bodies. convex-test OCC caveat stated honestly in README.

## 7. Success-criteria traceability
1. Concurrent fan-out w/ partial results → per-connection scheduled actions + reactive watch + demo delay; fanout test.
2. Normalization → toPublicResult exact-7-field projection; normalization test.
3. Idempotent send → sends.claim single-mutation indexed unique read; idempotency test + deployed double-tap w/ recipient verification.
4. Confirm friction → reviewPayload→confirm(hash+revision)→send(+acknowledged_destination); no one-shot path; friction test + function-list snapshot.
5. Revoked grant → reconnect → classified needs_reconnect end to end; upsert-preserving reconnect; simulateRevoke demo; reconnect test.
6. Transient vs permanent → errorKind taxonomy stored, backoff only for transient, injectFailure demo; failures test.
7. History fidelity → searches sidebar + NEW Outbox detail (attempts, full error, operator retry); seed covers every status.
Quality bar: standalone module (Convex core + two thin shells; api-walkthrough.sh proves UI-free operation), mobile (existing responsive UI + new Outbox mobile-first + acceptance matrix), tests (§6), seed (badged, per-user, one click), README (architecture, setup, OAuth, web-search choice, seeding, tests, Codespaces + devcontainer + smoke test), deployed URL (Vercel + Convex prod, real OAuth).

## 8. Execution phases (~7 days; compression levers: drop reconciliation flourish, mock-only web, trim seed; NEVER compress tests)
0. Bootstrap (0.5d): curl search.messages; GCP + Slack app + Tavily; env vars; schema fields; vitest green.
1. OAuth + connections (1d). 2. Fan-out + adapters + useSearch (1.5d). 3. Send gate + compose wiring (1d). 4. Tests + double-tap (1d) ⭐. 5. REST + API keys + seed + Outbox surface (1.5d). 6. Deploy + README + devcontainer + demo outline + recording (1d).

## 9. Implementation staffing (per Aryan's model policy)
- Opus 5 (Medium): backend core — phases 1–3 (bulk, clear-spec, intelligence 9).
- Sol / GPT 5.6 (Medium, codex-implementation, worktree isolation): tests + fakeProviders + double-tap script + seed (independent, adversarial by design).
- Fable (main loop): UI glue + new Outbox surface (taste), integration, final reviews.
- Reviews: Fable + Opus 5 + Sol (codex-review) on every phase's diff.
