/**
 * Deliberate fault injection, for demonstrating failure handling without
 * waiting for a real outage.
 *
 * This exists because several of the success criteria — "a simulated transient
 * error is retried with backoff", "one source is artificially slow" — are only
 * observable if the system can be told to misbehave on request.
 *
 * Two guardrails keep this out of production's way:
 *   1. It is inert unless `ALLOW_FAULT_INJECTION=true` is set on the deployment.
 *   2. Every injected fault is recorded in history with an unmistakable prefix,
 *      so a reviewer can never mistake a simulated failure for a real one.
 */

import { AdapterError, type ErrorKind } from "./types";

export const INJECTED_PREFIX = "[simulated]";

export function faultInjectionEnabled(): boolean {
  return process.env.ALLOW_FAULT_INJECTION === "true";
}

/**
 * Throw the requested failure, if fault injection is both requested and
 * permitted. A no-op otherwise, so leaving the flag on a draft is harmless once
 * the deployment disables injection.
 */
export function maybeInjectFailure(kind: ErrorKind | undefined): void {
  if (kind === undefined || !faultInjectionEnabled()) return;

  const messages: Record<ErrorKind, string> = {
    transient: `${INJECTED_PREFIX} provider returned 503 Service Unavailable`,
    permanent: `${INJECTED_PREFIX} recipient address was rejected as invalid`,
    needs_reconnect: `${INJECTED_PREFIX} the grant for this connection was revoked`,
    unknown: `${INJECTED_PREFIX} the connection dropped before the provider acknowledged the send`,
  };

  const httpStatus: Partial<Record<ErrorKind, number>> = {
    transient: 503,
    permanent: 400,
    needs_reconnect: 401,
  };

  throw new AdapterError(kind, messages[kind], { httpStatus: httpStatus[kind] });
}

/**
 * Pause before an adapter does any work, to prove a slow source does not block
 * a fast one. Capped so a bad value cannot wedge a worker.
 */
export async function maybeDelay(ms: number | undefined, signal: AbortSignal): Promise<void> {
  if (ms === undefined || ms <= 0 || !faultInjectionEnabled()) return;

  const capped = Math.min(ms, 60_000);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, capped);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted while in an injected delay", "AbortError"));
      },
      { once: true },
    );
  });
}
