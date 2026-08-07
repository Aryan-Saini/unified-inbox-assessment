"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BracesIcon,
  ChevronIcon,
  LayersIcon,
  LockIcon,
  InboxGlyph,
  MenuGlyph,
  PlugGlyph,
  RocketIcon,
  SearchGlyph,
  SparkIcon,
  XGlyph,
} from "./docs-icons";

/** Icons cross the server/client boundary as names — components cannot. */
const GROUP_ICONS = {
  rocket: RocketIcon,
  lock: LockIcon,
  spark: SparkIcon,
  braces: BracesIcon,
  layers: LayersIcon,
  plug: PlugGlyph,
  inbox: InboxGlyph,
} as const;

export type GroupIcon = keyof typeof GROUP_ICONS;

export interface NavItem {
  id: string;
  label: string;
  /** Rendered before the label, for endpoint rows. */
  method?: "GET" | "POST";
}

export interface NavGroup {
  label: string;
  icon: GroupIcon;
  items: NavItem[];
}

/* ---------------------------------------------------------------- scroll spy */

/**
 * Which section the reader is actually looking at.
 *
 * Deliberately not `IntersectionObserver`: these sections are wildly uneven —
 * a two-paragraph note and a thousand-pixel endpoint card — so "most visible"
 * flickers between neighbours on a slow scroll. "The last heading that has
 * crossed the header" is what a reader means by where they are, and it is
 * stable because it only changes when a heading passes one line.
 */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // The sticky header is 60px; a heading is "reached" a little below it.
      const line = 96;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el === null) continue;
        if (el.getBoundingClientRect().top <= line) current = id;
      }
      // Bottom of the page: the last section can be too short to ever cross the
      // line, which would leave the final entry unreachable.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) {
        current = ids[ids.length - 1];
      }
      setActive(current);
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
  }, [ids]);

  return active;
}

/* ---------------------------------------------------------------------- rows */

/** The app's `StatusPill` shape and tints: emerald reads, indigo writes. */
function MethodTag({ method }: { method: "GET" | "POST" }) {
  return (
    <span
      className={`shrink-0 rounded-md border px-1 py-px font-mono text-[9.5px] leading-[1.5] font-medium ${
        method === "GET"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
      }`}
    >
      {method}
    </span>
  );
}

function ItemRow({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={`#${item.id}`}
      onClick={onNavigate}
      aria-current={active ? "location" : undefined}
      // The app marks the thing you are reading with a filled row — the search
      // history and the outbox rail both do it — so the docs do too rather than
      // introducing a third idiom for "you are here".
      className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
        active
          ? "bg-white/[0.07] text-white"
          : "text-neutral-400 hover:bg-white/5 hover:text-white"
      }`}
    >
      {item.method === undefined ? null : <MethodTag method={item.method} />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </a>
  );
}

/* --------------------------------------------------------------------- panel */

function NavPanel({
  groups,
  onNavigate,
}: {
  groups: NavGroup[];
  onNavigate?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl-K focuses the filter, which is the shortcut a reader arriving
  // from any other documentation site will already try. Escape gives the page
  // back, clearing first so the tree is whole again.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
      if (event.key === "Escape" && document.activeElement === input.current) {
        setFilter("");
        input.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const ids = useMemo(
    () => groups.flatMap((group) => group.items.map((item) => item.id)),
    [groups],
  );
  const active = useActiveSection(ids);

  const needle = filter.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      items:
        needle === ""
          ? group.items
          : group.items.filter(
              (item) =>
                item.label.toLowerCase().includes(needle) ||
                (item.method ?? "").toLowerCase().includes(needle),
            ),
    }))
    // A group whose every child was filtered out is noise, not context.
    .filter((group) => group.items.length > 0 || group.label.toLowerCase().includes(needle));

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pt-4 pb-2">
        <label className="relative block">
          <SearchGlyph className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-neutral-600" />
          <input
            ref={input}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            type="search"
            placeholder="Filter sections"
            aria-label="Filter sections"
            className="h-9 w-full rounded-lg border border-line-strong bg-white/[0.03] pr-14 pl-8.5 text-[13px] text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-neutral-600"
          />
          {/* Hidden once there is a value: the hint has done its job, and it
              would otherwise sit on top of what was typed. */}
          {filter === "" ? (
            <span className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 gap-1">
              {["⌘", "K"].map((key) => (
                <kbd
                  key={key}
                  className="rounded border border-line-strong px-1.5 py-0.5 font-sans text-[10px] leading-[1.4] text-neutral-500"
                >
                  {key}
                </kbd>
              ))}
            </span>
          ) : null}
        </label>
      </div>

      <nav
        aria-label="Documentation sections"
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-8"
      >
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-neutral-600">
            Nothing matches “{filter}”.
          </p>
        ) : null}

        {shown.map((group) => {
          const Icon = GROUP_ICONS[group.icon];
          return (
            <div key={group.label} className="mt-4 first:mt-1">
              <p className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {group.label}
              </p>
              <div className="mt-0.5 space-y-px">
                {group.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    active={item.id === active}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

/* ------------------------------------------------------------------- exports */

export function DocsSidebar({ groups }: { groups: NavGroup[] }) {
  return (
    <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[280px] shrink-0 border-r border-line bg-ink-900 lg:block">
      <NavPanel groups={groups} />
    </aside>
  );
}

/**
 * The same tree, as a drawer, below `lg`.
 *
 * A drawer rather than the disclosure this page used to have: the list is now
 * long enough that inlining it pushed the first paragraph below the fold on a
 * phone, and a reader who opens contents wants to leave immediately anyway.
 */
export function MobileNav({ groups }: { groups: NavGroup[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open documentation sections"
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[13px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white lg:hidden"
      >
        <MenuGlyph className="h-4 w-4" />
        <span className="hidden min-[420px]:inline">Sections</span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fade-in absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
          />
          <div className="slide-in-left absolute inset-y-0 left-0 flex w-[86vw] max-w-[320px] flex-col border-r border-line bg-ink-900">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
              <span className="text-[13px] font-semibold text-white">Sections</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
              >
                <XGlyph className="h-4.5 w-4.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <NavPanel groups={groups} onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export { ChevronIcon };
