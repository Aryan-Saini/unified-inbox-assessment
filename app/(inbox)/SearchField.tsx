"use client";

import { forwardRef, useEffect, useRef, type ReactNode } from "react";
import { ArrowUpIcon, CloseIcon } from "./icons";

/** How tall the composer may grow before it scrolls instead. */
const MAX_LINES = 5;

/**
 * The one input in the product, and the same element in both states — hero
 * (vertically centred, nothing else on screen) and docked (pinned above the
 * result list). It looks identical in both: the field is the field, whether or
 * not there are results behind it.
 *
 * It is a textarea, not an input, so a long query wraps and the composer grows
 * with it instead of scrolling a single line you cannot read back. Enter
 * submits; Shift+Enter takes a newline.
 *
 * `footer` (connectors, and the run controls once there is a search to act on)
 * lives inside the same bordered box under a hairline, so the input and its
 * controls read as one composer rather than as stacked widgets.
 */
export const SearchField = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onClear: () => void;
    working: boolean;
    footer?: ReactNode;
  }
>(function SearchField({ value, onChange, onSubmit, onClear, working, footer }, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Grow to fit the content, up to five lines, then scroll inside.
   *
   * The cap is not cosmetic: unbounded growth eventually pushes the composer
   * taller than the centred column it sits in, at which point the pane's
   * `overflow-hidden` clips it and the field appears to vanish.
   *
   * Height is reset to `auto` first so the box can shrink again when text is
   * deleted, not only grow. The ceiling is measured from the element's own
   * computed line-height rather than hard-coded, so it stays five lines if the
   * type scale changes.
   */
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 28;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * MAX_LINES)}px`;
  }, [value]);

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="group relative overflow-hidden rounded-2xl border border-line-strong bg-ink-850 shadow-[0_18px_60px_-20px_rgba(0,0,0,0.9)] transition-colors duration-500 focus-within:border-neutral-600"
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <textarea
            ref={(node) => {
              inner.current = node;
              if (typeof ref === "function") ref(node);
              else if (ref) ref.current = node;
            }}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // Enter runs the search; a newline needs Shift, as in any composer.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Search Gmail, Slack and The Web…"
            aria-label="Search across every connected source"
            autoComplete="off"
            spellCheck={false}
            className="scrollbar-thin min-w-0 flex-1 resize-none bg-transparent text-[20px] leading-7 text-white outline-none placeholder:text-neutral-600"
          />

        </div>

        {/* The bar: connectors and run controls on the left, actions right. */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-1.5">
          <div className="min-w-0">{footer}</div>
          <div className="flex shrink-0 items-center gap-1">
            {/* The spinner does not sit on the submit button: it says something
                is running, and the source chips already say *which* source —
                putting it here as well would make one fact look like two. */}
            {working ? (
              <span
                role="status"
                aria-label="Searching"
                className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-400"
              />
            ) : null}

            {value.length > 0 ? (
              <button
                type="button"
                onClick={onClear}
                aria-label="Clear search"
                className="shrink-0 rounded-lg p-1.5 text-neutral-600 transition-colors hover:bg-white/5 hover:text-neutral-300"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            ) : null}

            {/* Enter already runs the search, so this is the discoverable half
                of the same action rather than a second one — and the thing a
                touch keyboard, which has no Enter-to-search convention, needs.
                Disabled on an empty field so the affordance never promises a
                search that `startSearch` would drop on the floor. */}
            <button
              type="submit"
              disabled={value.trim().length === 0}
              aria-label="Run search"
              title="Run search"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-white transition-colors hover:bg-indigo-400 disabled:bg-white/[0.06] disabled:text-neutral-600"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
});
