"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CheckGlyph,
  ChevronIcon,
  ContrastIcon,
  MoonIcon,
  SunIcon,
} from "./docs-icons";

type Choice = "auto" | "light" | "dark";

const CHOICES: { id: Choice; label: string; icon: (p: { className?: string }) => React.ReactNode }[] =
  [
    { id: "auto", label: "Auto", icon: ContrastIcon },
    { id: "light", label: "Light", icon: SunIcon },
    { id: "dark", label: "Dark", icon: MoonIcon },
  ];

const STORAGE_KEY = "docs-theme";
/** Same-document change signal. `storage` only fires in *other* tabs. */
const CHANGED = "docs-theme-changed";

/** Write the resolved theme where the CSS can see it, and remember the choice. */
function apply(choice: Choice) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = choice === "auto" ? (prefersDark ? "dark" : "light") : choice;
  document.documentElement.setAttribute("data-docs-theme", resolved);
  try {
    if (choice === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private mode, or storage disabled. The theme still applies for this page.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * The stored choice, read as an external store rather than copied into state.
 *
 * `localStorage` *is* an external store, and mirroring it into `useState` from
 * an effect is the cascading-render pattern the compiler rejects — correctly:
 * it renders once with the wrong value and again with the right one. This
 * subscribes instead, so the server renders `auto`, the client reads the real
 * value on its first pass, and another tab changing the theme is picked up for
 * free.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function readChoice(): Choice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

/** The server has no storage, and `auto` is what the layout renders against. */
const serverChoice = (): Choice => "auto";

/**
 * Auto / Light / Dark, as a menu rather than a two-state switch.
 *
 * Auto has to be reachable, not just be the initial value: a toggle that only
 * flips between light and dark gives someone who picked one no way back to
 * "follow my system", which is the setting most people actually want. The
 * blocking script in the layout resolves the stored choice before paint; this
 * only handles changing it.
 */
export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // While the choice is `auto`, the OS can change under us.
  useEffect(() => {
    if (choice !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("auto");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

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

  const current = CHOICES.find((c) => c.id === choice) ?? CHOICES[0];
  const CurrentIcon = current.icon;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
        className="d-border d-text-2 d-hover flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors"
      >
        <CurrentIcon className="h-4 w-4" />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronIcon className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open ? (
        <div
          role="menu"
          className="d-surface d-border absolute right-0 z-50 mt-1.5 w-40 overflow-hidden rounded-xl border py-1 shadow-lg"
        >
          {CHOICES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="menuitemradio"
              aria-checked={choice === id}
              onClick={() => {
                // `apply` writes storage and fires the change event; the
                // external store above turns that back into a render.
                apply(id);
                setOpen(false);
              }}
              className="d-text-2 d-hover flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors"
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {choice === id ? (
                <CheckGlyph
                  className="h-3.5 w-3.5 shrink-0"
                  // The tick is the only thing on the row that carries the
                  // accent, so selection reads without relying on weight.
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
