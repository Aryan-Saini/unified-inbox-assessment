/**
 * Demo data.
 *
 * A reviewer with no Gmail account, no Slack workspace and no patience should
 * still be able to see every state this system can be in. That is what this
 * file is for: one button, one mutation, and the history sidebar, the outbox and
 * the connections panel all have something truthful to show.
 *
 * Three rules make it safe to ship:
 *
 *  1. **Every row is `isSeed: true` and scoped to the calling user.** The UI
 *     badges them as demo data, `reset` deletes only the caller's own, and no
 *     reviewer's fixtures can touch another's.
 *  2. **Seeded connections hold no grant.** Their ciphertext is the literal
 *     string `seed`, and `resolveToken` refuses `isSeed` rows before any provider
 *     call (see `convex/connections.ts`). Demo data therefore cannot spend a real
 *     API quota, not even on a failure — and they are left `enabled: false` so
 *     they never join a live fan-out and manufacture a fake error inside it.
 *  3. **Running it twice changes nothing.** The mutation looks for its own
 *     connections first and returns what already exists.
 *
 * Error text on seeded rows is prefixed `[seed]` for the same reason injected
 * faults are prefixed `[simulated]`: an operator must never have to wonder
 * whether an error in front of them really happened.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { draftDigest } from "./drafts";
import { requireUser } from "./users";

/** Marker on every seeded string a human might read. */
const SEED = "[seed]";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Seeded rows carry no real grant, so their ciphertext is a placeholder. */
const NO_GRANT = "seed";

const counts = v.object({
  connections: v.number(),
  searches: v.number(),
  results: v.number(),
  drafts: v.number(),
  sends: v.number(),
  attempts: v.number(),
});

/* ---------------------------------------------------------------- connections */

interface SeedConnections {
  activeGmail: Id<"connections">;
  expiredGmail: Id<"connections">;
  revokedSlack: Id<"connections">;
}

