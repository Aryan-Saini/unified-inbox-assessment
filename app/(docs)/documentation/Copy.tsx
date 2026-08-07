"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "../../(inbox)/icons";

/**
 * Copy-to-clipboard for a code block.
 *
 * The only interactive thing on this page, which is the point: everything a
 * reader — or a crawler, or an agent fetching the HTML — needs is in the
 * server-rendered markup, and this adds a convenience on top rather than being
 * the thing that makes the content appear.
 *
 * The confirmation is a state change on the button itself rather than a toast:
 * the feedback belongs next to the thing that was copied, and a page with
 * thirty code blocks would otherwise stack thirty notifications in a corner.
 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters because the reset is scheduled: navigating away
  // inside the two seconds would otherwise set state on a gone component.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        });
      }}
      aria-label={copied ? "Copied" : label}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
        copied
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : "border-line-strong bg-ink-900/80 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
      }`}
    >
      {copied ? (
        <>
          <CheckIcon className="h-3 w-3" />
          Copied
        </>
      ) : (
        label
      )}
    </button>
  );
}
