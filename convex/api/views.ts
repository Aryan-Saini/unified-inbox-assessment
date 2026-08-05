/**
 * The REST projections: database rows in, public JSON out.
 *
 * These are pure functions paired with the validators that describe them, and
 * they are the *only* way a row reaches an API consumer. That matters most for
 * `toPublicResult`: the `searchResults` table carries enrichment the UI uses
 * (`seq`, `score`, `connectionId`, `threadId`, `replyTo`, `context`, `unread`),
 * and the public `Result` in the specification has exactly seven fields. The
 * validator below *is* that contract — Convex checks the returned object against
 * it, so an eighth field added to the table cannot leak into the API without this
 * file changing and a test failing.
 *
 * Field names are `snake_case`, matching the request bodies in the spec.
 */

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { errorKind, source } from "../schema";
import { iso } from "./http";

/* -------------------------------------------------------------------- results */

/**
 * The spec's `Result`, and nothing else.
 *
 * `id` is our row id rather than the provider's message id, deliberately: it is
 * the identifier this API accepts back (as `reply_to_result_id` on a draft),
 * which an opaque provider string is not. The provider's own id stays visible in
 * `url`, where a human can act on it.
 */
export const publicResult = v.object({
  source,
  id: v.id("searchResults"),
  title: v.string(),
  snippet: v.string(),
  author: v.optional(v.string()),
  /** ISO 8601. Absent for sources with no reliable date (most web results). */
  timestamp: v.optional(v.string()),
  url: v.string(),
});

export function toPublicResult(row: Doc<"searchResults">) {
  return {
    source: row.source,
    id: row._id,
    title: row.title,
    snippet: row.snippet,
    author: row.author,
    timestamp: row.timestamp,
    url: row.url,
  };
}

/* ------------------------------------------------------------------- searches */

export const apiSearch = v.object({
  id: v.id("searches"),
  query: v.string(),
  status: v.union(v.literal("running"), v.literal("complete")),
  origin: v.union(v.literal("ui"), v.literal("api"), v.literal("seed")),
  result_count: v.number(),
  rerun_of: v.optional(v.id("searches")),
  is_seed: v.boolean(),
  created_at: v.string(),
  completed_at: v.optional(v.string()),
});

export function toApiSearch(row: Doc<"searches">) {
  return {
    id: row._id,
    query: row.query,
    status: row.status,
    origin: row.origin,
    result_count: row.resultCount,
    rerun_of: row.rerunOf,
    is_seed: row.isSeed,
    created_at: iso(row.createdAt) as string,
    completed_at: iso(row.completedAt),
  };
}

/** One adapter run. This is the per-source status the spec asks a search to expose. */
export const apiSourceRun = v.object({
  source,
  /** Which grant answered, when the source is account-scoped. */
  connection_id: v.optional(v.id("connections")),
  label: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("needs_reconnect"),
  ),
  error_kind: v.optional(errorKind),
  error_message: v.optional(v.string()),
  attempt_count: v.number(),
  result_count: v.number(),
  duration_ms: v.optional(v.number()),
});

export function toApiSourceRun(row: Doc<"searchSources">) {
  return {
    source: row.source,
    connection_id: row.connectionId,
    label: row.label,
    status: row.status,
    error_kind: row.errorKind,
    error_message: row.errorMessage,
    attempt_count: row.attemptCount,
    result_count: row.resultCount,
    duration_ms: row.durationMs,
  };
}

/* --------------------------------------------------------------------- drafts */

export const apiDraft = v.object({
  id: v.id("drafts"),
  channel: v.union(v.literal("gmail"), v.literal("slack")),
  connection_id: v.id("connections"),
  to: v.string(),
  subject: v.optional(v.string()),
  body: v.string(),
  idempotency_key: v.string(),
  status: v.union(
    v.literal("draft"),
    v.literal("confirmed"),
    v.literal("sent"),
    v.literal("failed"),
  ),
  revision: v.number(),
  confirmed: v.boolean(),
  /**
   * The digest `POST /drafts/{id}/confirm` requires. Present on the read, and
   * only on the read — obtaining it means the payload was fetched, which is the
   * whole point of the confirm gate.
   */
  review_hash: v.string(),
  /** The exact string the digest is over, so a client can verify it itself. */
  canonical_payload: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
});

