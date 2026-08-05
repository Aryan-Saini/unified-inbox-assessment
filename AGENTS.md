<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# What this project is

A take-home assessment: search Gmail, Slack and the web from one place, and send
replies only after an explicit confirm step. The adapter layer and the safe-send
gate are the centerpiece — a standalone module with the UI as a pure consumer.

Full brief in [`assessment-unified-inbox.pdf`](assessment-unified-inbox.pdf) —
read it before changing an interface, an endpoint path or a `Result` field.

Stack: Next.js 16 (App Router, Turbopack) + Tailwind 4, Convex backend, Clerk
auth, pnpm, TypeScript — and **never leave an `any`** in committed code.

## Convex deployments (environments)

Exactly two, and neither is a production system — the frontend is run locally
against one or the other in normal work:

| Environment | Convex deployment | Notes |
|---|---|---|
| **dev** | `judicious-wildcat-326` | Day-to-day. `npx convex dev` pushes `convex/` on save and must stay running while developing. |
| **hand-in** (`prod`) | `scintillating-moose-307` | **The deployment being submitted** — what the graded deployed URL and its real Gmail/Slack OAuth point at. Push with `pnpm deploy:handin`; `pnpm dev:handin` runs Next locally against it. |

Convex only has the deployment *types* `dev` and `prod`, so the hand-in
deployment **is** the `prod` one and `--prod` targets it. That makes it Convex's
production tier, not a production application.

Treat the hand-in deployment as the deliverable: it must stay current with `main`
and keep working real OAuth credentials, because a reviewer exercises it directly.
Nothing else depends on it, so it is not "protected" — just don't leave it stale
or half-migrated.

## Environment variables

Two separate places, and mixing them up is the usual cause of a confusing failure:

- **`.env.local` is read by Next.js only** — Clerk keys plus the `CONVEX_*` URLs
  that `npx convex dev` writes for you.
- **Everything the backend needs is set on the Convex deployment**, with
  `npx convex env set <NAME> <value>` (add `--prod` for hand-in). Per-deployment
  by design: `TOKEN_ENCRYPTION_KEY` and `CLERK_WEBHOOK_SIGNING_SECRET` must
  differ between the two.

`CONVEX_SITE_URL` is injected by Convex itself and is what the OAuth redirect
URIs are derived from, so they cannot drift between deployments. The full
variable list with purposes lives in the README and [`.env.example`](.env.example)
— keep all three in sync when a variable changes.
