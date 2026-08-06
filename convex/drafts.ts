/**
 * Drafts: the only way a message can come into existence, and the confirm gate
 * that stands between one and a delivery.
 *
 * The shape of this file *is* the friction. There is deliberately no function
 * here (or anywhere) that takes a recipient and a body and sends them: composing
 * writes a row, and sending is a separate call that has to name a draft. Three
 * steps, three round trips:
 *
 *   1. `create`        — a draft, and an idempotency key minted with it.
 *   2. `reviewPayload` — the *exact* payload plus its digest. Reading this query
 *                        is the only way to obtain the digest, so presenting one
 *                        is evidence the payload was rendered somewhere.
 *   3. `confirm`       — takes that digest back. The server re-derives it from the
 *                        row and refuses a mismatch.
 *
 * Then `sends.send` re-derives it a third time (see `sends.ts`), which is what
 * closes the confirm-then-mutate hole: editing a confirmed draft bumps its
 * revision and clears the confirmation, so a stale digest can never authorise the
 * new payload — not even if the edit puts the text back exactly as it was.
 *
 * Ownership is proved on every path, and "not found" and "not yours" are the same
 * answer, because telling them apart confirms the existence of someone else's row.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canonicalContent, canonicalPayload } from "./core/canonical";
import { sha256Hex, timingSafeEqual } from "./core/crypto";
import { appError } from "./core/errors";
import { channel as channelValidator, errorKind as errorKindValidator } from "./schema";
import { requireUser } from "./users";

/** Longest recipient we will store. RFC 5321 caps a path at 256; a Slack channel
 *  id is far shorter. */
const MAX_TO_LENGTH = 320;
/** RFC 5322 unfolded header line limit, less the `Subject: ` prefix. */
const MAX_SUBJECT_LENGTH = 988;
/** Generous for a reply, bounded so one draft cannot approach the 1MB doc cap. */
const MAX_BODY_LENGTH = 50_000;

/* --------------------------------------------------------------------- views */

