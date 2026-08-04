/**
 * Shared HTTP plumbing for every adapter and sender.
 *
 * Two things live here that would otherwise be copy-pasted per provider, and
 * drift: turning a non-2xx response into a correctly-classified `AdapterError`,
 * and the backoff schedule.
 */

import { AdapterError, classifyHttpStatus, toAdapterError } from "./types";

export interface FetchJsonOptions extends RequestInit {
  /** Aborts the request when the caller's deadline elapses. */
  signal?: AbortSignal;
  /** Provider name, used only to make error messages legible. */
  label?: string;
}

/**
 * `fetch` + JSON parse, where every failure path throws a classified
 * `AdapterError` instead of something the retry loop has to guess about.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { label = "provider", ...init } = options;

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // Connection-level failure: no status to classify, so fall back to the
    // shape of the thrown error (abort vs network).
    throw toAdapterError(err);
  }

  const bodyText = await response.text();

  if (!response.ok) {
    throw new AdapterError(
      classifyHttpStatus(response.status),
      `${label} returned ${response.status} ${response.statusText}`,
      { httpStatus: response.status, detail: bodyText.slice(0, 4000) },
    );
  }

  if (bodyText === "") return undefined as T;

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    // A 200 with unparseable JSON is a provider bug, not something a retry
    // fixes on its own — but it is also not the operator's fault, so transient.
    throw AdapterError.transient(`${label} returned a non-JSON 200 response`, {
      httpStatus: response.status,
      detail: bodyText.slice(0, 4000),
    });
  }
}

/**
 * Combine the orchestrator's deadline with a per-request timeout, so one slow
 * provider call cannot hold a worker open past the fan-out budget.
 */
export function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter matters more than the base delay here: without it, a rate limit that
 * trips several sends at once retries them all in lockstep and trips it again.
 * `attempt` is 1-based.
 */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(Math.random() * exponential);
}

/**
 * Retry `fn` while it throws transient errors.
 *
 * Deliberately narrow: only `transient` is retried. `permanent` and
 * `needs_reconnect` throw straight through so the operator sees them
 * immediately, and `unknown` is never retried because a blind retry after an
 * indeterminate send is precisely the double-send this system exists to avoid.
 *
 * Used for read paths and token refresh. The send path does *not* use this — it
 * persists each attempt to the database between tries so the timeline survives
 * a worker restart.
 */
export async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  options: { maxAttempts?: number; baseMs?: number; onRetry?: (attempt: number, err: AdapterError) => void } = {},
): Promise<T> {
  const { maxAttempts = 3, baseMs = 300, onRetry } = options;

  let lastError: AdapterError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const adapterError = toAdapterError(err);
      if (adapterError.kind !== "transient" || attempt === maxAttempts) {
        throw adapterError;
      }
      lastError = adapterError;
      onRetry?.(attempt, adapterError);
      await sleep(backoffMs(attempt, baseMs, 5_000));
    }
  }

  /* c8 ignore next -- unreachable: the loop either returns or throws. */
  throw lastError ?? AdapterError.unknown("retryTransient exhausted with no error");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
