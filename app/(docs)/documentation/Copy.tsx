"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "../../(inbox)/icons";
import { CopyIcon } from "./docs-icons";

/**
 * Copy-to-clipboard for a code block.
 *
 * Lives permanently on the block's header bar rather than appearing on hover.
 * It used to fade in, which meant that on a phone — where the block scrolls
 * sideways and selecting a long `curl` by hand is the worst possible route —
 * the one affordance that replaces that was behind a gesture the device cannot
 * make.
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
        copied
          ? "bg-emerald-500/10 text-emerald-300"
          : "text-neutral-500 hover:bg-white/5 hover:text-neutral-200"
      }`}
    >
      {copied ? (
        <>
          <CheckIcon className="h-3 w-3" />
          Copied
        </>
      ) : (
        <>
          <CopyIcon className="h-3 w-3" />
          {label}
        </>
      )}
    </button>
  );
}
