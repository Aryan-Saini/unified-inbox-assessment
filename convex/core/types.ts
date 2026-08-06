/**
 * The adapter contract.
 *
 * This file is the whole public surface between the merge layer and the
 * providers. The merge layer imports `SearchAdapter` and `Result` and nothing
 * else; it has no idea Gmail or Slack exist. Adding a source means writing one
 * module that satisfies `SearchAdapter` and listing it in the registry.
 *
 * `SearchAdapter` and `Result` are reproduced verbatim from the specification —
 * do not widen them. Everything provider-specific hides behind `AdapterContext`.
 */

export type Source = "gmail" | "slack" | "web";

/** The normalised result shape. Every adapter returns exactly this. */
export interface Result {
  source: string;
  id: string;
  title: string;
  snippet: string;
  author?: string;
  timestamp?: string; // ISO 8601
  url: string;
}

export interface SearchAdapter {
  source: Source;
  search(query: string, ctx: AdapterContext): Promise<Result[]>;
}

/**
 * Everything an adapter needs to do its job, and nothing about how it is being
 * run. The orchestrator builds this; the adapter treats it as read-only.
 *
 * Crucially the adapter never sees the `connections` row or the refresh token —
 * it gets an already-valid access token. Token lifecycle is the orchestrator's
 * problem, which is what keeps adapters small enough to be worth writing.
 */
export interface AdapterContext {
  /** A valid, already-refreshed access token. Absent for `web`. */
  accessToken?: string;
  /** Provider-side account identity, for building permalinks. */
  externalAccountId?: string;
  /** The scopes this grant actually holds, so an adapter can skip an optional
   *  call the user never authorised rather than spend a 403 discovering it. */
  scopes?: string[];
  /** Max results the adapter should return. Advisory. */
  limit: number;
  /** Aborts when the orchestrator's per-source deadline elapses. */
  signal: AbortSignal;
  /**
   * Test/demo affordance: delay the adapter by this many ms before it does any
   * work. Used to prove a slow source never blocks a fast one.
   */
  artificialDelayMs?: number;
}

/**
 * How a failure should be handled. Mirrors the `errorKind` union in the schema.
 * See the schema for the full meaning of each member.
 */
export type ErrorKind = "transient" | "permanent" | "needs_reconnect" | "unknown";

/**
 * The only error type adapters and senders are allowed to throw.
 *
 * Classification happens where the provider response is parsed — that is the
 * only place with enough information to tell a revoked grant from a rate limit.
 * Everything downstream (retry loop, UI, history) reads `kind` and never
 * re-inspects the message, so a misclassification is one bug in one place
 * rather than a string-match scattered across the codebase.
 */
export class AdapterError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus?: number;
  /** Provider error payload, kept verbatim for the detail view. */
  readonly detail?: string;

  constructor(
    kind: ErrorKind,
    message: string,
    options?: { httpStatus?: number; detail?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AdapterError";
    this.kind = kind;
    this.httpStatus = options?.httpStatus;
    this.detail = options?.detail;
  }

  static transient(message: string, options?: { httpStatus?: number; detail?: string }) {
    return new AdapterError("transient", message, options);
  }

  static permanent(message: string, options?: { httpStatus?: number; detail?: string }) {
    return new AdapterError("permanent", message, options);
  }

  static needsReconnect(message: string, options?: { httpStatus?: number; detail?: string }) {
    return new AdapterError("needs_reconnect", message, options);
  }

  static unknown(message: string, options?: { httpStatus?: number; detail?: string }) {
    return new AdapterError("unknown", message, options);
  }
}

/** Narrow an arbitrary thrown value to an `AdapterError`. */
export function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;

  const message = err instanceof Error ? err.message : String(err);

  // An aborted fetch means we hit our own deadline, not that the provider is
  // broken. Treated as transient so a re-run can succeed.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new AdapterError("transient", `Timed out: ${message}`, { cause: err });
  }

  // `fetch` rejects with a TypeError on DNS/connection failure.
  if (err instanceof TypeError) {
    return AdapterError.transient(`Network error: ${message}`);
  }

  // Anything unrecognised is permanent on purpose: an unclassified error
  // auto-retrying forever is worse than one an operator has to look at.
  return AdapterError.permanent(message, { detail: stringifyCause(err) });
}

function stringifyCause(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.stack === undefined) return undefined;
  return err.stack;
}

/**
 * Map an HTTP status to a default classification. Adapters override this when
 * the provider carries a more specific signal in the body (Slack, for one,
 * returns `200 {ok: false, error: "token_revoked"}`).
 */
export function classifyHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "needs_reconnect";
  if (status === 408 || status === 429) return "transient";
  if (status >= 500) return "transient";
  return "permanent";
}
