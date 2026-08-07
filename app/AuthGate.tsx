"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AuthSplash } from "./AuthSplash";
import { AuthTrouble } from "./AuthTrouble";
import { SIGNED_OUT_PARAM } from "./authParams";
import { useHardRedirect } from "./useHardRedirect";
import { useStalled } from "./useStalled";

/** Module scope so the params object is stable across renders. */
const SIGNED_OUT_MARK = { [SIGNED_OUT_PARAM]: "1" };

/** Backoff between `store` retries, capped. */
const RETRY_MS = [400, 1000, 2000, 4000] as const;

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
 * The third step is the user row, and this gate *creates* it rather than waiting
 * for it. The Clerk webhook is the authoritative sync, but it is asynchronous and
 * can be late or (with a bad signing secret) never arrive — and a missing row is
 * not something the person can do anything about. Everything the row needs is in
 * the Convex JWT already, so `users.store` issues it on the spot; the mutation
 * upserts on `clerkUserId` inside one transaction, so racing the webhook or a
 * second tab still yields exactly one row. That is why there is no "your account
 * is still syncing" screen any more — the case it described now fixes itself
 * while the loading state is still on screen.
 *
 * Only the two states nobody can resolve by waiting still end at `AuthTrouble`:
 * clerk-js never started, or Convex refused the token. Everything else is a load.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const store = useMutation(api.users.store);

  /** Set once `store` has returned — i.e. the row is known to exist. Mutations
   *  are one-shot calls, not subscriptions, so this is the only way to hold the
   *  gate closed until it resolves. Live data arrives afterwards, through the
   *  children's own `useQuery` subscriptions. */
  const [provisioned, setProvisioned] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;

    // Retried rather than surfaced: a failure here is a transient backend blip,
    // and the old behaviour — an error panel offering a reload — was a worse
    // version of retrying. If it never succeeds, `stalled` below still has the
    // last word.
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          await store();
          if (!cancelled) setProvisioned(true);
          return;
        } catch {
          const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    })();

    return () => {
      cancelled = true;
      // Resets on sign-out, so the next identity re-runs the upsert instead of
      // inheriting the previous one's "ready".
      setProvisioned(false);
    };
  }, [isAuthenticated, store]);

  const ready = isAuthenticated && provisioned;

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
   * Signed into Clerk, and Convex has settled on "not authenticated" — the JWT
   * was refused (`aud`, or `CLERK_JWT_ISSUER_DOMAIN` pointing at the other
   * deployment). Nothing here retries its way out of that, so it is the one
   * signed-in state that earns a panel.
   *
   * The clock only starts once Clerk has confirmed a session, which is what keeps
   * this distinct from `unreachable`: timing plain clerk-js startup here would put
   * "you're signed in, but…" on screen while nobody knows yet whether you are.
   */
  const rejected = useStalled(
    isLoaded && isSignedIn === true && !isLoading && !isAuthenticated,
  );

  if (ready) return <>{children}</>;
  if (unreachable) return <AuthTrouble reason="unreachable" />;
  if (rejected) return <AuthTrouble reason="rejected" />;
  return <AuthSplash />;
}
