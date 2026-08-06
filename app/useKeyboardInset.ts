"use client";

import { useSyncExternalStore } from "react";

/**
 * How many pixels of the layout viewport the on-screen keyboard is covering.
 *
 * iOS does not resize the page when the keyboard opens — `100%`, `100vh` and even
 * `100dvh` all keep reporting the full window, so a button laid out at the bottom
 * of the screen ends up underneath the keyboard with no way to reach it. Only the
 * *visual* viewport shrinks, and only `visualViewport` reports that. It measures
 * the accessory bar above the keys too, which is the row of autofill pills that
 * was covering the confirm button on the code step.
 *
 * `offsetTop` is part of it because the visual viewport can also be scrolled down
 * within the layout viewport; what is occluded is whatever is left below it.
 *
 * Read through `useSyncExternalStore` rather than an effect so the first client
 * render already has the real value — an effect would lay the page out under the
 * keyboard and then correct itself, which reads as the form jumping.
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void) {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};

  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
  };
}

function getSnapshot(): number {
  const viewport = window.visualViewport;
  if (viewport === null) return 0;
  // Rounded because the value arrives fractional and drifts by hundredths as the
  // keyboard animates, and every distinct number is another render.
  return Math.max(
    0,
    Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
  );
}

/** No keyboard on the server, and none on the first paint before one opens. */
function getServerSnapshot(): number {
  return 0;
}