const draftView = v.object({
  id: v.id("drafts"),
  channel: channelValidator,
  connectionId: v.id("connections"),
  to: v.string(),
  toLabel: v.optional(v.string()),
  subject: v.optional(v.string()),
  body: v.string(),
  idempotencyKey: v.string(),
  status: v.union(
    v.literal("draft"),
    v.literal("confirmed"),
    v.literal("sent"),
    v.literal("failed"),
  ),
  revision: v.number(),
  /** Whether a confirmation is currently on file. The digest itself is not
   *  returned here — `reviewPayload` is the only place it comes from. */
  confirmed: v.boolean(),
  confirmedAt: v.optional(v.number()),
  injectFailure: v.optional(errorKindValidator),
  threadId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export function toDraftView(draft: Doc<"drafts">) {
  return {
    id: draft._id,
    channel: draft.channel,
    connectionId: draft.connectionId,
    to: draft.to,
    toLabel: draft.toLabel,
    subject: draft.subject,
    body: draft.body,
    idempotencyKey: draft.idempotencyKey,
    status: draft.status,
    revision: draft.revision,
    confirmed: draft.confirmationHash !== undefined,
    confirmedAt: draft.confirmedAt,
    injectFailure: draft.injectFailure,
    threadId: draft.threadId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

/* ------------------------------------------------------------------- helpers */

/**
 * The canonical string for a draft row, and its digest.
 *
 * One function, called from `reviewPayload`, `confirm` and `sends.claim`, so the
 * three can never derive it differently. A second implementation of this — even a
 * faithful one — is a confirm gate that opens under refactoring.
 */
export async function draftDigest(
  draft: Doc<"drafts">,
): Promise<{ canonical: string; hash: string }> {
  const canonical = canonicalPayload({
    revision: draft.revision,
    channel: draft.channel,
    connectionId: draft.connectionId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
  });
  return { canonical, hash: await sha256Hex(canonical) };
}

/** The revision-independent identity of a payload: "is this the same message?". */
export function draftContentKey(
  draft: Pick<Doc<"drafts">, "channel" | "connectionId" | "to" | "subject" | "body">,
): string {
  return canonicalContent({
    channel: draft.channel,
    connectionId: draft.connectionId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
  });
}

export async function requireOwnDraft(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  draftId: Id<"drafts">,
): Promise<Doc<"drafts">> {
  const draft = await ctx.db.get("drafts", draftId);
  if (draft === null || draft.userId !== userId) {
    throw appError("NOT_FOUND", "That draft does not exist.");
  }
  return draft;
}

/** A key we minted, when the caller supplied none. */
function mintIdempotencyKey(): string {
  return `idem_${crypto.randomUUID().replace(/-/g, "")}`;
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === "") throw appError("INVALID_STATE", `A draft needs a ${field}.`);
  if (trimmed.length > max) {
    throw appError(
      "INVALID_STATE",
      `The ${field} is longer than the ${max}-character limit.`,
    );
  }
  return trimmed;
}

/**
 * The recipient additionally refuses control characters. `to` is interpolated
 * into an RFC 2822 header on the Gmail path, where a CR/LF is structure, not
 * data — `"a@x\r\nBcc: b@y"` would smuggle a hidden recipient past the confirm
 * screen. The Gmail sender strips controls defensively too; rejecting here
 * means the confirm screen can never show a recipient that differs from the
 * one the wire will carry.
 */
function requireRecipient(value: string, max: number): string {
  const trimmed = requireText(value, "recipient", max);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw appError(
      "INVALID_STATE",
      "The recipient contains control characters, which could forge message headers.",
    );
  }
  return trimmed;
}

/* -------------------------------------------------------------------- create */

export interface CreateDraftArgs {
  userId: Id<"users">;
  channel: Doc<"drafts">["channel"];
  connectionId: Id<"connections">;
  to: string;
  toLabel?: string;
  subject?: string;
  body: string;
  idempotencyKey?: string;
  replyToResultId?: Id<"searchResults">;
  replyToExternalId?: string;
  threadId?: string;
  injectFailure?: Doc<"drafts">["injectFailure"];
}

/**
 * Create a draft, or hand back the one this idempotency key already names.
 *
 * The re-use rule is the same one `sends.claim` enforces later, applied one step
 * earlier: **one key, one payload.** A client that retries `create` after a
 * dropped response gets its original draft back rather than a duplicate; a client
 * that changes the message and keeps the key is refused, because silently
 * accepting it would mean the key no longer identifies anything.
 */
export async function createDraft(ctx: MutationCtx, args: CreateDraftArgs) {
  const to = requireRecipient(args.to, MAX_TO_LENGTH);
  const body = requireText(args.body, "body", MAX_BODY_LENGTH);
  const subject =
    args.subject === undefined
      ? undefined
      : args.subject.trim().slice(0, MAX_SUBJECT_LENGTH);

  // Sending is only meaningful through a grant the caller holds, for the right
  // provider, that is actually usable. Checked here rather than at delivery so
  // the failure lands while a human is still looking at the compose screen.
  const connection = await ctx.db.get("connections", args.connectionId);
  if (connection === null || connection.userId !== args.userId) {
    throw appError("NOT_FOUND", "That connection does not exist.");
  }
  if (connection.provider !== args.channel) {
    throw appError(
      "CONNECTION_UNAVAILABLE",
      `${connection.label} is a ${connection.provider} account and cannot send on ${args.channel}.`,
    );
  }
  if (connection.status !== "active") {
    throw appError(
      "CONNECTION_UNAVAILABLE",
      connection.statusReason ??
        `${connection.label} is ${connection.status}. Reconnect the account before composing.`,
    );
  }
  if (!connection.enabled) {
    throw appError(
      "CONNECTION_UNAVAILABLE",
      `${connection.label} is switched off. Switch it back on to send through it.`,
    );
  }

  const idempotencyKey = args.idempotencyKey?.trim() ?? mintIdempotencyKey();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw appError(
      "INVALID_STATE",
      "An idempotency key must be between 8 and 128 characters.",
    );
  }

  const candidate = {
    channel: args.channel,
    connectionId: args.connectionId,
    to,
    subject,
    body,
  };

  const existing = await ctx.db
    .query("drafts")
    .withIndex("by_user_idempotency_key", (q) =>
      q.eq("userId", args.userId).eq("idempotencyKey", idempotencyKey),
    )
    .unique();

  if (existing !== null) {
    if (draftContentKey(existing) !== draftContentKey(candidate)) {
      throw appError(
        "IDEMPOTENCY_KEY_REUSED",
        `The key ${idempotencyKey} already names a different draft. Use a new key for a different message.`,
      );
    }
    return { draft: toDraftView(existing), reused: true };
  }

  const now = Date.now();
  const draftId = await ctx.db.insert("drafts", {
    userId: args.userId,
    ...candidate,
    toLabel: args.toLabel,
    idempotencyKey,
    status: "draft",
    // Revision 1, not 0: every confirmation is bound to a revision, and starting
    // at 1 means "revision 0" is never a valid thing to have confirmed.
    revision: 1,
    injectFailure: args.injectFailure,
    replyToResultId: args.replyToResultId,
    replyToExternalId: args.replyToExternalId,
    threadId: args.threadId,
    isSeed: false,
    createdAt: now,
    updatedAt: now,
  });

  const created = await ctx.db.get("drafts", draftId);
  if (created === null) throw appError("NOT_FOUND", "The draft vanished on creation.");
  return { draft: toDraftView(created), reused: false };
}

/* -------------------------------------------------------------------- update */

export interface UpdateDraftArgs {
  userId: Id<"users">;
  draftId: Id<"drafts">;
  to?: string;
  toLabel?: string;
  subject?: string;
  body?: string;
}

/**
 * Edit a draft, and in doing so revoke any confirmation it had.
 *
 * The revision bump is the important half. Clearing `confirmationHash` alone
 * would still allow the A → B → A attack: edit a confirmed draft, edit it back,
 * re-present the original digest. With the revision inside the digest, the
 * round-tripped payload hashes differently from the one that was confirmed, so
 * the old digest is dead the moment the first edit lands.
 *
 * A `sent` or `failed` draft is not editable. Its idempotency key is already
 * spoken for by a frozen `sends` row, so an edit could only ever lead to
 * `IDEMPOTENCY_KEY_REUSED` at send time — refusing here says so while it is still
 * fixable, and the fix (a new draft with a new key) is the honest one.
 */
export async function updateDraft(ctx: MutationCtx, args: UpdateDraftArgs) {
  const draft = await requireOwnDraft(ctx, args.userId, args.draftId);

  if (draft.status !== "draft" && draft.status !== "confirmed") {
    throw appError(
      "INVALID_STATE",
      `This draft is ${draft.status} and cannot be edited. Compose a new one — it will get a new idempotency key.`,
    );
  }

  const next = {
    channel: draft.channel,
    connectionId: draft.connectionId,
    to: args.to === undefined ? draft.to : requireRecipient(args.to, MAX_TO_LENGTH),
    subject:
      args.subject === undefined
        ? draft.subject
        : args.subject.trim().slice(0, MAX_SUBJECT_LENGTH),
    body:
      args.body === undefined ? draft.body : requireText(args.body, "body", MAX_BODY_LENGTH),
  };

  const labelChanged = args.toLabel !== undefined && args.toLabel !== draft.toLabel;

  // A no-op edit stays a no-op: bumping the revision here would invalidate a
  // perfectly good confirmation because a keystroke was typed and undone.
  if (draftContentKey(next) === draftContentKey(draft) && !labelChanged) {
    return toDraftView(draft);
  }

  const now = Date.now();
  await ctx.db.patch("drafts", args.draftId, {
    to: next.to,
    subject: next.subject,
    body: next.body,
    ...(args.toLabel === undefined ? {} : { toLabel: args.toLabel }),
    revision: draft.revision + 1,
    status: "draft",
    confirmationHash: undefined,
    confirmedAt: undefined,
    updatedAt: now,
  });

  const updated = await ctx.db.get("drafts", args.draftId);
  if (updated === null) throw appError("NOT_FOUND", "That draft does not exist.");
  return toDraftView(updated);
}

/* ------------------------------------------------------------ review/confirm */

const reviewView = v.object({
  draftId: v.id("drafts"),
  revision: v.number(),
  channel: channelValidator,
  connectionId: v.id("connections"),
  /** The account this would be sent from, for the review screen. */
  accountLabel: v.string(),
  to: v.string(),
  toLabel: v.optional(v.string()),
  subject: v.optional(v.string()),
  body: v.string(),
  idempotencyKey: v.string(),
  /** The exact string that was hashed. Returned so a reviewer (or a test) can
   *  verify the digest rather than trusting it. */
  canonical: v.string(),
  /** SHA-256 of `canonical`. `confirm` will not accept anything else. */
  hash: v.string(),
  status: v.union(
    v.literal("draft"),
    v.literal("confirmed"),
    v.literal("sent"),
    v.literal("failed"),
  ),
  /** True when the stored confirmation still matches this payload. */
  confirmed: v.boolean(),
});

/**
 * The payload, verbatim, plus the digest `confirm` requires.
 *
 * A query rather than part of `create`'s response, because the digest has to
 * describe the draft *as it is now*: reading it after an edit returns the new
 * hash, and the old one is already worthless.
 */
export const reviewPayload = query({
  args: { draftId: v.id("drafts") },
  returns: reviewView,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const draft = await requireOwnDraft(ctx, user._id, args.draftId);
    const { canonical, hash } = await draftDigest(draft);

    const connection = await ctx.db.get("connections", draft.connectionId);

    return {
      draftId: draft._id,
      revision: draft.revision,
      channel: draft.channel,
      connectionId: draft.connectionId,
      // Member *and* workspace for Slack: the confirm step's whole job is to say
      // exactly what is about to happen, and "aryan-test" does not say which of
      // that workspace's members the message will appear to come from.
      accountLabel:
        connection === null
          ? "(disconnected account)"
          : connection.accountName === undefined
            ? connection.label
            : `${connection.accountName} at ${connection.label}`,
      to: draft.to,
      toLabel: draft.toLabel,
      subject: draft.subject,
      body: draft.body,
      idempotencyKey: draft.idempotencyKey,
      canonical,
      hash,
      status: draft.status,
      confirmed: draft.confirmationHash === hash,
    };
  },
});

