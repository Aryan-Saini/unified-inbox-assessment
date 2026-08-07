"use client";

import { useAuth } from "@clerk/nextjs";
import { AuthSplash } from "./AuthSplash";
import { AuthTrouble } from "./AuthTrouble";
import { useHardRedirect } from "./useHardRedirect";
import { useStalled } from "./useStalled";

/**
 * The other half of the gate: `/auth` is closed to people who are already in.
 *
 * This is also what finishes the sign-in flow. `LoginForm` never navigates — it
 * finalizes the Clerk session and stops — so the moment `isSignedIn` flips here,
 * the redirect to the dashboard happens under a loading state.
 *
 * Clerk rather than Convex is the source of truth for this one: signed in is a
 * Clerk fact, and `/auth` reads nothing from the backend.
 *
 * `useHardRedirect` carries the query string on, which is what makes an OAuth
 * callback that arrived signed out survive: its params come here with it, and go
 * back to the dashboard once the session exists.
 *
 * `unreachable` matters more here than anywhere: this is the page you land on
 * when clerk-js cannot start, and without a timeout it is a spinner in front of
 * the sign-in form with no way past it.
 */
export function GuestGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  useHardRedirect("/dashboard", isLoaded && isSignedIn === true);

  const unreachable = useStalled(!isLoaded);

  if (unreachable) return <AuthTrouble reason="unreachable" />;
  if (!isLoaded || isSignedIn) return <AuthSplash />;

  return <>{children}</>;
}
