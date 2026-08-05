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
//   /auth      -> /dashboard when signed in (the gate closes behind you)

/** Same-origin redirect that keeps the query string — OAuth comes back with one. */
function redirectTo(request: NextRequest, pathname: string) {
  const url = new URL(pathname, request.url);
  url.search = request.nextUrl.search;
  return NextResponse.redirect(url);
}

export default clerkMiddleware(async (auth, request) => {
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

  const onDashboard =
    pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  if (!signedIn && onDashboard) {
    return redirectTo(request, "/auth");
  }

  if (signedIn && pathname === "/auth") {
    return redirectTo(request, "/dashboard");
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