async function seedConnections(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<SeedConnections> {
  const base = {
    userId,
    // Off by default: a seeded account cannot answer a search, so letting the
    // broken two join a live fan-out would add failures a reviewer has to learn
    // to discount. The healthy one is switched on below, because a draft can only
    // be composed against an enabled connection and the REST walkthrough has to
    // work on a deployment with no OAuth grants at all.
    enabled: false,
    accessTokenCipher: NO_GRANT,
    isSeed: true,
    updatedAt: now,
  };

  const activeGmail = await ctx.db.insert("connections", {
    ...base,
    enabled: true,
    provider: "gmail",
    externalAccountId: "demo.inbox@example.com",
    label: "demo.inbox@example.com",
    accountEmail: "demo.inbox@example.com",
    status: "active",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    tokenExpiresAt: now + HOUR,
    createdAt: now - 9 * DAY,
    lastUsedAt: now - 12 * MINUTE,
  });

  const expiredGmail = await ctx.db.insert("connections", {
    ...base,
    provider: "gmail",
    externalAccountId: "second.demo@example.com",
    label: "second.demo@example.com",
    accountEmail: "second.demo@example.com",
    status: "expired",
    statusReason: `${SEED} The access token expired and no refresh token is stored. Reconnect the account.`,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    tokenExpiresAt: now - 2 * HOUR,
    createdAt: now - 6 * DAY,
    lastUsedAt: now - 2 * HOUR,
    lastErrorAt: now - 2 * HOUR,
  });

  const revokedSlack = await ctx.db.insert("connections", {
    ...base,
    provider: "slack",
    externalAccountId: "T0DEMO123:U0DEMO456",
    label: "Acme Demo Workspace",
    teamName: "Acme Demo Workspace",
    status: "revoked",
    statusReason: `${SEED} Slack answered 200 {"ok":false,"error":"token_revoked"} — the grant was revoked in the workspace. Reconnect to restore it.`,
    scopes: ["search:read", "chat:write", "users:read"],
    createdAt: now - 4 * DAY,
    lastUsedAt: now - 40 * MINUTE,
    lastErrorAt: now - 40 * MINUTE,
  });

  return { activeGmail, expiredGmail, revokedSlack };
}

/* ------------------------------------------------------------------- searches */

interface SeedResult {
  source: Doc<"searchResults">["source"];
  title: string;
  snippet: string;
  author?: string;
  ageMs: number;
  url: string;
  score: number;
  context?: string;
  replyTo?: string;
  unread?: boolean;
  threadId?: string;
}

interface SeedSourceRun {
  source: Doc<"searchSources">["source"];
  connectionId?: Id<"connections">;
  label: string;
  status: Doc<"searchSources">["status"];
  errorKind?: Doc<"searchSources">["errorKind"];
  errorMessage?: string;
  attemptCount: number;
  durationMs?: number;
  results?: SeedResult[];
}

interface SeedSearch {
  query: string;
  ageMs: number;
  /** `undefined` leaves the search `running` — the mid-flight fixture. */
  completedAfterMs?: number;
  runs: SeedSourceRun[];
}

async function seedSearch(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
  spec: SeedSearch,
): Promise<{ results: number }> {
  const createdAt = now - spec.ageMs;
  const total = spec.runs.reduce((sum, run) => sum + (run.results?.length ?? 0), 0);

  const searchId = await ctx.db.insert("searches", {
    userId,
    query: spec.query,
    status: spec.completedAfterMs === undefined ? "running" : "complete",
    origin: "seed",
    resultCount: total,
    isSeed: true,
    createdAt,
    completedAt:
      spec.completedAfterMs === undefined ? undefined : createdAt + spec.completedAfterMs,
  });

  let seq = 0;
  for (const run of spec.runs) {
    const results = run.results ?? [];
    const started = run.status === "pending" ? undefined : createdAt + 40;
    const finished =
      run.status === "pending" || run.status === "running"
        ? undefined
        : createdAt + 40 + (run.durationMs ?? 500);

    await ctx.db.insert("searchSources", {
      searchId,
      userId,
      source: run.source,
      connectionId: run.connectionId,
      label: run.label,
      status: run.status,
      errorKind: run.errorKind,
      errorMessage: run.errorMessage,
      attemptCount: run.attemptCount,
      resultCount: results.length,
      startedAt: started,
      finishedAt: finished,
      durationMs: finished === undefined ? undefined : run.durationMs,
    });

    for (const result of results) {
      seq += 1;
      await ctx.db.insert("searchResults", {
        searchId,
        userId,
        source: run.source,
        externalId: `${SEED}-${searchId}-${seq}`,
        title: result.title,
        snippet: result.snippet,
        author: result.author,
        timestamp: new Date(now - result.ageMs).toISOString(),
        url: result.url,
        seq,
        score: result.score,
        connectionId: run.connectionId,
        threadId: result.threadId,
        replyTo: result.replyTo,
        context: result.context,
        unread: result.unread,
      });
    }
  }

  return { results: total };
}

/** The four fan-outs: clean, one dead grant, one flaky account, one mid-flight. */
function searchSpecs(c: SeedConnections): SeedSearch[] {
  return [
    {
      query: "acme invoice",
      ageMs: 18 * MINUTE,
      completedAfterMs: 2_400,
      runs: [
        {
          source: "gmail",
          connectionId: c.activeGmail,
          label: "demo.inbox@example.com",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 820,
          results: [
            {
              source: "gmail",
              title: "Invoice INV-2041 from Acme Supply",
              snippet:
                "Attached is invoice INV-2041 for £4,280.00, due on the 30th. Reply here with a PO number and we will re-issue.",
              author: "billing@acme-supply.example",
              ageMs: 3 * HOUR,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-invoice-2041",
              score: 78,
              replyTo: "billing@acme-supply.example",
              context: "Invoices · 3 messages",
              unread: true,
              threadId: "seed-thread-invoice",
            },
            {
              source: "gmail",
              title: "Re: Acme invoice — payment terms",
              snippet:
                "We can move you to net-45 from the next billing cycle. Confirm in writing and I will update the account.",
              author: "kate@acme-supply.example",
              ageMs: 26 * HOUR,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-invoice-terms",
              score: 64,
              replyTo: "kate@acme-supply.example",
              context: "Invoices · 3 messages",
              threadId: "seed-thread-invoice",
            },
            {
              source: "gmail",
              title: "Statement — 3 open invoices",
              snippet:
                "Your account shows INV-2041, INV-2033 and INV-1998 outstanding, totalling £9,140.00.",
              author: "statements@acme-supply.example",
              ageMs: 4 * DAY,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-invoice-statement",
              score: 47,
              replyTo: "statements@acme-supply.example",
            },
          ],
        },
        {
          source: "slack",
          connectionId: c.revokedSlack,
          label: "Acme Demo Workspace",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 1_150,
          results: [
            {
              source: "slack",
              title: "#finance — invoice INV-2041",
              snippet:
                "priya: has anyone approved the Acme invoice? it is sitting in my queue and the due date is Friday",
              author: "priya",
              ageMs: 5 * HOUR,
              url: "https://acme-demo.slack.com/archives/C0FINANCE/p1700000000000100",
              score: 71,
              replyTo: "C0FINANCE",
              context: "#finance · 6 replies",
              threadId: "1700000000.000100",
            },
            {
              source: "slack",
              title: "#finance — PO numbers for Q3",
              snippet:
                "dev: reminder that every invoice over £1k needs a PO before it goes to payments",
              author: "dev",
              ageMs: 2 * DAY,
              url: "https://acme-demo.slack.com/archives/C0FINANCE/p1700000000000200",
              score: 52,
              replyTo: "C0FINANCE",
              context: "#finance",
            },
          ],
        },
        {
          source: "web",
          label: "Web (mock)",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 2_310,
          results: [
            {
              source: "web",
              title: "[mock] Acme Supply — invoice reference format",
              snippet:
                "Invoice numbers are issued as INV-#### and remain stable across re-issues and credit notes.",
              ageMs: 12 * DAY,
              url: "https://example.com/acme-supply/invoices",
              score: 34,
            },
            {
              source: "web",
              title: "[mock] Late payment interest, explained",
              snippet:
                "Statutory interest on a commercial invoice runs at 8% above the base rate from the day after the due date.",
              ageMs: 40 * DAY,
              url: "https://example.com/guides/late-payment",
              score: 22,
            },
          ],
        },
      ],
    },
    {
      query: "q3 roadmap",
      ageMs: 3 * HOUR,
      completedAfterMs: 3_050,
      runs: [
        {
          source: "gmail",
          connectionId: c.activeGmail,
          label: "demo.inbox@example.com",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 760,
          results: [
            {
              source: "gmail",
              title: "Q3 roadmap review — agenda",
              snippet:
                "Thursday 14:00. Bring the two-slide version; we are cutting scope, not adding it.",
              author: "sam@example.com",
              ageMs: 20 * HOUR,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-roadmap-agenda",
              score: 69,
              replyTo: "sam@example.com",
              unread: true,
            },
            {
              source: "gmail",
              title: "Re: Q3 roadmap — what is dropping",
              snippet:
                "The reporting rebuild slips to Q4. I would rather say that now than discover it in September.",
              author: "sam@example.com",
              ageMs: 2 * DAY,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-roadmap-cuts",
              score: 58,
              replyTo: "sam@example.com",
            },
          ],
        },
        {
          source: "slack",
          connectionId: c.revokedSlack,
          label: "Acme Demo Workspace",
          status: "needs_reconnect",
          attemptCount: 1,
          durationMs: 240,
          errorKind: "needs_reconnect",
          errorMessage: `${SEED} Slack returned HTTP 200 with {"ok":false,"error":"token_revoked"}. The workspace grant was revoked, so this account was skipped and no results are shown for it. Reconnect Acme Demo Workspace to include it again.`,
        },
        {
          source: "web",
          label: "Web (mock)",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 1_980,
          results: [
            {
              source: "web",
              title: "[mock] Writing a roadmap nobody argues with",
              snippet:
                "Say what you are not doing. A roadmap without exclusions is a wish list with dates on it.",
              ageMs: 90 * DAY,
              url: "https://example.com/guides/roadmaps",
              score: 28,
            },
          ],
        },
      ],
    },
    {
      query: "renewal terms",
      ageMs: 26 * HOUR,
      completedAfterMs: 21_400,
      runs: [
        {
          source: "gmail",
          connectionId: c.expiredGmail,
          label: "second.demo@example.com",
          status: "failed",
          attemptCount: 3,
          durationMs: 18_600,
          errorKind: "transient",
          errorMessage: `${SEED} gmail returned 503 Service Unavailable — {"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}. Retried 3 times with jittered backoff and gave up; the account may simply have been unlucky.`,
        },
        {
          source: "web",
          label: "Web (mock)",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 1_460,
          results: [
            {
              source: "web",
              title: "[mock] Auto-renewal clauses and notice periods",
              snippet:
                "Most annual contracts require 30 days' written notice; miss it and the term rolls in full.",
              ageMs: 200 * DAY,
              url: "https://example.com/guides/auto-renewal",
              score: 26,
            },
            {
              source: "web",
              title: "[mock] Negotiating a renewal without a threat",
              snippet:
                "Anchor on usage data rather than on leaving. Vendors discount against evidence, not annoyance.",
              ageMs: 150 * DAY,
              url: "https://example.com/guides/renewal-negotiation",
              score: 19,
            },
          ],
        },
      ],
    },
    {
      // Left `running` on purpose: this is what partial results look like. The
      // stuck-search sweeper skips seeded rows, so it stays this way.
      query: "shipping delay",
      ageMs: 90_000,
      runs: [
        {
          source: "gmail",
          connectionId: c.activeGmail,
          label: "demo.inbox@example.com",
          status: "succeeded",
          attemptCount: 1,
          durationMs: 690,
          results: [
            {
              source: "gmail",
              title: "Shipment SO-8814 delayed by two days",
              snippet:
                "The carrier has re-scheduled collection to Thursday. No action needed unless the site closes.",
              author: "logistics@example.com",
              ageMs: 50 * MINUTE,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-shipping-delay",
              score: 74,
              replyTo: "logistics@example.com",
              unread: true,
            },
            {
              source: "gmail",
              title: "Carrier notice: collection window changed",
              snippet:
                "Collection for SO-8814 now falls between 09:00 and 13:00 on Thursday. No signature required.",
              author: "notices@carrier.example",
              ageMs: 45 * MINUTE,
              url: "https://mail.google.com/mail/u/0/#inbox/seed-carrier-notice",
              score: 66,
              replyTo: "notices@carrier.example",
            },
          ],
        },
        {
          source: "web",
          label: "Web (mock)",
          status: "running",
          attemptCount: 1,
        },
      ],
    },
  ];
}

/* --------------------------------------------------------------- drafts/sends */

interface SeedAttempt {
  trigger: Doc<"sendAttempts">["trigger"];
  startedAgoMs: number;
  durationMs: number;
  outcome: Doc<"sendAttempts">["outcome"];
  errorKind?: Doc<"sendAttempts">["errorKind"];
  errorMessage?: string;
  httpStatus?: number;
  providerMessageId?: string;
}

interface SeedSend {
  status: Doc<"sends">["status"];
  attempts: SeedAttempt[];
  providerMessageId?: string;
  nextRetryInMs?: number;
  lastErrorKind?: Doc<"sends">["lastErrorKind"];
  lastErrorMessage?: string;
  completed?: boolean;
}

interface SeedDraft {
  channel: Doc<"drafts">["channel"];
  connectionId: Id<"connections">;
  to: string;
  toLabel?: string;
  subject?: string;
  body: string;
  status: Doc<"drafts">["status"];
  ageMs: number;
  /** Present when this draft has a delivery record. */
  send?: SeedSend;
}

function draftSpecs(c: SeedConnections): SeedDraft[] {
  const gmail = c.activeGmail;
  const slack = c.revokedSlack;

  return [
    /* Two drafts with no send: the two pre-delivery statuses. */
    {
      channel: "gmail",
      connectionId: gmail,
      to: "billing@acme-supply.example",
      subject: "Re: Invoice INV-2041 — PO number",
      body: "Hi — our PO for this is PO-55182. Could you re-issue INV-2041 against it?\n\nThanks.",
      status: "draft",
      ageMs: 9 * MINUTE,
    },
    {
      channel: "slack",
      connectionId: slack,
      to: "C0FINANCE",
      toLabel: "#finance",
      body: "Approved the Acme invoice — PO-55182 is on it, payments have it for Friday.",
      status: "confirmed",
      ageMs: 7 * MINUTE,
    },

    /* One draft per send status. Seven statuses, seven timelines. */
    {
      channel: "gmail",
      connectionId: gmail,
      to: "kate@acme-supply.example",
      subject: "Net-45 confirmation",
      body: "Confirming in writing: please move us to net-45 from the next cycle.",
      status: "sent",
      ageMs: 55 * MINUTE,
      send: {
        status: "succeeded",
        providerMessageId: "seed-gmail-msg-19a2f",
        attempts: [
          {
            trigger: "initial",
            startedAgoMs: 54 * MINUTE,
            durationMs: 940,
            outcome: "succeeded",
            providerMessageId: "seed-gmail-msg-19a2f",
          },
        ],
        completed: true,
      },
    },
    {
      channel: "slack",
      connectionId: slack,
      to: "C0DEALS",
      toLabel: "#deals",
      body: "Renewal call moved to Tuesday 11:00 — same link.",
      status: "sent",
      ageMs: 4 * MINUTE,
      send: {
        // Queued and never dispatched: what the outbox shows in the first second
        // of a send. No attempt row yet, because no attempt has begun.
        status: "queued",
        attempts: [],
      },
    },
    {
      channel: "gmail",
      connectionId: gmail,
      to: "sam@example.com",
      subject: "Q3 roadmap — two slides",
      body: "Attaching the cut-down version. Everything below the line is explicitly out of scope for Q3.",
      status: "sent",
      ageMs: 3 * MINUTE,
      send: {
        // Mid-attempt. `in_flight` is a lease: pressing retry on this is a no-op
        // by design, and the seeded row exists to show that state.
        status: "in_flight",
        attempts: [
          {
            trigger: "initial",
            startedAgoMs: 20_000,
            durationMs: 0,
            outcome: undefined,
          },
        ],
      },
    },
    {
      channel: "gmail",
      connectionId: gmail,
      to: "logistics@example.com",
      subject: "Re: Shipment SO-8814",
      body: "Thursday collection is fine — the site is open until 18:00.",
      status: "confirmed",
      ageMs: 30 * MINUTE,
      send: {
        // The transient story in full: three attempts, real 429 text, backoff,
        // and a fourth attempt still to come.
        status: "failed_transient",
        nextRetryInMs: 42_000,
        lastErrorKind: "transient",
        lastErrorMessage: `${SEED} gmail returned 429 Too Many Requests — {"error":{"code":429,"message":"User-rate limit exceeded.  Retry after 2024-05-14T09:31:02.000Z","errors":[{"message":"User-rate limit exceeded.  Retry after 2024-05-14T09:31:02.000Z","domain":"global","reason":"rateLimitExceeded"}],"status":"RESOURCE_EXHAUSTED"}}`,
        attempts: [
          {
            trigger: "initial",
            startedAgoMs: 26 * MINUTE,
            durationMs: 480,
            outcome: "failed",
            errorKind: "transient",
            httpStatus: 429,
            errorMessage: `${SEED} gmail returned 429 Too Many Requests — {"error":{"code":429,"message":"User-rate limit exceeded.  Retry after 2024-05-14T09:31:02.000Z","errors":[{"message":"User-rate limit exceeded.  Retry after 2024-05-14T09:31:02.000Z","domain":"global","reason":"rateLimitExceeded"}],"status":"RESOURCE_EXHAUSTED"}} — backing off before attempt 2.`,
          },
          {
            trigger: "auto",
            startedAgoMs: 25 * MINUTE,
            durationMs: 510,
            outcome: "failed",
            errorKind: "transient",
            httpStatus: 429,
            errorMessage: `${SEED} gmail returned 429 Too Many Requests — {"error":{"code":429,"message":"User-rate limit exceeded.  Retry after 2024-05-14T09:31:02.000Z","status":"RESOURCE_EXHAUSTED"}} — backing off before attempt 3.`,
          },
          {
            trigger: "auto",
            startedAgoMs: 23 * MINUTE,
            durationMs: 505,
            outcome: "failed",
            errorKind: "transient",
            httpStatus: 429,
            errorMessage: `${SEED} gmail returned 429 Too Many Requests — {"error":{"code":429,"message":"User-rate limit exceeded.  Retry after 2024-05-14T09:31:02.000Z","status":"RESOURCE_EXHAUSTED"}} — one auto-retry left.`,
          },
        ],
      },
    },
    {
      channel: "gmail",
      connectionId: gmail,
      to: "no-such-mailbox@example.invalid",
      subject: "Welcome aboard",
      body: "Great to have you — here is everything you need for Monday.",
      status: "failed",
      ageMs: 6 * HOUR,
      send: {
        status: "failed_permanent",
        lastErrorKind: "permanent",
        lastErrorMessage: `${SEED} gmail returned 400 Bad Request — {"error":{"code":400,"message":"Invalid to header","errors":[{"message":"Invalid to header","domain":"global","reason":"invalidArgument"}],"status":"INVALID_ARGUMENT"}}. The recipient address is not deliverable, so this was not retried.`,
        completed: true,
        attempts: [
          {
            trigger: "initial",
            startedAgoMs: 6 * HOUR,
            durationMs: 390,
            outcome: "failed",
            errorKind: "permanent",
            httpStatus: 400,
            errorMessage: `${SEED} gmail returned 400 Bad Request — {"error":{"code":400,"message":"Invalid to header","status":"INVALID_ARGUMENT"}}. Not retried: a malformed recipient will not become valid.`,
          },
        ],
      },
    },
    {
      channel: "slack",
      connectionId: slack,
      to: "C0FINANCE",
      toLabel: "#finance",
      body: "Payments confirmed — INV-2041 goes out Friday.",
      // Stays `confirmed`, not `failed`: reconnecting and retrying re-uses the
      // same idempotency key, which is what makes this recoverable safely.
      status: "confirmed",
      ageMs: 40 * MINUTE,
      send: {
        status: "needs_reconnect",
        lastErrorKind: "needs_reconnect",
        lastErrorMessage: `${SEED} Slack returned HTTP 200 with {"ok":false,"error":"token_revoked"}. The grant died before this message was accepted, so nothing was delivered. Reconnect Acme Demo Workspace and retry — the idempotency key is unchanged, so it cannot double-send.`,
        attempts: [
          {
            trigger: "initial",
            startedAgoMs: 40 * MINUTE,
            durationMs: 260,
            outcome: "failed",
            errorKind: "needs_reconnect",
            httpStatus: 200,
            errorMessage: `${SEED} Slack returned HTTP 200 with {"ok":false,"error":"token_revoked"} on chat.postMessage. Classified needs_reconnect, not transient: no number of retries revives a revoked token.`,
          },
        ],
      },
    },
    {
      channel: "gmail",
      connectionId: gmail,
      to: "priya@example.com",
      subject: "Contract redlines",
      body: "Redlines attached. Clause 7 is the one that matters; the rest is tidy-up.",
      status: "confirmed",
      ageMs: 2 * HOUR,
      send: {
        status: "unknown",
        lastErrorKind: "unknown",
        lastErrorMessage: `${SEED} The gmail send was cut off after 20s with no acknowledgement, so it is unknown whether priya@example.com received the message. It will not be retried automatically — reconcile against the provider, or clone the draft with a new idempotency key.`,
        completed: true,
        attempts: [
          {
            trigger: "initial",
            startedAgoMs: 2 * HOUR,
            durationMs: 20_000,
            outcome: "unknown",
            errorKind: "unknown",
            errorMessage: `${SEED} Request to gmail.users.messages.send was dispatched and then timed out after 20s. The provider may or may not have accepted it; nothing came back either way.`,
          },
        ],
      },
    },
  ];
}

async function seedDrafts(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
  specs: SeedDraft[],
): Promise<{ drafts: number; sends: number; attempts: number }> {
  let sends = 0;
  let attempts = 0;

  for (const [index, spec] of specs.entries()) {
    const createdAt = now - spec.ageMs;
    const draftId = await ctx.db.insert("drafts", {
      userId,
      channel: spec.channel,
      connectionId: spec.connectionId,
      to: spec.to,
      toLabel: spec.toLabel,
      subject: spec.subject,
      body: spec.body,
      // Deterministic and obviously seeded, so a reviewer can see the key that
      // guards the send without having to dig it out.
      idempotencyKey: `seed-${userId}-${index}`,
      status: spec.status,
      revision: 1,
      isSeed: true,
      createdAt,
      updatedAt: createdAt,
    });

    // Confirmed and sent drafts carry a real digest of their own payload, not a
    // placeholder: the confirm gate re-derives it, so a fake one would make the
    // seeded "confirmed" draft unsendable and the demo a lie.
    if (spec.status !== "draft") {
      const row = await ctx.db.get("drafts", draftId);
      if (row !== null) {
        const { hash } = await draftDigest(row);
        await ctx.db.patch("drafts", draftId, {
          confirmationHash: hash,
          confirmedAt: createdAt + 30_000,
        });
      }
    }

    if (spec.send === undefined) continue;

    const send = spec.send;
    const lastAttempt = send.attempts.at(-1);
    const updatedAt =
      lastAttempt === undefined
        ? createdAt
        : now - lastAttempt.startedAgoMs + lastAttempt.durationMs;

    const sendId = await ctx.db.insert("sends", {
      userId,
      draftId,
      idempotencyKey: `seed-${userId}-${index}`,
      channel: spec.channel,
      connectionId: spec.connectionId,
      to: spec.to,
      subject: spec.subject,
      body: spec.body,
      status: send.status,
      attemptCount: send.attempts.length,
      maxAttempts: 4,
      providerMessageId: send.providerMessageId,
      lastErrorKind: send.lastErrorKind,
      lastErrorMessage: send.lastErrorMessage,
      nextRetryAt:
        send.nextRetryInMs === undefined ? undefined : now + send.nextRetryInMs,
      isSeed: true,
      createdAt,
      updatedAt,
      completedAt: send.completed === true ? updatedAt : undefined,
    });
    sends += 1;

    for (const [i, attempt] of send.attempts.entries()) {
      const startedAt = now - attempt.startedAgoMs;
      await ctx.db.insert("sendAttempts", {
        sendId,
        userId,
        attemptNumber: i + 1,
        trigger: attempt.trigger,
        startedAt,
        finishedAt: attempt.outcome === undefined ? undefined : startedAt + attempt.durationMs,
        outcome: attempt.outcome,
        errorKind: attempt.errorKind,
        errorMessage: attempt.errorMessage,
        httpStatus: attempt.httpStatus,
        providerMessageId: attempt.providerMessageId,
      });
      attempts += 1;
    }
  }

  return { drafts: specs.length, sends, attempts };
}

/* ---------------------------------------------------------------- public API */

/**
 * Load the demo fixtures for the calling user.
 *
 * Idempotent: it looks for its own connections first, so a reviewer mashing the
 * button gets one set of demo data rather than four.
 */
export async function seedForUser(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();

  const existing = await ctx.db
    .query("connections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);

  if (existing.some((row) => row.isSeed)) {
    const searches = await ctx.db
      .query("searches")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);
    const sends = await ctx.db
      .query("sends")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);

    const seeded = searches.filter((row) => row.isSeed);
    return {
      created: false,
      counts: {
        connections: existing.filter((row) => row.isSeed).length,
        searches: seeded.length,
        results: seeded.reduce((sum, row) => sum + row.resultCount, 0),
        drafts: drafts.filter((row) => row.isSeed).length,
        sends: sends.filter((row) => row.isSeed).length,
        attempts: 0,
      },
    };
  }

  const connections = await seedConnections(ctx, userId, now);

  let results = 0;
  const specs = searchSpecs(connections);
  for (const spec of specs) {
    const outcome = await seedSearch(ctx, userId, now, spec);
    results += outcome.results;
  }

  const drafts = await seedDrafts(ctx, userId, now, draftSpecs(connections));

  return {
    created: true,
    counts: {
      connections: 3,
      searches: specs.length,
      results,
      drafts: drafts.drafts,
      sends: drafts.sends,
      attempts: drafts.attempts,
    },
  };
}

