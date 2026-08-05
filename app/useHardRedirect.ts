"use client";

import { useEffect, useRef } from "react";
import { SIGNED_OUT_PARAM } from "./authParams";

/**
 * Navigate away, once, with a real page load.
 *
 * `router.replace` is the usual answer and it is the wrong one here: `/auth` and
 * `/dashboard` live in route groups with separate root layouts, and Next.js does
 * a full page load when you cross between those (see the route-groups caveats).
 * Asking the client router to do it leaves the browser sitting on the old route —
 * observed, not theoretical — so this asks the browser directly.
 *
 * It also means `proxy.ts` re-runs on the way in, so the server and the client
 * can never disagree about where you belong.
 *
 * The current query string comes along, because a bounce is not supposed to lose
 * anything: the OAuth callback lands on `/dashboard?connected=gmail`, and if that
 * arrives signed out the params have to survive `/auth` and the trip back, or the
 * "Connected" toast is silently dropped.
 */
export function useHardRedirect(
  pathname: string,
  when: boolean,
  extraParams?: Record<string, string>,
) {
  const sent = useRef(false);

  useEffect(() => {
    if (!when || sent.current) return;
    sent.current = true;

    const target = new URL(pathname, window.location.origin);
    const carried = new URLSearchParams(window.location.search);
    carried.delete(SIGNED_OUT_PARAM);
    carried.forEach((value, key) => target.searchParams.set(key, value));
    for (const [key, value] of Object.entries(extraParams ?? {})) {
      target.searchParams.set(key, value);
    }

    window.location.replace(`${target.pathname}${target.search}`);
  }, [pathname, when, extraParams]);
}
