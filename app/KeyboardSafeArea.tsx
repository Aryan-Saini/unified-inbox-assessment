"use client";

import { useKeyboardInset } from "./useKeyboardInset";

/**
 * Centres its children in whatever the keyboard has left of the screen.
 *
 * The keyboard's height becomes bottom padding, so `justify-center` centres
 * against the *visible* area rather than the full window — the form rises as the
 * keyboard opens instead of disappearing behind it. `overflow-y-auto` is the
 * backstop for the case where even the reduced area is too short, on a small
 * phone in landscape: scrolling to the button beats not having one.
 *
 * `pb-24` only applies with the keyboard down. It exists to offset the header
 * above, so that the form looks centred on the screen rather than centred in the
 * space under the header — an optical correction that stops being a correction
 * once the keyboard defines the bottom of the space.
 */
export function KeyboardSafeArea({ children }: { children: React.ReactNode }) {
  const inset = useKeyboardInset();

  return (
    <div
      className={`flex flex-1 items-center justify-center overflow-y-auto px-6 ${
        inset === 0 ? "pb-24" : ""
      }`}
      style={inset === 0 ? undefined : { paddingBottom: inset }}
    >
      {children}
    </div>
  );
}
