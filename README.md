# Unified Inbox

Search Gmail, Slack and the web from one place, and send replies only after an
explicit confirmation step.

> **Status:** auth foundation plus the front end. Clerk (identity) and Convex
> (backend + database) are wired end to end, and the unified-inbox UI is built
> against local mock data. The provider adapters, the safe-send gate and the REST
> API are not built yet.

## Routes

| Route      | What it is                                                        |
| ---------- | ----------------------------------------------------------------- |
| `/`        | The unified inbox. **UI only** — driven by local mock data.        |
| `/sign-in` | The Clerk sign-in form and the Convex auth-status check.          |

Each lives in its own route group with its own root layout
(`app/(inbox)/layout.tsx`, `app/(auth)/layout.tsx`), so the inbox shell renders
without the Clerk and Convex providers.

## Stack

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | Next.js 16 (App Router, Turbopack) + Tailwind |
| Backend  | Convex (TypeScript functions, scheduler)      |
| Database | Convex                                        |
| Auth     | Clerk                                         |

## How auth is wired

```
Clerk session
  └─ JWT with aud "convex"        (default session token, or a JWT template named `convex`)
      └─ ConvexProviderWithClerk  (app/ConvexClientProvider.tsx)
          └─ Convex validates the issuer      (convex/auth.config.ts)
              └─ ctx.auth.getUserIdentity()   in every Convex function
                  └─ users table, keyed by clerkUserId
```

Notable details:

- **Next.js 16 names the middleware file `proxy.ts`**, not `middleware.ts`. It
  runs bare `clerkMiddleware()` with no route matching — Clerk now recommends
  protecting access at the resource, so pages use `<Show>` / `auth()` and every
  Convex function checks `ctx.auth.getUserIdentity()`. A missed matcher entry
  therefore cannot silently expose data.
- **`@clerk/nextjs` v7 removed `<SignedIn>`, `<SignedOut>` and `<Protect>`.**
  They are replaced by a single `<Show when="signed-in" fallback={…}>`.
- `ClerkProvider` goes **inside `<body>`**, not around `<html>`.
- `convex@1.43`'s `ConvexProviderWithClerk` uses the default Clerk session token
  when its `aud` claim is already `convex`, and otherwise falls back to fetching
  a JWT template named `convex`. Either dashboard configuration works.
- `clerkUserId` is the stable identity key. Connections, searches and drafts will
  hang off it so reconnecting an OAuth grant never orphans dependent state.

## Local setup

```bash
pnpm install
cp .env.example .env.local     # then fill in the Clerk values
npx convex dev                 # provisions the deployment, writes CONVEX_* into .env.local
pnpm dev                       # in a second terminal
```

`npx convex dev` must stay running in development — it pushes `convex/` on save.

### Clerk setup

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com)
   with Email and Google enabled.
2. Copy the **Publishable key** and **Secret key** into `.env.local`.
3. Make the session token carry `aud: "convex"` — either create a JWT template
   named exactly `convex` from Clerk's Convex preset, or set the audience on the
   Sessions page in newer dashboards.
4. Copy the **Issuer** / Frontend API URL (`https://<slug>.clerk.accounts.dev`)
   into `.env.local` as `CLERK_JWT_ISSUER_DOMAIN`.
5. Give the same value to the Convex deployment, which is a separate environment
   from Next.js:

   ```bash
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
   ```

### Environment variables

| Variable                            | Used by    | Purpose                          |
| ----------------------------------- | ---------- | -------------------------------- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Next.js    | Clerk frontend                   |
| `CLERK_SECRET_KEY`                  | Next.js    | Clerk backend                    |
| `CLERK_JWT_ISSUER_DOMAIN`           | Convex     | Validates the incoming Clerk JWT |
| `NEXT_PUBLIC_CONVEX_URL`            | Next.js    | Convex deployment URL            |
| `CONVEX_DEPLOYMENT`                 | Convex CLI | Which deployment to push to      |

## Verifying auth works

Sign in on `/sign-in`. The **Auth status** panel calls the `users.viewer` Convex query
and shows the Clerk user id resolved *by Convex*, not by the browser. If it
reports "authenticated in Clerk but Convex saw no identity", the `aud` claim or
`CLERK_JWT_ISSUER_DOMAIN` on the Convex deployment is wrong.

## The interface (UI only)

Everything under `app/(inbox)/` is presentation. It holds no network calls: the
fan-out, the results, the connections and the sends are all local state seeded
from `app/(inbox)/mock-data.ts`, and every mocked surface is badged as such in
the UI itself.

It is typed against the published contract rather than against anything
provider-specific — `app/(inbox)/types.ts` restates the `Result` and `Draft`
shapes from `convex/core/types.ts` — so wiring it to the real adapters means
replacing one hook (`useMockSearch`) with the Convex subscription and leaving the
components alone.

What it demonstrates:

- **The lift.** One search field. Idle, it sits centred with the heading above
  it; on submit it rises to the top while the heading collapses, and the result
  list fills in underneath.
- **Streaming fan-out.** Each mock adapter returns on its own clock (Gmail
  ~0.6s, Slack ~1.2s, web ~3.6s). Rows are appended in arrival order and never
  re-sorted under the reader, and the source strip says which adapters are still
  working.
- **Honest failure states.** A revoked grant renders as its own
  needs-reconnect state with a reconnect action; a rate limit renders as a
  transient failure with a retry. Neither collapses into a generic error.
- **The confirm gate.** Composing produces a draft; the primary action is
  *review*, not *send*. Review shows the source, recipient, subject, exact body
  and idempotency key, and the send button stays disabled until the recipient is
  acknowledged. After sending, "Retry with the same key" shows the delivery count
  staying at one.
- **Search history.** Runs accumulate in the collapsible sidebar, can be
  re-run, and can be archived or restored (with undo).
- **Mobile.** Every surface. Navigation is a full-screen sheet rather than a
  drawer — picking a search closes it and lands on the results.

Keyboard: `⌘K` focuses the search field, `⌘\` collapses the sidebar, `Esc`
dismisses a dialog or the mobile nav sheet.

Screenshots of each state are in [`docs/screenshots/`](docs/screenshots).

## Not built yet

Provider adapters (Gmail / Slack / web), the draft → review → confirm send gate
with idempotency keys, connection management with silent refresh and reconnect,
the per-user API-key REST API, history, seed data, and tests.
