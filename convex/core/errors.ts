/**
 * Application errors that cross a boundary.
 *
 * `AdapterError` (in `types.ts`) classifies *provider* failures so the retry loop
 * knows what to do. This is the other half: failures of **our own rules** — an
 * unconfirmed send, a re-used idempotency key — which need to reach two different
 * consumers intact.
 *
 * They are `ConvexError`s carrying structured data rather than bare `Error`s with
 * a formatted message, because both consumers need the machine-readable half:
 *
 *   - the REST layer maps `httpStatus` straight onto its response (the spec's 409
 *     on a re-used key is exactly this), and
 *   - the UI switches on `code` to decide which affordance to offer, and shows
 *     `message` verbatim.
 *
 * String-matching a message to recover either of those is how error handling
 * silently rots, so the code is the contract and the message is for the human.
 */

import { ConvexError, type Value } from "convex/values";

/**
 * Every rule this system enforces on the send path, named.
 *
 * `INDETERMINATE` is the one worth reading twice: it is not a failure, it is a
 * refusal to guess. The send may have gone out, so retrying under the same key
 * could double-send and the operator has to choose reconcile-or-clone instead.
 */
export type AppErrorCode =
  /** No such row, or not the caller's. Deliberately indistinguishable. */
  | "NOT_FOUND"
  /** The draft's connection is disabled, revoked, or the wrong provider. */
  | "CONNECTION_UNAVAILABLE"
  /** The draft is in a status this operation does not apply to. */
  | "INVALID_STATE"
  /** `confirm` was given a hash that is not the payload's current digest. */
  | "PAYLOAD_MISMATCH"
  /** `send` on a draft that was never confirmed. */
  | "CONFIRMATION_REQUIRED"
  /** Confirmed, then edited. The confirmation no longer describes the payload. */
  | "PAYLOAD_CHANGED_SINCE_CONFIRM"
  /** Two different payloads presented under one idempotency key. */
  | "IDEMPOTENCY_KEY_REUSED"
  /** The outcome of a delivery is genuinely unknown; retrying may double-send. */
  | "INDETERMINATE"
  /**
   * The REST caller did not echo the recipient back. The API's half of the
   * confirm gate: a send has to name where it is going, in the caller's own
   * words, before it happens.
   */
  | "DESTINATION_NOT_ACKNOWLEDGED"
  /** A per-user rate limit is exhausted. Carries `retryAfterMs`. */
  | "RATE_LIMITED"
  /** The request itself is malformed — a missing field, a bad enum. */
  | "BAD_REQUEST"
  /** No credential, or one that has been revoked. */
  | "UNAUTHENTICATED";

/**
 * The payload carried by the error. It extends the `Value` index signature
 * because `ConvexError`'s data has to be serialisable by Convex — which is the
 * whole reason the structure survives the trip to a client at all.
 */
export interface AppErrorData extends Record<string, Value | undefined> {
  code: AppErrorCode;
  message: string;
  /** What the REST layer should answer with. */
  httpStatus: number;
  /** Set on `RATE_LIMITED`: milliseconds until a retry can succeed. */
  retryAfterMs?: number;
}

const STATUS: Record<AppErrorCode, number> = {
  NOT_FOUND: 404,
  CONNECTION_UNAVAILABLE: 409,
  INVALID_STATE: 409,
  PAYLOAD_MISMATCH: 409,
  CONFIRMATION_REQUIRED: 409,
  PAYLOAD_CHANGED_SINCE_CONFIRM: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INDETERMINATE: 409,
  DESTINATION_NOT_ACKNOWLEDGED: 409,
  RATE_LIMITED: 429,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
};

/**
 * Build the error. The message is prefixed with the code so that a consumer which
 * only ever sees the flattened string — a server log, a `curl` of a stack trace —
 * still shows which rule fired.
 */
export function appError(code: AppErrorCode, message: string): ConvexError<AppErrorData> {
  return new ConvexError({
    code,
    message: `${code}: ${message}`,
    httpStatus: STATUS[code],
  });
}

/**
 * A rate-limit refusal, carrying when a retry will actually work.
 *
 * Separate from `appError` because the retry-after is not decoration: the REST
 * layer turns it into a `Retry-After` header, and a client that obeys it is the
 * difference between a rate limit that sheds load and one that gets hammered.
 */
export function rateLimitError(
  message: string,
  retryAfterMs: number,
): ConvexError<AppErrorData> {
  return new ConvexError({
    code: "RATE_LIMITED" as const,
    message: `RATE_LIMITED: ${message}`,
    httpStatus: STATUS.RATE_LIMITED,
    retryAfterMs: Math.max(0, Math.round(retryAfterMs)),
  });
}

/** Narrow a thrown value back to its structured form, for the REST layer. */
export function asAppError(err: unknown): AppErrorData | null {
  if (!(err instanceof ConvexError)) return null;
  const data: unknown = err.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("code" in data) ||
    !("httpStatus" in data) ||
    !("message" in data)
  ) {
    return null;
  }
  const { code, httpStatus, message, retryAfterMs } = data as Record<string, unknown>;
  if (typeof code !== "string" || typeof httpStatus !== "number" || typeof message !== "string") {
    return null;
  }
  return {
    code: code as AppErrorCode,
    httpStatus,
    message,
    retryAfterMs: typeof retryAfterMs === "number" ? retryAfterMs : undefined,
  };
}
