"use client";

import { useEffect, useState } from "react";
import { Logo } from "./Logo";

/**
 * What the app shows while it does not yet know who you are.
 *
 * None of it names the step that is running — checking a session, redirecting,
 * issuing a user row — because that is not the visitor's problem, and narrating
 * it made one continuous load look like three screens flashing past. What the
 * lines do instead is describe the *product*: by the time someone has read two
 * of them they know this thing pulls Gmail, Slack and the web into one place.
 *
 * They rotate only if the load actually takes a while. A fast handshake shows
 * the first line and nothing else, so the copy never turns into a slideshow
 * nobody asked for.
 */
const LINES = [
  "Rounding up your inboxes",
  "Teaching Gmail and Slack to sit together",
  "Counting unread badges, losing count",
  "Politely asking the web to hurry up",
  "Still here, still rounding",
] as const;

/** Long enough to read the line, short enough that a stuck load still moves. */
const ROTATE_MS = 2600;

export function AuthSplash() {
  const [line, setLine] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      // Sticks on the last line rather than looping: a splash that cycles
      // forever reads as a carousel, one that runs out of things to say reads
      // as something genuinely taking too long — which, by then, it is.
      () => setLine((i) => Math.min(i + 1, LINES.length - 1)),
      ROTATE_MS,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo className="h-10 w-10 animate-pulse text-white" />
      {/* Fixed height so a two-line phrase on a narrow screen does not shove the
          logo up as the copy changes. */}
      <div className="flex h-10 items-start justify-center">
        {/* `key` re-triggers the fade on every swap. Hidden from assistive tech:
            the copy is decorative, and an announcement every 2.6 seconds is a
            worse experience than one that just says "loading". */}
        <p
          key={line}
          aria-hidden
          className="fade-in max-w-[22rem] text-sm text-neutral-400"
        >
          {LINES[line]}
          <span className="type-caret ml-0.5 text-neutral-500">▍</span>
        </p>
      </div>
      <span role="status" className="sr-only">
        Loading
      </span>
    </div>
  );
}
