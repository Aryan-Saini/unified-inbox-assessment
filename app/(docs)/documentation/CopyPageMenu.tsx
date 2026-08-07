"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  BracesIcon,
  CheckGlyph,
  ChevronIcon,
  CopyIcon,
} from "./docs-icons";

/**
 * "Copy page" — the affordance that makes this page useful to an agent that
 * *is* looking at the HTML.
 *
 * The four machine-readable files are already linked further down, but by then
 * a model has read a screenful of prose it did not need. Putting the markdown
 * one keystroke from the title means the cheapest correct action — take the
 * markdown, ignore the page — is also the most obvious one.
 *
 * The copy fetches `llms-full.txt` rather than serialising the DOM: the DOM is
 * a rendering of the markdown, and re-deriving one from the other is how the
 * two start to disagree.
 */
export function CopyPageMenu({ origin }: { origin: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function copyMarkdown() {
    setState("copying");
    try {
      const response = await fetch(`${origin}/documentation/llms-full.txt`);
      if (!response.ok) throw new Error(String(response.status));
      await navigator.clipboard.writeText(await response.text());
      setState("copied");
    } catch {
      // Reported on the button rather than swallowed: a copy that silently did
      // nothing is worse than one that says so, because the reader pastes.
      setState("failed");
    }
    setOpen(false);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  const label =
    state === "copying"
      ? "Copying…"
      : state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : "Copy page";

  return (
    <div ref={root} className="relative">
      <div className="d-border flex items-center overflow-hidden rounded-full border">
        <button
          type="button"
          onClick={() => void copyMarkdown()}
          disabled={state === "copying"}
          className="d-text-2 d-hover flex h-8 items-center gap-1.5 pr-2 pl-2.5 text-[12.5px] font-medium transition-colors disabled:opacity-60"
        >
          {state === "copied" ? (
            <CheckGlyph className="h-3.5 w-3.5" />
          ) : (
            <CopyIcon className="h-3.5 w-3.5" />
          )}
          {label}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More page formats"
          className="d-text-2 d-hover d-border flex h-8 items-center border-l px-1.5 transition-colors"
        >
          <ChevronIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {open ? (
        <div
          role="menu"
          className="d-surface d-border absolute right-0 z-50 mt-1.5 w-72 overflow-hidden rounded-xl border py-1 shadow-lg"
        >
          <Entry
            href={`${origin}/documentation/llms-full.txt`}
            icon={<ArrowUpRightIcon className="h-4 w-4" />}
            title="View as Markdown"
            hint="The whole reference, one file"
          />
          <Entry
            href={`${origin}/documentation/llms.txt`}
            icon={<ArrowUpRightIcon className="h-4 w-4" />}
            title="llms.txt"
            hint="The index, and the send protocol"
          />
          <Entry
            href={`${origin}/documentation/openapi.json`}
            icon={<BracesIcon className="h-4 w-4" />}
            title="OpenAPI 3.1"
            hint="For client generation"
          />
          <Entry
            href={`${origin}/documentation/AGENTS.md`}
            icon={<ArrowUpRightIcon className="h-4 w-4" />}
            title="AGENTS.md"
            hint="Commit into a repo as agent instructions"
          />
        </div>
      ) : null}
    </div>
  );
}

function Entry({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <a
      role="menuitem"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="d-hover flex items-start gap-2.5 px-3 py-2 transition-colors"
    >
      <span className="d-text-3 mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="d-text block text-[13px] font-medium">{title}</span>
        <span className="d-text-3 block text-[11.5px]">{hint}</span>
      </span>
    </a>
  );
}
