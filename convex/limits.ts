/**
 * Rate limits.
 *
 * The threat this exists for is specific: an API key that leaks, or a client
 * stuck in a retry loop, spending somebody's Gmail quota. Google's per-user send
 * and search quotas are a hard daily ceiling — once burned, the account is
 * useless until it resets, and no amount of backoff in this codebase gets it
 * back. So the limit is here, in front of the fan-out and in front of the REST
 * mutations, rather than left to the providers to enforce for us.
 *
 * Token buckets rather than fixed windows so a burst is allowed (the reviewer
 * running the walkthrough script three times in a row is not abuse) while the
 * sustained rate is still capped.
 */

import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { rateLimitError } from "./core/errors";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  /**
   * Fan-outs. One search can be five provider calls, so this is the expensive
   * one; 10/min is far more than a human types and far less than a loop does.
   */
  search: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
  /**
   * Everything a REST client can write: drafts, confirmations, sends, retries.
   * Generous, because the walkthrough script alone makes seven of them.
   */
  restWrite: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 30 },
});

export type LimitName = "search" | "restWrite";

/**
 * Consume one token or throw a `RATE_LIMITED` app error carrying the real
 * retry-after.
 *
 * The honesty matters: `retryAfter` comes from the bucket's own arithmetic, so
 * the `Retry-After` header the REST layer emits is when a retry will actually
 * succeed, not a made-up round number that trains clients to ignore it.
 */
export async function consume(
  ctx: MutationCtx,
  name: LimitName,
  userId: Id<"users">,
): Promise<void> {
  const status = await rateLimiter.limit(ctx, name, { key: userId });
  if (!status.ok) {
    throw rateLimitError(
      name === "search"
        ? "Too many searches. Each one fans out to every connected account, so the rate is capped."
        : "Too many write requests on this API key.",
      status.retryAfter,
    );
  }
}
