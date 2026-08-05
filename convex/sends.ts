/**
 * Sends: the idempotency guarantee, and the delivery loop built on top of it.
 *
 * ## The claim
 *
 * `claimSend` is the whole guarantee, and it is one mutation on purpose. Convex
 * mutations are serializable ACID transactions under optimistic concurrency
 * control, so the sequence
 *
 *   indexed read on `sends.by_user_idempotency_key` → insert into that same range
 *
 * is atomic *with respect to that key*. Two concurrent double-taps both read
 * "no row", both try to insert, and one of them loses the OCC check, is
 * automatically retried by Convex, and on the retry sees the winner's row and
 * returns it. Exactly one claimant, no locks, no unique constraint required.
 *
 * Three ways to get this wrong, all of them avoided deliberately:
 *
 *  1. **A `.filter()` or table scan instead of an indexed range read.** Correct,
 *     but its read set is the whole table, so every send conflicts with every
 *     other send and throughput collapses.
 *  2. **Reading by `draftId` instead of by key.** No conflict at all when two
 *     drafts share a key — which is the case the guarantee is *for*.
 *  3. **Splitting the read and the insert** across a query and a mutation, or
 *     doing the check in an action. That reintroduces exactly the race it was
 *     supposed to close.
 *
 * Neither Gmail nor Slack offers server-side idempotency on send. The claim row
 * *is* the guarantee; there is no provider-side safety net underneath it.
 *
 * ## The delivery loop
 *
 * Every attempt is bracketed by two mutations — `beginAttempt` before the provider
 * call and `finishAttempt`/`failAttempt` after — so the timeline survives a worker
 * dying mid-flight, and so `in_flight` acts as a lease that makes mashing "retry"
 * a no-op.
 *
 * The four failure kinds each get a different answer, and the interesting one is
 * `unknown`: a send that was dispatched and then cut off. We do not know whether
 * it arrived, so it is **never** auto-retried and never retried on request either.
 * Marking it `failed_transient` and backing off would be the polite-looking bug
 * that sends two copies of the same email.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveToken } from "./connections";
import { appError } from "./core/errors";
import { backoffMs } from "./core/http";
import { redactError } from "./core/redact";
import { SENDERS } from "./core/registry";
import { AdapterError, toAdapterError } from "./core/types";
import { draftContentKey, draftDigest, requireOwnDraft } from "./drafts";
import { channel as channelValidator, errorKind as errorKindValidator } from "./schema";
import { requireUser } from "./users";

/** Attempts an auto-retry may consume, including the first. Past this a human
 *  decides — a machine that keeps trying forever is how a rate limit becomes a
 *  ban. */
export const MAX_SEND_ATTEMPTS = 4;

/** Budget for one provider call. Beyond this the outcome is `unknown`, not
 *  `failed`, because a timeout says nothing about whether the message landed. */
export const SEND_DEADLINE_MS = 20_000;

/** Backoff schedule for transient retries. Full jitter (see `core/http.ts`). */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/** How long an `in_flight` send may go unreported before the sweeper calls it
 *  `unknown`. Comfortably past the deadline above plus scheduler latency. */
export const STALE_IN_FLIGHT_MS = 90_000;

/** Bound on the outbox list. */
const LIST_LIMIT = 50;

const sendStatus = v.union(
  v.literal("queued"),
  v.literal("in_flight"),
  v.literal("succeeded"),
  v.literal("failed_transient"),
  v.literal("failed_permanent"),
  v.literal("needs_reconnect"),
  v.literal("unknown"),
);

const trigger = v.union(v.literal("initial"), v.literal("auto"), v.literal("manual"));

/* --------------------------------------------------------------------- views */

