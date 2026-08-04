/**
 * The send half of a provider module.
 *
 * Kept out of `types.ts` so that file stays a verbatim copy of the specified
 * `SearchAdapter` / `Result` contract. The two are deliberately separate
 * interfaces: `web` implements `SearchAdapter` and no sender, and a
 * write-only provider (an SMS gateway, say) would implement a sender and no
 * adapter. Neither the merge layer nor the send gate cares which a given
 * provider has.
 */

export interface SendPayload {
  /** Recipient: an email address, or a Slack channel/user id. */
  to: string;
  subject?: string;
  body: string;
  /** Provider thread to reply into, when the draft came from a search result. */
  threadId?: string;
  /** Provider-side id of the message being replied to. */
  inReplyTo?: string;
}

export interface SendContext {
  accessToken: string;
  externalAccountId: string;
  signal: AbortSignal;
  /**
   * Test/demo affordance. Forces the provider call to fail in a specific way so
   * the transient-vs-permanent paths can be demonstrated without waiting for a
   * real outage. Ignored unless the deployment allows fault injection.
   */
  injectFailure?: "transient" | "permanent" | "needs_reconnect" | "unknown";
}

export interface SendReceipt {
  /** Provider-side message id. Proof of exactly one delivery. */
  providerMessageId: string;
  providerThreadId?: string;
}

export interface MessageSender {
  channel: "gmail" | "slack";
  send(payload: SendPayload, ctx: SendContext): Promise<SendReceipt>;
}
