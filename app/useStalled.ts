"use client";

import { useEffect, useState } from "react";

/** How long a handshake may take before we stop calling it "loading". */
export const PATIENCE_MS = 6000;

/** `true` once `ms` has passed with `active` continuously set. */
export function useStalled(active: boolean, ms: number = PATIENCE_MS) {
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
