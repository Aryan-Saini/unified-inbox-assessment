import { Logo } from "./Logo";

/**
 * What the app shows while it does not yet know who you are.
 *
 * Deliberately says nothing about which step is running. Checking a session,
 * redirecting, issuing a user row — none of that is the visitor's problem, and
 * narrating it only made a single continuous load look like three screens
 * flashing past.
 */
export function AuthSplash() {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo className="h-10 w-10 animate-pulse text-white" />
      <div className="flex items-center gap-2.5 text-sm text-neutral-400">
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300"
        />
        <span role="status">Loading…</span>
      </div>
    </div>
  );
}
