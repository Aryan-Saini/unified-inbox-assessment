"use client";

import { SignOutButton } from "@clerk/nextjs";

/**
 * Which of the three ways the sign-in handshake dead-ends we are looking at.
 *
 * - `unreachable` — clerk-js never finished loading, so nobody knows yet whether
 *   there is a session at all. Nothing under Clerk works, sign-out included.
 * - `rejected` — Clerk has a session and Convex refused the token it was traded
 *   for (`aud`, or `CLERK_JWT_ISSUER_DOMAIN` pointing at the other deployment).
 * - `syncing` — Convex accepted the identity but the user row has not landed, so
 *   `requireUser` would throw "your account is still syncing".
 */
export type TroubleReason = "unreachable" | "rejected" | "syncing";

/**
 * The escape hatch every gate falls through to instead of spinning forever.
 *
 * All three cases are dead ends the user cannot leave on their own: the shell
 * never mounts, so its sign-out never renders, and `/auth` sends a Clerk-signed-in
 * visitor straight back. So the splash has to become something with a way out.
 *
 * Reloading retries the whole handshake (`StoreUser` runs again on mount), and
 * signing out clears the Clerk cookie, which is what makes `/auth` reachable
 * again. `unreachable` gets no sign-out button on purpose — `SignOutButton` needs
 * the clerk-js that just failed to load, so it would be a button that cannot work.
 */
export function AuthTrouble({ reason }: { reason: TroubleReason }) {
  const copy = COPY[reason];

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="max-w-[28rem] text-sm text-neutral-400">{copy.body}</p>
      {reason === "unreachable" && <InsecureOriginHint />}
      <div className="mt-2 flex gap-3">
        <button
          onClick={() => window.location.reload()}
          className="h-10 rounded-md bg-neutral-100 px-4 text-sm font-medium text-black transition-colors hover:bg-white"
        >
          Try again
        </button>
        {reason !== "unreachable" && (
          <SignOutButton redirectUrl="/auth">
            <button className="h-10 rounded-md border border-neutral-800 px-4 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-600 hover:text-white">
              Sign out
            </button>
          </SignOutButton>
        )}
      </div>
    </div>
  );
}

const COPY: Record<TroubleReason, { title: string; body: string }> = {
  unreachable: {
    title: "We can't reach the sign-in service",
    body: "The page loaded, but Clerk never finished starting up, so we don't know whether you're signed in.",
  },
  rejected: {
    title: "We can't verify your account",
    body: "You're signed in, but the backend would not accept this session. If this keeps happening, the deployment's Clerk issuer or audience is misconfigured.",
  },
  syncing: {
    title: "Your account is still syncing",
    body: "You're signed in, but your account record hasn't arrived yet. This normally takes a moment.",
  },
};

/**
 * Names the one cause of `unreachable` that looks like a bug in this app and is
 * not: an origin the browser does not consider secure.
 *
 * `http://<lan-ip>:3000` withholds `crypto.subtle` and `crypto.randomUUID`, and
 * clerk-js stops before its first Frontend API call without throwing — so the
 * only symptom is a spinner that never resolves. Reading `isSecureContext` during
 * render is safe here because this only renders after a client-side timer, well
 * past hydration. `pnpm dev:lan` is the fix.
 */
function InsecureOriginHint() {
  if (window.isSecureContext) return null;

  return (
    <p className="max-w-[28rem] text-sm text-amber-300/80">
      This page is on <code className="font-mono">{window.location.origin}</code>, which the browser
      does not treat as a secure origin — sign-in cannot work over plain HTTP outside{" "}
      <code className="font-mono">localhost</code>. Serve it over HTTPS with{" "}
      <code className="font-mono">pnpm dev:lan</code>.
    </p>
  );
}
