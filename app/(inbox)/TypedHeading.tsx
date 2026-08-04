"use client";

import { useEffect, useState } from "react";

/** The sources the heading cycles through: "Search Gmail" → "Search Slack" → … */
const SOURCES = ["Gmail", "Slack", "the web"];

/** Longest label, used to reserve width so "Search" never shifts. */
const WIDEST = SOURCES.reduce((a, b) => (b.length > a.length ? b : a), "");

const TYPE_MS = 90; // per character, typing forward
const ERASE_MS = 45; // per character, backspacing — deliberately quicker
const HOLD_MS = 1600; // dwell on the finished word before erasing it

/**
 * The hero heading. "Search" is fixed and the source name types and erases
 * itself after it, so the headline states what the product does without a
 * second line of copy to explain it.
 *
 * Under prefers-reduced-motion the animation is skipped and every source is
 * simply named at once.
 */
export function TypedHeading() {
  const [reduced, setReduced] = useState(false);
  const [{ word, chars, erasing }, setState] = useState({
    word: 0,
    chars: 0,
    erasing: false,
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // One timer per frame: the delay depends on which phase we are in, so the
  // effect re-runs itself by depending on its own state.
  useEffect(() => {
    if (reduced) return;
    const atEnd = chars === SOURCES[word].length;
    const delay = erasing ? ERASE_MS : atEnd ? HOLD_MS : TYPE_MS;

    const timer = setTimeout(() => {
      setState((s) => {
        if (s.erasing) {
          return s.chars <= 1
            ? { word: (s.word + 1) % SOURCES.length, chars: 0, erasing: false }
            : { ...s, chars: s.chars - 1 };
        }
        return s.chars === SOURCES[s.word].length
          ? { ...s, erasing: true }
          : { ...s, chars: s.chars + 1 };
      });
    }, delay);

    return () => clearTimeout(timer);
  }, [reduced, word, chars, erasing]);

  return (
    // The accessible name is the stable full sentence: announcing the
    // mid-animation text would read out a new partial word every ~90ms.
    <h1
      aria-label="Search Gmail, Slack and the web"
      className="text-center text-[26px] leading-tight font-semibold tracking-tight text-white sm:text-[34px]"
    >
      {reduced ? (
        "Search Gmail, Slack and the web"
      ) : (
        <>
          Search{" "}
          {/* An inline grid with an invisible copy of the widest label in the
              same cell: the box is always as wide as "the web", so the word
              grows into reserved space instead of shoving "Search" sideways on
              every keystroke. */}
          <span className="relative inline-grid align-baseline">
            {/* Must match the typed span's font and size exactly, or the
                reserved width is wrong. The padding allows for the caret. */}
            <span
              aria-hidden
              className="invisible col-start-1 row-start-1 pr-[0.13em] font-mono text-[0.94em] tracking-tight"
            >
              {WIDEST}
            </span>
            {/* The one thing that differs: the typed half is set in mono, which
                nods at the typewriter without adding colour or extra weight.
                Sized at 0.94em because mono runs optically larger than sans. */}
            <span
              aria-hidden
              className="col-start-1 row-start-1 justify-self-start font-mono text-[0.94em] tracking-tight whitespace-pre"
            >
              {SOURCES[word].slice(0, chars)}
              <span className="type-caret ml-[0.06em] inline-block h-[0.82em] w-[0.06em] translate-y-[0.02em] rounded-full bg-white align-baseline" />
            </span>
          </span>
        </>
      )}
    </h1>
  );
}
