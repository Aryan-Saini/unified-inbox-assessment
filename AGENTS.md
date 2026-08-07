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

## Branches

Work on `staging` and reach `main` through a **pull request** — no direct pushes
to `main`. `main` is what gets built and deployed, so it is the one branch where
a change should have been looked at once before it lands.

## The frontend deploy is manual

`vercel.json` sets `git.deploymentEnabled: false`, so **pushing to GitHub deploys
nothing**. The frontend ships by building locally and uploading that build:

```bash
pnpm deploy:vercel   # scripts/deploy-vercel.mjs: pull, build --prod, deploy --prebuilt --prod
```

It is pinned to the `personal` Vercel account, because that is the only account
this project belongs to and picking the wrong one fails silently — it succeeds
and puts the app on a URL nobody is looking at.

The script pulls the production environment before building, and that pull is not
a formality. `NEXT_PUBLIC_*` values are **inlined into the bundle at build time**,
so the machine doing the build has to hold them — which used to be a Vercel
builder and is now this one. Without the pull, `next build` falls back to
`.env.local`, which points at the *dev* Convex deployment, and the deployed app
talks to the wrong backend while looking perfectly healthy.

That is why `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL` and
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are stored **plain** on the Vercel project
rather than sensitive: a sensitive variable is never handed back, so it pulls as
an empty string and the build inlines nothing. All three are public by
construction — they ship inside the bundle to every visitor. `CLERK_SECRET_KEY`
and friends stay sensitive; the server reads those at runtime and they never
reach this machine. The script fails loudly if any of the three pulls empty.

Two reasons it works this way. A push should be free — `staging` gets pushed
often and mid-change, and none of those pushes are a deliverable. And the thing a
reviewer opens should be a build somebody watched succeed, not one that a CI
runner did on their behalf while nobody was looking.

`main` is the production branch, so that is what gets built and deployed. The
Convex side is separate and unaffected: `pnpm deploy:handin` still pushes
`convex/` to the hand-in deployment, and it has to be done as well.

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