export interface ConfirmDraftArgs {
  userId: Id<"users">;
  draftId: Id<"drafts">;
  reviewedHash: string;
}

/**
 * Record that this exact payload was reviewed.
 *
 * The presented hash is never trusted as *content* — it is only ever compared
 * against a digest the server derives from the row it already holds. So this
 * cannot be used to confirm something other than what is stored; the worst a
 * wrong hash can do is fail.
 */
export async function confirmDraft(ctx: MutationCtx, args: ConfirmDraftArgs) {
  const draft = await requireOwnDraft(ctx, args.userId, args.draftId);

  if (draft.status !== "draft" && draft.status !== "confirmed") {
    throw appError(
      "INVALID_STATE",
      `This draft is already ${draft.status} and cannot be confirmed again.`,
    );
  }

  const { hash } = await draftDigest(draft);
  const presented = args.reviewedHash.trim().toLowerCase();

  if (!timingSafeEqual(presented, hash)) {
    throw appError(
      "PAYLOAD_MISMATCH",
      "The payload changed since it was reviewed. Re-read the draft and confirm the current version.",
    );
  }

  const now = Date.now();
  await ctx.db.patch("drafts", args.draftId, {
    status: "confirmed",
    confirmationHash: hash,
    confirmedAt: now,
    updatedAt: now,
  });

  return { draftId: draft._id, revision: draft.revision, confirmationHash: hash };
}

