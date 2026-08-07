import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { SIGNED_OUT_PARAM } from "./app/authParams";

// Next.js 16 names this file `proxy.ts` (it was `middleware.ts` on <=15).
//
// This is the outer gate, and deliberately the only place that knows the route
// map. It decides on the Clerk session alone — no data reads — so it stays an
// optimistic check in the sense Next.js means: it saves a signed-out browser
// from ever rendering the shell, while enforcement stays next to the data.
// `AuthGate` covers the async window this cannot see (Clerk resolving in the
// browser, Convex trading that session for its own token), and every Convex
// function still resolves its own owner, so a mistake here cannot expose a row.
//
//   /          -> wherever you belong, so a bookmark or a lost `returnTo` lands
//   /sign-in   -> /auth, the route this page used to live at
//   /dashboard -> /auth when signed out
//   /outbox    -> /auth when signed out (same shell, same rule)
//   /auth      -> /dashboard when signed in (the gate closes behind you)

/** Same-origin redirect that keeps the query string — OAuth comes back with one. */
function redirectTo(request: NextRequest, pathname: string) {
  const url = new URL(pathname, request.url);
  url.search = request.nextUrl.search;
  return NextResponse.redirect(url);
}

const withClerk = clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();
  const { pathname, searchParams } = request.nextUrl;

  /**
   * All this can do is verify the session cookie, so it is the *stale* view of
   * two: clerk-js sees a session revoked in the dashboard or ended in another tab
   * seconds before the token stops verifying here. When the client says it has no
   * session, take its word for this request — otherwise the two rules below bounce
   * the browser back and forth until the token expires.
   */
  const signedIn = userId !== null && !searchParams.has(SIGNED_OUT_PARAM);

  if (pathname === "/" || pathname === "/sign-in") {
    return redirectTo(request, signedIn ? "/dashboard" : "/auth");
  }

  // Every route the signed-in shell renders. `/outbox` is a second entry into
  // the same app, so leaving it out here would have let a signed-out browser
  // render the shell and only then be turned away by `AuthGate`.
  const inApp = ["/dashboard", "/outbox"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
  if (!signedIn && inApp) {
    return redirectTo(request, "/auth");
  }

  if (signedIn && pathname === "/auth") {
    return redirectTo(request, "/dashboard");
  }

  return NextResponse.next();
});

/**
 * `/ui-stress` — the screenshot harness — never reaches Clerk.
 *
 * It is a development-only route (the page itself 404s outside `next dev`) that
 * renders components against fixtures, so it has no session and wants none. Left
 * to `clerkMiddleware` it gets the handshake redirect instead, which is a capture
 * of Clerk's error page rather than of the UI.
 */
export default function proxy(
  request: NextRequest,
  event: Parameters<typeof withClerk>[1],
) {
  if (
    process.env.NODE_ENV === "development" &&
    request.nextUrl.pathname.startsWith("/ui-stress")
  ) {
    return NextResponse.next();
  }
  return withClerk(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
