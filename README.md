# Unified Inbox

Search Gmail, Slack and the web from one place, and send replies only after an
explicit confirmation step.

> **Status:** auth foundation. Clerk (identity) and Convex (backend + database)
> are wired end to end. The provider adapters, the safe-send gate and the REST
> API are not built yet.

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

Sign in on `/`. The **Auth status** panel calls the `users.viewer` Convex query
and shows the Clerk user id resolved *by Convex*, not by the browser. If it
reports "authenticated in Clerk but Convex saw no identity", the `aud` claim or
`CLERK_JWT_ISSUER_DOMAIN` on the Convex deployment is wrong.

## Not built yet

Provider adapters (Gmail / Slack / web), the draft → review → confirm send gate
with idempotency keys, connection management with silent refresh and reconnect,
the per-user API-key REST API, history, seed data, and tests.