/* ------------------------------------------------------------- read / delete */

export async function discardDraft(
  ctx: MutationCtx,
  args: { userId: Id<"users">; draftId: Id<"drafts"> },
) {
  // Ownership first, and for its throw rather than its value: discarding
  // someone else's draft must be indistinguishable from discarding a missing one.
  await requireOwnDraft(ctx, args.userId, args.draftId);

  // A draft with a send row is history, not a scratchpad: deleting it would
  // orphan the delivery record that explains what left the system.
  const send = await ctx.db
    .query("sends")
    .withIndex("by_draft", (q) => q.eq("draftId", args.draftId))
    .first();
  if (send !== null) {
    throw appError(
      "INVALID_STATE",
      "This draft has been sent, so it is kept as history and cannot be discarded.",
    );
  }

  await ctx.db.delete("drafts", args.draftId);
  return null;
}

/* --------------------------------------------------------------- public API */

export const create = mutation({
  args: {
    channel: channelValidator,
    connectionId: v.id("connections"),
    to: v.string(),
    toLabel: v.optional(v.string()),
    subject: v.optional(v.string()),
    body: v.string(),
    /** Supply one to make a retried create idempotent; otherwise we mint it. */
    idempotencyKey: v.optional(v.string()),
    replyToResultId: v.optional(v.id("searchResults")),
    replyToExternalId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    /** Demo affordance; inert unless the deployment allows fault injection. */
    injectFailure: v.optional(errorKindValidator),
  },
  returns: v.object({ draft: draftView, reused: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await createDraft(ctx, { userId: user._id, ...args });
  },
});

export const update = mutation({
  args: {
    draftId: v.id("drafts"),
    to: v.optional(v.string()),
    toLabel: v.optional(v.string()),
    subject: v.optional(v.string()),
    body: v.optional(v.string()),
  },
  returns: draftView,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await updateDraft(ctx, { userId: user._id, ...args });
  },
});

export const confirm = mutation({
  args: { draftId: v.id("drafts"), reviewedHash: v.string() },
  returns: v.object({
    draftId: v.id("drafts"),
    revision: v.number(),
    confirmationHash: v.string(),
  }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await confirmDraft(ctx, { userId: user._id, ...args });
  },
});

export const get = query({
  args: { draftId: v.id("drafts") },
  returns: v.union(v.null(), draftView),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const draft = await ctx.db.get("drafts", args.draftId);
    if (draft === null || draft.userId !== user._id) return null;
    return toDraftView(draft);
  },
});

export const discard = mutation({
  args: { draftId: v.id("drafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return await discardDraft(ctx, { userId: user._id, draftId: args.draftId });
  },
});
