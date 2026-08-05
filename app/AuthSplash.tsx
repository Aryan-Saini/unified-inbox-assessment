import { Logo } from "./Logo";

/**
 * What the app shows while it does not yet know who you are.
 *
 * Both gates render this, so "checking your session", "redirecting" and
 * "finishing setup" all look like one continuous load instead of three
 * different screens flashing past.
 */
export function AuthSplash({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo className="h-10 w-10 animate-pulse text-white" />
      <div className="flex items-center gap-2.5 text-sm text-neutral-400">
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300"
        />
        <span role="status">{label}…</span>
      </div>
    </div>
  );
}