export function toApiDraft(
  row: Doc<"drafts">,
  digest: { canonical: string; hash: string },
) {
  return {
    id: row._id,
    channel: row.channel,
    connection_id: row.connectionId,
    to: row.to,
    subject: row.subject,
    body: row.body,
    idempotency_key: row.idempotencyKey,
    status: row.status,
    revision: row.revision,
    confirmed: row.confirmationHash === digest.hash,
    review_hash: digest.hash,
    canonical_payload: digest.canonical,
    created_at: iso(row.createdAt) as string,
    updated_at: iso(row.updatedAt) as string,
  };
}

/* ---------------------------------------------------------------------- sends */

export const apiSend = v.object({
  id: v.id("sends"),
  draft_id: v.id("drafts"),
  idempotency_key: v.string(),
  channel: v.union(v.literal("gmail"), v.literal("slack")),
  connection_id: v.id("connections"),
  to: v.string(),
  subject: v.optional(v.string()),
  body: v.string(),
  status: v.union(
    v.literal("queued"),
    v.literal("in_flight"),
    v.literal("succeeded"),
    v.literal("failed_transient"),
    v.literal("failed_permanent"),
    v.literal("needs_reconnect"),
    v.literal("unknown"),
  ),
  attempt_count: v.number(),
  max_attempts: v.number(),
  provider_message_id: v.optional(v.string()),
  provider_thread_id: v.optional(v.string()),
  last_error_kind: v.optional(errorKind),
  last_error_message: v.optional(v.string()),
  next_retry_at: v.optional(v.string()),
  is_seed: v.boolean(),
  created_at: v.string(),
  updated_at: v.string(),
  completed_at: v.optional(v.string()),
});

/**
 * Note what is *not* in here: nothing about which call produced it. Two requests
 * that share an idempotency key get byte-identical bodies from this projection —
 * the dedupe is reported in the `X-Idempotent-Replay` header instead, so proving
 * "the second call sent nothing new" is a diff of two response bodies.
 */
export function toApiSend(row: Doc<"sends">) {
  return {
    id: row._id,
    draft_id: row.draftId,
    idempotency_key: row.idempotencyKey,
    channel: row.channel,
    connection_id: row.connectionId,
    to: row.to,
    subject: row.subject,
    body: row.body,
    status: row.status,
    attempt_count: row.attemptCount,
    max_attempts: row.maxAttempts,
    provider_message_id: row.providerMessageId,
    provider_thread_id: row.providerThreadId,
    last_error_kind: row.lastErrorKind,
    last_error_message: row.lastErrorMessage,
    next_retry_at: iso(row.nextRetryAt),
    is_seed: row.isSeed,
    created_at: iso(row.createdAt) as string,
    updated_at: iso(row.updatedAt) as string,
    completed_at: iso(row.completedAt),
  };
}

export const apiAttempt = v.object({
  attempt_number: v.number(),
  trigger: v.union(v.literal("initial"), v.literal("auto"), v.literal("manual")),
  started_at: v.string(),
  finished_at: v.optional(v.string()),
  outcome: v.optional(
    v.union(v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
  ),
  error_kind: v.optional(errorKind),
  /** The provider's error, redacted of credentials but not truncated. */
  error_message: v.optional(v.string()),
  http_status: v.optional(v.number()),
  provider_message_id: v.optional(v.string()),
});

export function toApiAttempt(row: Doc<"sendAttempts">) {
  return {
    attempt_number: row.attemptNumber,
    trigger: row.trigger,
    started_at: iso(row.startedAt) as string,
    finished_at: iso(row.finishedAt),
    outcome: row.outcome,
    error_kind: row.errorKind,
    error_message: row.errorMessage,
    http_status: row.httpStatus,
    provider_message_id: row.providerMessageId,
  };
}

/* ---------------------------------------------------------------- connections */

/** Tokens, ciphertexts and lease state are absent by construction. */
export const apiConnection = v.object({
  id: v.id("connections"),
  provider: v.union(v.literal("gmail"), v.literal("slack")),
  external_account_id: v.string(),
  label: v.string(),
  status: v.union(
    v.literal("active"),
    v.literal("expired"),
    v.literal("errored"),
    v.literal("revoked"),
  ),
  status_reason: v.optional(v.string()),
  enabled: v.boolean(),
  scopes: v.array(v.string()),
  is_seed: v.boolean(),
  created_at: v.string(),
  last_used_at: v.optional(v.string()),
});

export function toApiConnection(row: Doc<"connections">) {
  return {
    id: row._id,
    provider: row.provider,
    external_account_id: row.externalAccountId,
    label: row.label,
    status: row.status,
    status_reason: row.statusReason,
    enabled: row.enabled,
    scopes: row.scopes,
    is_seed: row.isSeed,
    created_at: iso(row.createdAt) as string,
    last_used_at: iso(row.lastUsedAt),
  };
}
