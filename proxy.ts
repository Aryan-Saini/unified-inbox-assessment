import { clerkMiddleware } from "@clerk/nextjs/server";

// Next.js 16 names this file `proxy.ts` (it was `middleware.ts` on <=15).
//
// No route matching happens here on purpose: Clerk now recommends protecting
// access as close to the resource as possible. Pages call `auth.protect()` and
// Convex functions check `ctx.auth.getUserIdentity()`, so a missed matcher
// entry can never silently expose data.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
