/**
 * UI-side view of the adapter contract.
 *
 * `Result` is reproduced verbatim from the spec (and from
 * `convex/core/types.ts`) on purpose: this UI is a *pure consumer* of the
 * adapter layer, so it is typed against the published shape rather than against
 * anything provider-specific. Swapping the mock driver for real API calls
 * should not touch a single component.
 */

export type Source = "gmail" | "slack" | "web";

export interface Result {
  source: string;
  id: string;
  title: string;
  snippet: string;
  author?: string;
  timestamp?: string; // ISO 8601
  url: string;
}

/** A result plus the bits the UI adds on top of the common shape. */
export interface UiResult extends Result {
  source: Source;
  /** Pre-formatted relative time. Precomputed so SSR and the client agree. */
  age: string;
  /** Gmail thread / Slack channel context line. */
  context?: string;
  /** Where a reply would go, if this result is replyable. */
  replyTo?: string;
  unread?: boolean;
  /** Sender's provider avatar, when the provider exposes one (Slack). */
  avatarUrl?: string;
  /** The user sent this rather than received it — a Sent-mail hit. */
  outgoing?: boolean;
  recipient?: string;
  recipientName?: string;
  /** Replies hanging off this message's thread (Slack). */
  replyCount?: number;
  /** Pre-formatted age of the newest reply, e.g. "8m". Empty when unknown. */
  lastReplyAge?: string;
  /**
   * Which grant a reply would be sent through. Carried on the result because
   * that is where the answer actually lives — the message was found by one
   * specific account's worker, and replying from a different one of that user's
   * accounts would be a different message.
   */
  connectionId?: string;
  /** Provider thread, so a reply lands in the conversation it answers. */
  threadId?: string;
  /** Provider-side id of the message being replied to. */
  externalId?: string;
  /**
   * The stored `searchResults` row this came from, when it is one. A reply
   * records it so the outbox can show the message it answered — and it is
   * deliberately absent on results synthesised in the client (the outbox's
   * "compose again", which has no stored result behind it).
   */
  resultId?: string;
  /**
   * Merge-layer relevance score, computed at write time. Higher is better.
   * Powers the opt-in "Relevance" sort; arrival order stays the default
   * because it is honest about streaming.
   */
  score?: number;
}

/** Mirrors `searchSources.status` in the Convex schema. */
export type SourceRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_reconnect";

export interface SourceRun {
  source: Source;
  /** The connection label — an inbox address or a workspace name. */
  label: string;
  status: SourceRunStatus;
  resultCount: number;
  durationMs?: number;
  errorKind?: "transient" | "permanent" | "needs_reconnect" | "unknown";
  errorMessage?: string;
}

export interface SearchRecord {
  id: string;
  query: string;
  /** Pre-formatted, e.g. "23m" — see `UiResult.age`. */
  age: string;
  resultCount: number;
  sources: Source[];
  archived: boolean;
  /** Seed rows are badged in the UI so demo data is never mistaken for real. */
  isSeed: boolean;
  /** Set when a source ended in `needs_reconnect`, so history stays honest. */
  degraded?: boolean;
  /** True between "run started" and "every adapter reported". */
  pending?: boolean;
}

export type ConnectionStatus = "active" | "expired" | "errored" | "revoked";

export interface Connection {
  id: string;
  provider: "gmail" | "slack";
  label: string;
  /**
   * The identity inside `label`, when the label is not one itself: the Slack
   * member the workspace is connected as. Undefined for Gmail, whose label is
   * already the account.
   */
  accountName?: string;
  detail: string;
  status: ConnectionStatus;
  statusReason?: string;
  scopes: string[];
  lastUsed: string;
  /**
   * Whether this individual account is included in searches. Distinct from
   * `status`: a healthy account can be switched off by the user, and a broken
   * one can still be switched on (it will just keep reporting its error).
   */
  enabled: boolean;
  /** Seed rows are badged in the UI so demo data is never mistaken for a real
   *  grant — the same rule the outbox and search history already follow. */
  isSeed: boolean;
}

/**
 * Seed values for the compose dialog when it is not starting from a blank
 * reply — e.g. "compose again with a new key" from the outbox, which carries
 * the payload of an indeterminate send into a fresh draft.
 */
export interface ComposePrefill {
  subject?: string;
  body: string;
}

/** A composed, not-yet-sent message. Mirrors the `Draft` interface in the spec. */
export interface Draft {
  id: string;
  channel: "gmail" | "slack";
  to: string;
  toLabel: string;
  subject?: string;
  body: string;
  idempotency_key: string;
}
