"use client";

import { forwardRef } from "react";
import { EXAMPLE_QUERIES } from "./mock-data";
import { ArrowUpIcon, CloseIcon, SearchIcon } from "./icons";

/**
 * The one input in the product. It is the same element in both states — hero
 * (vertically centred, nothing else on screen) and docked (pinned above the
 * result list) — so the browser animates it rather than swapping it out. That
 * is what makes the Google-style lift read as one continuous motion instead of
 * a cut between two screens.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onClear: () => void;
    hero: boolean;
    working: boolean;
  }
>(function SearchField({ value, onChange, onSubmit, onClear, hero, working }, ref) {
  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className={`group relative flex items-center gap-3 rounded-2xl border bg-ink-850 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] focus-within:border-indigo-500/60 focus-within:bg-ink-800 focus-within:shadow-[0_0_0_4px_rgba(99,102,241,0.10)] ${
          hero
            ? "border-line-strong px-5 py-4 shadow-[0_18px_60px_-20px_rgba(0,0,0,0.9)]"
            : "border-line px-4 py-2.5"
        }`}
      >
        <SearchIcon
          className={`shrink-0 text-neutral-500 transition-all duration-500 group-focus-within:text-indigo-300 ${
            hero ? "h-5 w-5" : "h-4.5 w-4.5"
          }`}
        />

        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search Gmail, Slack and the web…"
          aria-label="Search across every connected source"
          autoComplete="off"
          spellCheck={false}
          className={`min-w-0 flex-1 bg-transparent text-white transition-all duration-500 outline-none placeholder:text-neutral-600 ${
            hero ? "text-[17px]" : "text-[15px]"
          }`}
        />

        {value.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            className="shrink-0 rounded-md p-1 text-neutral-600 transition-colors hover:bg-white/5 hover:text-neutral-300"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        ) : null}

        <button
          type="submit"
          disabled={value.trim().length === 0}
          aria-label="Run search"
          className={`relative flex shrink-0 items-center justify-center rounded-xl bg-indigo-500 text-white transition-all duration-300 hover:bg-indigo-400 disabled:bg-white/[0.06] disabled:text-neutral-600 ${
            hero ? "h-9 w-9" : "h-8 w-8"
          }`}
        >
          {working ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <ArrowUpIcon className={hero ? "h-4.5 w-4.5" : "h-4 w-4"} />
          )}
        </button>
      </form>

      {/* Suggestions only exist in the hero state; docked, the results are the
          content and chips would just be noise. */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          hero ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 pt-4">
            <span className="text-[12px] text-neutral-600">Try</span>
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                tabIndex={hero ? 0 : -1}
                onClick={() => {
                  onChange(q);
                  onSubmit();
                }}
                className="rounded-full border border-line bg-white/[0.02] px-3 py-1.5 text-[12px] text-neutral-400 transition-colors hover:border-line-strong hover:bg-white/[0.05] hover:text-neutral-200"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