export const seed = mutation({
  args: {},
  returns: v.object({ created: v.boolean(), counts }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return await seedForUser(ctx, user._id);
  },
});

/**
 * Delete the caller's demo data, and only that.
 *
 * Real rows are never touched: every top-level delete is gated on `isSeed`, and
 * children are found through their seeded parent rather than by a flag of their
 * own, so a real search's results cannot be reached from here at all.
 */
export async function resetForUser(ctx: MutationCtx, userId: Id<"users">) {
  let deletedResults = 0;
  let deletedAttempts = 0;

  {
    const searches = (
      await ctx.db
        .query("searches")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(200)
    ).filter((row) => row.isSeed);

    for (const search of searches) {
      const sources = await ctx.db
        .query("searchSources")
        .withIndex("by_search", (q) => q.eq("searchId", search._id))
        .take(50);
      for (const row of sources) await ctx.db.delete("searchSources", row._id);

      const results = await ctx.db
        .query("searchResults")
        .withIndex("by_search", (q) => q.eq("searchId", search._id))
        .take(200);
      for (const row of results) {
        await ctx.db.delete("searchResults", row._id);
        deletedResults += 1;
      }

      await ctx.db.delete("searches", search._id);
    }

    const sends = (
      await ctx.db
        .query("sends")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(200)
    ).filter((row) => row.isSeed);

    for (const send of sends) {
      const attempts = await ctx.db
        .query("sendAttempts")
        .withIndex("by_send", (q) => q.eq("sendId", send._id))
        .take(50);
      for (const row of attempts) {
        await ctx.db.delete("sendAttempts", row._id);
        deletedAttempts += 1;
      }
      await ctx.db.delete("sends", send._id);
    }

    const drafts = (
      await ctx.db
        .query("drafts")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(200)
    ).filter((row) => row.isSeed);
    for (const row of drafts) await ctx.db.delete("drafts", row._id);

    const connections = (
      await ctx.db
        .query("connections")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(100)
    ).filter((row) => row.isSeed);
    for (const row of connections) await ctx.db.delete("connections", row._id);

    return {
      counts: {
        connections: connections.length,
        searches: searches.length,
        results: deletedResults,
        drafts: drafts.length,
        sends: sends.length,
        attempts: deletedAttempts,
      },
    };
  }
}

export const reset = mutation({
  args: {},
  returns: v.object({ counts }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return await resetForUser(ctx, user._id);
  },
});
