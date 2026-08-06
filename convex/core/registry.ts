/**
 * The adapter registry — the one place that knows which providers exist.
 *
 * Everything above this file (`orchestrator.ts`, the REST layer, the UI) is
 * written against `Source` and `Result`; everything below it is a self-contained
 * provider module. **Adding a source is one new file plus one line in the record
 * below**, which is the property the whole layering exists to buy.
 *
 * Read and write are separate records on purpose. `web` searches but cannot be
 * replied to, and a hypothetical SMS gateway would send but never search — so
 * "is searchable" and "is sendable" are different questions with different
 * answers, and collapsing them into one interface would force every provider to
 * stub the half it does not have.
 */

import { gmailAdapter, gmailSender } from "../adapters/gmail";
import { slackAdapter, slackSender } from "../adapters/slack";
import { webAdapter } from "../adapters/web";
import type { MessageSender } from "./sender";
import type { AdapterContext, Result, Source } from "./types";

/**
 * Provider-specific columns an adapter may attach to a result.
 *
 * These are stored (the UI renders `context` and `unread`, and a reply needs
 * `replyTo` / `threadId`) but they are **not part of `Result`**: the public
 * contract stays exactly the seven specified fields, and the REST projection
 * strips everything here. Keeping them in a separate type is what makes that
 * boundary checkable rather than a comment.
 */
export interface ResultExtras {
  /** Provider-side identity, when it differs from the display `id`. */
  externalId: string;
  /** Provider thread, so a reply stays in the conversation. */
  threadId: string;
  /** Where a reply would go: a sender address, or a Slack channel id. */
  replyTo: string;
  /** Context line for the row, e.g. `#deals`. */
  context: string;
  unread: boolean;
  /** Sender's provider avatar, when the provider exposes one. */
  avatarUrl: string;
  /** True when the user sent this rather than received it. */
  outgoing: boolean;
  /** Who it went to, when `outgoing`. */
  recipient: string;
  recipientName: string;
  /** Replies in this message's thread, when it has one. */
  replyCount: number;
  /** When the most recent reply landed. ISO 8601, like `timestamp`. */
  lastReplyAt: string;
}

export type EnrichedResult = Result & Partial<ResultExtras>;

/**
 * `SearchAdapter` narrowed to the enriched return type.
 *
 * Deliberately not a widening of `SearchAdapter` in `core/types.ts`: that file is
 * a verbatim copy of the specified contract and stays that way. Because every
 * extra field is optional, a plain `SearchAdapter` satisfies this interface, so
 * an adapter that has no extras to give does not have to say so.
 */
export interface EnrichedAdapter {
  source: Source;
  search(query: string, ctx: AdapterContext): Promise<EnrichedResult[]>;
}

export const ADAPTERS: Record<Source, EnrichedAdapter> = {
  gmail: gmailAdapter,
  slack: slackAdapter,
  web: webAdapter,
};

/**
 * Every searchable source, derived from the registry rather than written out
 * again.
 *
 * This exists because the alternative was three hand-maintained
 * `["gmail", "slack", "web"]` arrays — the fan-out default, the REST
 * `sources` allow-list, and the API's default — and none of them was
 * exhaustiveness-checked. A `Record<Source, …>` breaks the build when a source
 * is added; a `Source[]` literal does not, so forgetting one meant a registered
 * adapter that silently never ran. Deriving the list makes that class of bug
 * unrepresentable: if it is in `ADAPTERS`, it is searchable.
 *
 * Order is `ADAPTERS` insertion order, and is what `searches.ts` sorts the
 * source strip by.
 */
export const ALL_SOURCES = Object.keys(ADAPTERS) as Source[];

/** Sources you can send *through*. Keyed by `channel`, not `Source`, so `web`
 *  is absent by type rather than by a runtime check. */
export const SENDERS: Record<"gmail" | "slack", MessageSender> = {
  gmail: gmailSender,
  slack: slackSender,
};

/** Sources that need an OAuth grant. `web` is the odd one out, and this is the
 *  single expression of that fact. */
export function requiresGrant(source: Source): source is "gmail" | "slack" {
  return source !== "web";
}
