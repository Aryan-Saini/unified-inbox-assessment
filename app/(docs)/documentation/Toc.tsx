"use client";

import { useEffect, useState } from "react";
import { ContentsGlyph } from "./docs-icons";
import type { TocEntry } from "./pages";

/**
 * "On this page" — the right-hand rail.
 *
 * Which heading the reader is actually looking at is deliberately *not* an
 * `IntersectionObserver` question. Sections here are wildly uneven — a
 * two-paragraph note beside a thousand-pixel endpoint card — so "most visible"
 * flickers between neighbours on a slow scroll. "The last heading that has
 * crossed the header" is what a reader means by where they are, and it only
 * changes when a heading passes one line, so it is stable.
 */
function useActiveHeading(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // The sticky header is 56px; a heading counts as reached below it.
      const line = 104;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el === null) continue;
        if (el.getBoundingClientRect().top <= line) current = id;
      }
      // The last section can be too short to ever cross the line, which would
      // leave the final entry permanently unreachable.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) {
        current = ids[ids.length - 1];
      }
      // At the top of a page nothing has crossed the line yet, and an empty
      // rail reads as broken rather than as "not scrolled". The first entry is
      // what the reader is looking at.
      setActive(current ?? ids[0]);
    };

    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // `ids` is rebuilt per page; joining keeps the effect from re-running on
    // every render just because the array identity changed.
  }, [ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  return active;
}

export function Toc({ entries }: { entries: TocEntry[] }) {
  const active = useActiveHeading(entries.map((entry) => entry.id));

  if (entries.length === 0) return null;

  return (
    <div className="pt-9 pr-6 pb-16">
      <p className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-neutral-300">
        <ContentsGlyph className="h-4 w-4 text-neutral-600" />
        On this page
      </p>
      <nav aria-label="On this page" className="border-l border-line">
        {entries.map((entry) => {
          const current = entry.id === active;
          return (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              aria-current={current ? "location" : undefined}
              className={`-ml-px block border-l py-1.5 pr-2 pl-3 text-[13.5px] leading-snug transition-colors ${
                current
                  ? "border-indigo-400 text-indigo-300"
                  : "border-transparent text-neutral-500 hover:text-neutral-200"
              } ${entry.depth === 2 ? "pl-6" : ""}`}
            >
              {entry.method === undefined ? (
                entry.label
              ) : (
                <span className="font-mono text-[13px]">
                  <span className="text-neutral-600">{entry.method} </span>
                  {entry.label}
                </span>
              )}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
