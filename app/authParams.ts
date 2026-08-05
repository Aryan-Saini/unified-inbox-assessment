/**
 * Shared between `proxy.ts` (middleware) and the client gates, which is why it
 * lives alone in a module with no imports and no `"use client"` — pulling React
 * into the middleware bundle to read one string would be a poor trade.
 */

/**
 * Marks a bounce that the *client* asked for because Clerk reported no session.
 *
 * `proxy.ts` decides on the session cookie, which it can only verify — it cannot
 * see a session revoked in the Clerk dashboard or ended in another tab, and
 * clerk-js can. For the remaining seconds of that token the two disagree, and the
 * two redirect rules would bounce the browser between `/dashboard` and `/auth` in
 * full page loads. This param is the breaker: the proxy takes the client's word
 * for one request instead of sending it straight back.
 *
 * It never travels further than that request, so `useHardRedirect` strips it from
 * anything it carries onward.
 */
export const SIGNED_OUT_PARAM = "signed_out";