const sendView = v.object({
  id: v.id("sends"),
  draftId: v.id("drafts"),
  idempotencyKey: v.string(),
  channel: channelValidator,
  connectionId: v.id("connections"),
  to: v.string(),
  subject: v.optional(v.string()),
  body: v.string(),
  threadId: v.optional(v.string()),
  status: sendStatus,
  attemptCount: v.number(),
  maxAttempts: v.number(),
  providerMessageId: v.optional(v.string()),
  providerThreadId: v.optional(v.string()),
  lastErrorKind: v.optional(errorKindValidator),
  lastErrorMessage: v.optional(v.string()),
  nextRetryAt: v.optional(v.number()),
  injectFailure: v.optional(errorKindValidator),
  isSeed: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
});

const attemptView = v.object({
  id: v.id("sendAttempts"),
  attemptNumber: v.number(),
  trigger,
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  outcome: v.optional(
    v.union(v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
  ),
  errorKind: v.optional(errorKindValidator),
  errorMessage: v.optional(v.string()),
  httpStatus: v.optional(v.number()),
  providerMessageId: v.optional(v.string()),
});

export function toSendView(send: Doc<"sends">) {
  return {
    id: send._id,
    draftId: send.draftId,
    idempotencyKey: send.idempotencyKey,
    channel: send.channel,
    connectionId: send.connectionId,
    to: send.to,
    subject: send.subject,
    body: send.body,
    threadId: send.threadId,
    status: send.status,
    attemptCount: send.attemptCount,
    maxAttempts: send.maxAttempts,
    providerMessageId: send.providerMessageId,
    providerThreadId: send.providerThreadId,
    lastErrorKind: send.lastErrorKind,
    lastErrorMessage: send.lastErrorMessage,
    nextRetryAt: send.nextRetryAt,
    injectFailure: send.injectFailure,
    isSeed: send.isSeed,
    createdAt: send.createdAt,
    updatedAt: send.updatedAt,
    completedAt: send.completedAt,
  };
}

function toAttemptView(attempt: Doc<"sendAttempts">) {
  return {
    id: attempt._id,
    attemptNumber: attempt.attemptNumber,
    trigger: attempt.trigger,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    outcome: attempt.outcome,
    errorKind: attempt.errorKind,
    errorMessage: attempt.errorMessage,
    httpStatus: attempt.httpStatus,
    providerMessageId: attempt.providerMessageId,
  };
}

/* ---------------------------------------------------------------- the claim */

export interface ClaimArgs {
  userId: Id<"users">;
  draftId: Id<"drafts">;
}

/**
 * Claim `(userId, idempotencyKey)` for one delivery, or return the delivery that
 * already holds it.
 *
 * The order of the checks matters. The existing-row lookup comes **first**, so
 * that a retry of an already-sent draft returns its receipt rather than tripping
 * over the fact that the draft is now `sent` rather than `confirmed`; the
 * confirmation checks then guard only the path that can actually create a
 * delivery. An unconfirmed draft still cannot produce one — there is no branch
 * from here to an insert that skips them.
 */
export async function claimSend(ctx: MutationCtx, args: ClaimArgs) {
  const draft = await requireOwnDraft(ctx, args.userId, args.draftId);

  // The read that makes this work: an indexed range read on the exact key, in the
  // same transaction as the insert below. See the file header.
  const existing = await ctx.db
    .query("sends")
    .withIndex("by_user_idempotency_key", (q) =>
      q.eq("userId", args.userId).eq("idempotencyKey", draft.idempotencyKey),
    )
    .unique();

  if (existing !== null) {
    // The frozen payload is the authority, not the draft: if they disagree, the
    // key has been pointed at two different messages and the honest answer is to
    // refuse rather than to silently deliver either one.
    if (draftContentKey(existing) !== draftContentKey(draft)) {
      throw appError(
        "IDEMPOTENCY_KEY_REUSED",
        `The key ${draft.idempotencyKey} has already been used for a different message. Clone this draft with a new key to send it.`,
      );
    }
    return { sendId: existing._id, claimed: false, send: toSendView(existing) };
  }

  if (draft.status !== "confirmed" || draft.confirmationHash === undefined) {
    throw appError(
      "CONFIRMATION_REQUIRED",
      "This draft has not been confirmed. Review the payload and confirm it before sending.",
    );
  }

  // Third derivation of the digest (review, confirm, here). This is the one that
  // actually gates delivery: everything before it is UI.
  const { hash } = await draftDigest(draft);
  if (hash !== draft.confirmationHash) {
    throw appError(
      "PAYLOAD_CHANGED_SINCE_CONFIRM",
      "The draft changed after it was confirmed. Review and confirm the current payload.",
    );
  }

  const now = Date.now();
  const sendId = await ctx.db.insert("sends", {
    userId: args.userId,
    draftId: draft._id,
    // Copied, not referenced: the guard has to survive the draft being edited or
    // (in a future cascade) deleted.
    idempotencyKey: draft.idempotencyKey,
    channel: draft.channel,
    connectionId: draft.connectionId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId,
    inReplyTo: draft.replyToExternalId,
    status: "queued",
    attemptCount: 0,
    maxAttempts: MAX_SEND_ATTEMPTS,
    // Copied for the same reason: the injected fault must survive retries, and
    // delivery reads the frozen send rather than the mutable draft.
    injectFailure: draft.injectFailure,
    isSeed: false,
    createdAt: now,
    updatedAt: now,
  });

  // Scheduled in the same transaction as the insert. If the transaction rolls
  // back, so does the schedule — there is no window where a delivery is pending
  // for a claim that does not exist.
  await ctx.scheduler.runAfter(0, internal.sends.deliver, {
    sendId,
    trigger: "initial" as const,
  });

  const send = await ctx.db.get("sends", sendId);
  if (send === null) throw appError("NOT_FOUND", "The send vanished on creation.");
  return { sendId, claimed: true, send: toSendView(send) };
}

/**
 * `claimSend` as a callable function, for the REST shell and the tests.
 *
 * Internal, and it takes `userId` as an argument: the two authenticated shells
 * (Clerk-authed public functions, API-key-authed HTTP routes) are the
 * authorization boundary, and this is deliberately below it. That superficially
 * conflicts with "never accept a userId as an argument" — the rule exists to stop
 * *public* functions trusting a client-supplied identity, and nothing public here
 * does.
 */
export const claim = internalMutation({
  args: { userId: v.id("users"), draftId: v.id("drafts") },
  returns: v.object({
    sendId: v.id("sends"),
    claimed: v.boolean(),
    send: sendView,
  }),
  handler: async (ctx, args) => await claimSend(ctx, args),
});

/**
 * Send a confirmed draft.
 *
 * A thin authenticated shell, and note what it does *not* take: no recipient, no
 * body, no subject. The payload is whatever the draft says it is, which is what
 * makes "confirm then send something else" unrepresentable rather than merely
 * guarded against.
 *
 * `claimed: false` means this call did not create the delivery — a double-tap, a
 * retried request, a second browser tab. The receipt returned is the first one.
 */
export const send = mutation({
  args: { draftId: v.id("drafts") },
  returns: v.object({
    sendId: v.id("sends"),
    claimed: v.boolean(),
    send: sendView,
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await claimSend(ctx, { userId: user._id, draftId: args.draftId });
  },
});

/* ------------------------------------------------------------ attempt gating */

const beginResult = v.union(
  v.object({ proceed: v.literal(false), reason: v.string() }),
  v.object({
    proceed: v.literal(true),
    attemptId: v.id("sendAttempts"),
    attemptNumber: v.number(),
    channel: channelValidator,
    connectionId: v.id("connections"),
    idempotencyKey: v.string(),
    to: v.string(),
    subject: v.optional(v.string()),
    body: v.string(),
    threadId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    injectFailure: v.optional(errorKindValidator),
  }),
);

/**
 * Decide whether this attempt may touch the provider, and stake the lease if so.
 *
 * Every refusal here is a provider call that did not happen. They are worth
 * reading one by one, because each corresponds to a way this system could
 * otherwise send twice:
 *
 *  - `succeeded`  — already delivered. The receipt is the answer.
 *  - `in_flight`  — someone is mid-attempt. Mashing retry must not race them.
 *  - `unknown`    — indeterminate. Retrying could double-send, so it never does.
 *  - `exhausted`  — the auto-retry budget is spent; a manual trigger may exceed it
 *                   because a human has looked at the error.
 */
export const beginAttempt = internalMutation({
  args: { sendId: v.id("sends"), trigger },
  returns: beginResult,
  handler: async (ctx, args) => {
    const send = await ctx.db.get("sends", args.sendId);
    if (send === null) return { proceed: false as const, reason: "missing" };

    if (send.status === "succeeded") {
      return { proceed: false as const, reason: "already_delivered" };
    }
    if (send.status === "in_flight") {
      return { proceed: false as const, reason: "attempt_in_progress" };
    }
    if (send.status === "unknown") {
      return { proceed: false as const, reason: "indeterminate" };
    }
    if (args.trigger === "auto" && send.attemptCount >= send.maxAttempts) {
      return { proceed: false as const, reason: "exhausted" };
    }

    const now = Date.now();
    const attemptNumber = send.attemptCount + 1;

    // The counter is bumped *before* the call, not after: an attempt that dies
    // mid-flight has still been spent, and pretending otherwise is how a retry
    // budget becomes infinite.
    await ctx.db.patch("sends", args.sendId, {
      status: "in_flight",
      attemptCount: attemptNumber,
      nextRetryAt: undefined,
      updatedAt: now,
    });

    const attemptId = await ctx.db.insert("sendAttempts", {
      sendId: args.sendId,
      userId: send.userId,
      attemptNumber,
      trigger: args.trigger,
      startedAt: now,
    });

    return {
      proceed: true as const,
      attemptId,
      attemptNumber,
      channel: send.channel,
      connectionId: send.connectionId,
      idempotencyKey: send.idempotencyKey,
      to: send.to,
      subject: send.subject,
      body: send.body,
      threadId: send.threadId,
      inReplyTo: send.inReplyTo,
      injectFailure: send.injectFailure,
    };
  },
});

/** Record a delivery. The provider's message id is the proof, so it is stored on
 *  both the send and the attempt that produced it. */
export const finishAttempt = internalMutation({
  args: {
    sendId: v.id("sends"),
    attemptId: v.id("sendAttempts"),
    providerMessageId: v.string(),
    providerThreadId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const send = await ctx.db.get("sends", args.sendId);
    if (send === null) return null;

    const now = Date.now();

    await ctx.db.patch("sends", args.sendId, {
      status: "succeeded",
      providerMessageId: args.providerMessageId,
      providerThreadId: args.providerThreadId,
      lastErrorKind: undefined,
      lastErrorMessage: undefined,
      nextRetryAt: undefined,
      updatedAt: now,
      completedAt: now,
    });

    await ctx.db.patch("sendAttempts", args.attemptId, {
      outcome: "succeeded",
      finishedAt: now,
      providerMessageId: args.providerMessageId,
    });

    const draft = await ctx.db.get("drafts", send.draftId);
    if (draft !== null && draft.status !== "sent") {
      await ctx.db.patch("drafts", send.draftId, { status: "sent", updatedAt: now });
    }

    // A delivered message is the most honest possible definition of "this grant
    // works", so it stamps the connection the same way a successful search does.
    const connection = await ctx.db.get("connections", send.connectionId);
    if (connection !== null) {
      await ctx.db.patch("connections", send.connectionId, { lastUsedAt: now });
    }

    return null;
  },
});

/**
 * Record a failed attempt, and decide what happens next from its classification.
 *
 * The classification was made where the provider response was parsed and is
 * stored as-is, so the operator reads the same verdict the retry logic acted on.
 */
export const failAttempt = internalMutation({
  args: {
    sendId: v.id("sends"),
    attemptId: v.id("sendAttempts"),
    kind: errorKindValidator,
    message: v.string(),
    httpStatus: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const send = await ctx.db.get("sends", args.sendId);
    if (send === null) return null;

    const now = Date.now();
    const message = redactError(args.message) ?? args.message;

    await ctx.db.patch("sendAttempts", args.attemptId, {
      outcome: args.kind === "unknown" ? "unknown" : "failed",
      errorKind: args.kind,
      errorMessage: message,
      httpStatus: args.httpStatus,
      finishedAt: now,
    });

    const common = {
      lastErrorKind: args.kind,
      lastErrorMessage: message,
      updatedAt: now,
    };

    if (args.kind === "transient") {
      const canRetry = send.attemptCount < send.maxAttempts;
      if (canRetry) {
        const delay = backoffMs(send.attemptCount, BACKOFF_BASE_MS, BACKOFF_CAP_MS);
        await ctx.db.patch("sends", args.sendId, {
          ...common,
          status: "failed_transient",
          nextRetryAt: now + delay,
        });
        await ctx.scheduler.runAfter(delay, internal.sends.deliver, {
          sendId: args.sendId,
          trigger: "auto" as const,
        });
        return null;
      }

      // Budget spent. Left `failed_transient` with no `nextRetryAt` and no
      // `completedAt`: the error really was transient, nothing was delivered, and
      // an operator can still retry it by hand. Calling it permanent would be a
      // lie about what the provider said.
      await ctx.db.patch("sends", args.sendId, {
        ...common,
        status: "failed_transient",
        nextRetryAt: undefined,
      });
      return null;
    }

    if (args.kind === "permanent") {
      await ctx.db.patch("sends", args.sendId, {
        ...common,
        status: "failed_permanent",
        nextRetryAt: undefined,
        completedAt: now,
      });
      const draft = await ctx.db.get("drafts", send.draftId);
      if (draft !== null && draft.status !== "sent") {
        await ctx.db.patch("drafts", send.draftId, { status: "failed", updatedAt: now });
      }
      return null;
    }

    if (args.kind === "needs_reconnect") {
      await ctx.db.patch("sends", args.sendId, {
        ...common,
        status: "needs_reconnect",
        nextRetryAt: undefined,
      });

      // The draft deliberately stays `confirmed`. Reconnecting and retrying then
      // reuses the same idempotency key, which is what makes "your grant died
      // mid-send" recoverable without any risk of a second copy.
      const connection = await ctx.db.get("connections", send.connectionId);
      if (connection !== null && connection.status !== "revoked") {
        await ctx.db.patch("connections", send.connectionId, {
          status: "revoked",
          statusReason: message,
          lastErrorAt: now,
          updatedAt: now,
        });
      }
      return null;
    }

    // `unknown`: dispatched, then silence. Terminal for this key by design — see
    // the file header. Recovery is reconcile (read-only) or clone-with-a-new-key.
    await ctx.db.patch("sends", args.sendId, {
      ...common,
      status: "unknown",
      nextRetryAt: undefined,
      completedAt: now,
    });
    return null;
  },
});

/* ------------------------------------------------------------------- deliver */

/**
 * Was this failure the kind where the message might have gone out anyway?
 *
 * Only reachable once the provider call has actually started. A request we cut
 * off ourselves, or one that timed out after the bytes were on the wire, tells us
 * nothing about what the provider did with it — so it becomes `unknown` rather
 * than inheriting `toAdapterError`'s (correct, for reads) "a timeout is transient".
 * That single reclassification is the difference between a retry loop that is safe
 * and one that occasionally sends two emails.
 */
function classifySendFailure(
  err: unknown,
  dispatched: boolean,
  signal: AbortSignal,
  channel: string,
): AdapterError {
  const error = toAdapterError(err);
  if (!dispatched || error.kind === "unknown") return error;

  const causedByAbort = (value: unknown): boolean => {
    if (!(value instanceof Error)) return false;
    if (value.name === "AbortError" || value.name === "TimeoutError") return true;
    return causedByAbort(value.cause);
  };
  const aborted =
    signal.aborted ||
    causedByAbort(err);
  if (!aborted) return error;

  return AdapterError.unknown(
    `The ${channel} send was cut off after ${Math.round(SEND_DEADLINE_MS / 1000)}s with no acknowledgement, so it is unknown whether the message was delivered. It will not be retried automatically.`,
    { detail: error.detail ?? error.message },
  );
}

/**
 * One delivery attempt, start to finish.
 *
 * Never throws: every exit path writes a terminal row, because an action that
 * throws leaves a send `in_flight` with nothing to explain it — and `in_flight` is
 * the one state that blocks every future attempt.
 */
export const deliver = internalAction({
  args: { sendId: v.id("sends"), trigger },
  returns: v.null(),
  handler: async (ctx, args) => {
    const begin = await ctx.runMutation(internal.sends.beginAttempt, {
      sendId: args.sendId,
      trigger: args.trigger,
    });
    if (!begin.proceed) return null;

    const signal = AbortSignal.timeout(SEND_DEADLINE_MS);
    let dispatched = false;

    try {
      // The only door to a credential. Refresh, leasing and revocation detection
      // all happen behind it, and a dead grant arrives here already classified
      // `needs_reconnect` — before any provider call is made.
      const token = await resolveToken(ctx, begin.connectionId);

      dispatched = true;
      const receipt = await SENDERS[begin.channel].send(
        {
          to: begin.to,
          subject: begin.subject,
          body: begin.body,
          threadId: begin.threadId,
          inReplyTo: begin.inReplyTo,
          idempotencyKey: begin.idempotencyKey,
        },
        {
          accessToken: token.accessToken,
          externalAccountId: token.externalAccountId,
          signal,
          injectFailure: begin.injectFailure,
        },
      );

      await ctx.runMutation(internal.sends.finishAttempt, {
        sendId: args.sendId,
        attemptId: begin.attemptId,
        providerMessageId: receipt.providerMessageId,
        providerThreadId: receipt.providerThreadId,
      });
    } catch (err) {
      const error = classifySendFailure(err, dispatched, signal, begin.channel);
      await ctx.runMutation(internal.sends.failAttempt, {
        sendId: args.sendId,
        attemptId: begin.attemptId,
        kind: error.kind,
        message:
          error.detail === undefined ? error.message : `${error.message} — ${error.detail}`,
        httpStatus: error.httpStatus,
      });
    }

    return null;
  },
});

/* --------------------------------------------------------------------- retry */

/**
 * Operator-triggered retry.
 *
 * Two answers here are as important as the retry itself. A `succeeded` send
 * returns its existing receipt and touches nothing — pressing retry after a
 * success must be free. An `unknown` send is **refused**: the only safe paths
 * forward are reconciling against the provider (read-only) or cloning the draft
 * under a new key, and quietly retrying would risk the second copy this whole
 * subsystem exists to prevent.
 */
export async function retrySend(
  ctx: MutationCtx,
  args: { userId: Id<"users">; sendId: Id<"sends"> },
) {
  const send = await ctx.db.get("sends", args.sendId);
  if (send === null || send.userId !== args.userId) {
    throw appError("NOT_FOUND", "That send does not exist.");
  }

  if (send.status === "unknown") {
    throw appError(
      "INDETERMINATE",
      "This send was dispatched but never acknowledged, so retrying it could deliver a second copy. Reconcile it against the provider, or clone the draft with a new idempotency key.",
    );
  }

  if (send.status === "succeeded") {
    return { retried: false, reason: "already_delivered", send: toSendView(send) };
  }

  if (send.status === "queued" || send.status === "in_flight") {
    return { retried: false, reason: "attempt_in_progress", send: toSendView(send) };
  }

  const now = Date.now();
  await ctx.db.patch("sends", args.sendId, { nextRetryAt: undefined, updatedAt: now });
  await ctx.scheduler.runAfter(0, internal.sends.deliver, {
    sendId: args.sendId,
    trigger: "manual" as const,
  });

  const updated = await ctx.db.get("sends", args.sendId);
  if (updated === null) throw appError("NOT_FOUND", "That send does not exist.");
  return { retried: true, send: toSendView(updated) };
}

/** The Clerk-authenticated shell over `retrySend`. */
export const retry = mutation({
  args: { sendId: v.id("sends") },
  returns: v.object({
    retried: v.boolean(),
    reason: v.optional(v.string()),
    send: sendView,
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await retrySend(ctx, { userId: user._id, sendId: args.sendId });
  },
});

/* ------------------------------------------------------------------- reading */

/** One send and its full attempt timeline. The outbox detail view subscribes to
 *  this, so an attempt appears the moment it starts rather than when it ends. */
export const watch = query({
  args: { sendId: v.id("sends") },
  returns: v.union(
    v.null(),
    v.object({ send: sendView, attempts: v.array(attemptView) }),
  ),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const send = await ctx.db.get("sends", args.sendId);
    if (send === null || send.userId !== user._id) return null;

    const attempts = await ctx.db
      .query("sendAttempts")
      .withIndex("by_send", (q) => q.eq("sendId", args.sendId))
      .take(MAX_SEND_ATTEMPTS * 8);

    return {
      send: toSendView(send),
      attempts: attempts
        .sort((a, b) => a.attemptNumber - b.attemptNumber || a.startedAt - b.startedAt)
        .map(toAttemptView),
    };
  },
});

/** The caller's outbox: newest first, bounded. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(sendView),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const limit = Math.min(Math.max(args.limit ?? LIST_LIMIT, 1), LIST_LIMIT);

    const rows = await ctx.db
      .query("sends")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return rows.map(toSendView);
  },
});

/* -------------------------------------------------------------------- sweeper */

/**
 * Turn abandoned `in_flight` sends into honest `unknown`s.
 *
 * A worker can die between `beginAttempt` and its outcome mutation — a deploy
 * mid-send, an isolate evicted. Without this the send would sit `in_flight`
 * forever, and `in_flight` blocks every future attempt, so the row would be
 * unretryable *and* unexplained.
 *
 * It resolves to `unknown` rather than `failed_transient` because that is what we
 * actually know. The provider may well have accepted the message; nobody was
 * listening when it answered.
 */
export const sweepStaleInFlight = internalMutation({
  args: {},
  returns: v.object({ swept: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STALE_IN_FLIGHT_MS;

    const stale = await ctx.db
      .query("sends")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "in_flight").lt("updatedAt", cutoff),
      )
      .take(25);

    let swept = 0;
    for (const send of stale) {
      // Seeded fixtures are frozen illustrations, not abandoned work: the
      // `in_flight` row exists so the outbox can show what that state looks like.
      // Sweeping it would quietly delete the example a reviewer came to see.
      if (send.isSeed) continue;

      // The attempt's own clock, not the send's, decides. `updatedAt` narrowed the
      // scan; this is the value the 90s promise is actually about.
      const attempts = await ctx.db
        .query("sendAttempts")
        .withIndex("by_send", (q) => q.eq("sendId", send._id))
        .order("desc")
        .take(1);
      const latest = attempts[0];
      if (latest !== undefined && latest.startedAt > cutoff) continue;

      swept += 1;
      const message = `Attempt ${send.attemptCount} was still in flight ${Math.round(STALE_IN_FLIGHT_MS / 1000)}s after it started and never reported. Whether ${send.to} received the message is unknown, so it will not be retried automatically.`;

      await ctx.db.patch("sends", send._id, {
        status: "unknown",
        lastErrorKind: "unknown",
        lastErrorMessage: message,
        nextRetryAt: undefined,
        updatedAt: now,
        completedAt: now,
      });

      if (latest !== undefined && latest.finishedAt === undefined) {
        await ctx.db.patch("sendAttempts", latest._id, {
          outcome: "unknown",
          errorKind: "unknown",
          errorMessage: message,
          finishedAt: now,
        });
      }
    }

    return { swept };
  },
});
