"use client";

import { useEffect, useState } from "react";
import { SignOutButton, useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AuthSplash } from "./AuthSplash";
import { SIGNED_OUT_PARAM } from "./authParams";
import { useHardRedirect } from "./useHardRedirect";

/** How long a handshake may take before we stop calling it "loading". */
const PATIENCE_MS = 6000;

/** Module scope so the params object is stable across renders. */
const SIGNED_OUT_MARK = { [SIGNED_OUT_PARAM]: "1" };

/**
 * The gate every signed-in screen sits behind.
 *
 * `proxy.ts` already turns a signed-out request for `/dashboard` into a redirect,
 * so this is not the only lock — it is the one that closes the window the server
 * check cannot see. Clerk resolves its session in the browser and Convex then
 * exchanges it for its own token, so there are two async steps between "page
 * rendered" and "queries may run". Children mount only after both finish, which
 * is why no query underneath needs to defend itself against being called signed
 * out.
 *
 * `stored` is part of that condition on purpose: an identity Convex accepts but
 * has not persisted yet makes `requireUser` throw "your account is still
 * syncing", so a brand-new user waits here for the row instead of seeing that.
 *
 * The two ways that goes wrong both end at `AuthTrouble` rather than a redirect
 * or an endless spinner — see the comments on `signedOut` and `stalled`.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();

  // Held at "skip" until Convex accepts the token: this query is safe signed
  // out, but skipping keeps the rule "no query fires before auth" absolute.
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : "skip");

  const ready = isAuthenticated && viewer?.stored === true;

  /**
   * Clerk, not Convex, decides who gets sent back to `/auth` — because Clerk is
   * the only thing `proxy.ts` can see. Redirecting because *Convex* rejected the
   * session would bounce off a proxy that still sees a valid Clerk cookie and
   * loop between the two forever.
   */
  const signedOut = isLoaded && !isSignedIn;
  useHardRedirect("/auth", signedOut, SIGNED_OUT_MARK);

  /**
   * Signed into Clerk but not ready, for longer than a handshake takes. Either
   * Convex refused the JWT (`aud` or `CLERK_JWT_ISSUER_DOMAIN` wrong) or the row
   * never landed. Both are dead ends: the shell never mounts, so its sign-out
   * never renders, and `/auth` sends a Clerk-signed-in visitor straight back. The
   * splash has to become something with a way out.
   *
   * The clock only starts once Clerk has confirmed a session. Timing plain
   * clerk-js startup would put "you're signed in, but…" on screen while nobody
   * knows yet whether you are.
   */
  const stalled = useStalled(isLoaded && isSignedIn === true && !ready, PATIENCE_MS);

  if (ready) return <>{children}</>;
  if (signedOut) return <AuthSplash label="Taking you to sign in" />;
  if (stalled) {
    return <AuthTrouble rejected={!isLoading && !isAuthenticated} />;
  }
  if (!isLoaded || isLoading) {
    return <AuthSplash label="Checking your session" />;
  }
  return <AuthSplash label="Setting up your account" />;
}

/** `true` once `ms` has passed with `active` continuously set. */
function useStalled(active: boolean, ms: number) {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setStalled(true), ms);
    // Clearing on the way out doubles as the reset, so a state that recovers and
    // stalls again waits the full patience the second time too.
    return () => {
      clearTimeout(timer);
      setStalled(false);
    };
  }, [active, ms]);

  return stalled;
}

/**
 * The escape hatch. Both routes out are here on purpose: reloading retries the
 * upsert (`StoreUser` runs again on mount), and signing out clears the Clerk
 * cookie, which is what makes `/auth` reachable again.
 */
function AuthTrouble({ rejected }: { rejected: boolean }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        {rejected ? "We can't verify your account" : "Your account is still syncing"}
      </h1>
      <p className="max-w-[28rem] text-sm text-neutral-400">
        {rejected
          ? "You're signed in, but the backend would not accept this session. If this keeps happening, the deployment's Clerk issuer or audience is misconfigured."
          : "You're signed in, but your account record hasn't arrived yet. This normally takes a moment."}
      </p>
      <div className="mt-2 flex gap-3">
        <button
          onClick={() => window.location.reload()}
          className="h-10 rounded-md bg-neutral-100 px-4 text-sm font-medium text-black transition-colors hover:bg-white"
        >
          Try again
        </button>
        <SignOutButton redirectUrl="/auth">
          <button className="h-10 rounded-md border border-neutral-800 px-4 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-600 hover:text-white">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
