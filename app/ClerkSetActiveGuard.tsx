"use client";

import { useEffect } from "react";

/**
 * Stops a Clerk sign-in from deadlocking behind a proxy.
 *
 * `ClerkProvider` publishes `window.__internal_onBeforeSetActive`, and
 * `Clerk.setActive` awaits whatever it returns before it completes the session
 * — which is what our `finalize({ navigate })` callback is waiting on. Clerk's
 * implementation invokes its `invalidateCacheAction()` Server Action as
 * `void action().then(() => resolve())`, with no `.catch`: if the action
 * rejects, the promise it handed `setActive` never settles and the whole
 * sign-in hangs. GitHub Codespaces makes that the normal case, because the
 * port-forwarding proxy rewrites the host and the POST fails Next.js's Server
 * Action CSRF origin check with a 500 — the form then sits on "Verifying…"
 * forever even though Clerk already established the session.
 *
 * So we wrap the hook: delegate to Clerk's, but swallow rejections and give it
 * a deadline. Skipping it costs nothing here. All the action does is bust
 * Next's client-side router cache, and this app finishes authentication with a
 * full document navigation, which discards that cache anyway.
 */

/** Clerk's hook, as `ClerkProvider` writes it onto `window`. */
type OnBeforeSetActive = (intent?: "sign-out") => Promise<void> | void;

declare global {
  interface Window {
    __internal_onBeforeSetActive?: OnBeforeSetActive;
  }
}

/** How long Clerk's hook may take before we stop waiting on it. */
const HOOK_TIMEOUT_MS = 1500;

/** Anything carrying the hook — `window` in the app, a stub in tests. */
type HookHost = { __internal_onBeforeSetActive?: OnBeforeSetActive };

/**
 * Replaces the hook on `host` with a guarded version, and returns the undo so
 * an effect can restore whatever was there on unmount.
 */
export function installSetActiveGuard(host: HookHost): () => void {
  const original = host.__internal_onBeforeSetActive;

  const guarded: OnBeforeSetActive = (intent) =>
    Promise.race([
      // `resolve().then(...)` rather than a bare call, so a hook that throws
      // synchronously rejects the race instead of escaping it.
      Promise.resolve()
        .then(() => original?.(intent))
        .then(() => undefined)
        .catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, HOOK_TIMEOUT_MS)),
    ]);

  host.__internal_onBeforeSetActive = guarded;

  return () => {
    // Only stand down if nothing else took the hook over in the meantime.
    if (host.__internal_onBeforeSetActive === guarded) {
      host.__internal_onBeforeSetActive = original;
    }
  };
}

/** Mount inside `ClerkProvider`. Renders nothing. */
export function ClerkSetActiveGuard() {
  // A passive effect, deliberately: `ClerkProvider` installs the hook in a
  // layout effect, so by the time this runs in the same commit there is
  // already an original to wrap.
  useEffect(() => installSetActiveGuard(window), []);

  return null;
}
