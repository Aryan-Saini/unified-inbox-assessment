"use client";

import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AuthSplash } from "./AuthSplash";
import { AuthTrouble } from "./AuthTrouble";
import { SIGNED_OUT_PARAM } from "./authParams";
import { useHardRedirect } from "./useHardRedirect";
import { useStalled } from "./useStalled";

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
 * The three ways that goes wrong all end at `AuthTrouble` rather than a redirect
 * or an endless spinner — see the comments on `signedOut`, `unreachable` and
 * `stalled`.
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
   * clerk-js never started. Its own loading state has no timeout and no error
   * path — on an origin the browser will not call secure it stops before its
   * first Frontend API call and simply never resolves — so without this the gate
   * spins forever with nothing on screen or in the console to explain it.
   */
  const unreachable = useStalled(!isLoaded);

  /**
   * Signed into Clerk but not ready, for longer than a handshake takes. Either
   * Convex refused the JWT (`aud` or `CLERK_JWT_ISSUER_DOMAIN` wrong) or the row
   * never landed.
   *
   * The clock only starts once Clerk has confirmed a session, which is what keeps
   * this distinct from `unreachable`: timing plain clerk-js startup here would put
   * "you're signed in, but…" on screen while nobody knows yet whether you are.
   */
  const stalled = useStalled(isLoaded && isSignedIn === true && !ready);

  if (ready) return <>{children}</>;
  if (signedOut) return <AuthSplash label="Taking you to sign in" />;
  if (unreachable) return <AuthTrouble reason="unreachable" />;
  if (stalled) {
    return <AuthTrouble reason={!isLoading && !isAuthenticated ? "rejected" : "syncing"} />;
  }
  if (!isLoaded || isLoading) {
    return <AuthSplash label="Checking your session" />;
  }
  return <AuthSplash label="Setting up your account" />;
}
