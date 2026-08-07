"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DocSection, GroupIcon } from "./pages";
import {
  BracesIcon,
  InboxGlyph,
  LayersIcon,
  LockIcon,
  MenuGlyph,
  PlugGlyph,
  RocketIcon,
  SearchGlyph,
  SparkIcon,
  BookGlyph,
  XGlyph,
} from "./docs-icons";

/**
 * The sidebar, in two halves.
 *
 * The top half switches *sections* — Guide, API reference, Appendix — and the
 * bottom half is the tree of whichever one you are in. That split is the whole
 * reason this reads as a site rather than a list: a reader looking up an
 * endpoint never scrolls past the guide to reach it, and the tree stays short
 * enough to hold in one glance.
 *
 * Everything here is a real link to a real page. The old rail was anchors into
 * one enormous document, which meant "where am I" had to be inferred by
 * measuring scroll position against every heading on every frame. Now the URL
 * says it, so `usePathname` is the entire mechanism.
 */

/** Icons cross the server/client boundary as names — components cannot. */
const ICONS: Record<GroupIcon, (p: { className?: string }) => React.ReactElement> = {
  rocket: RocketIcon,
  lock: LockIcon,
  spark: SparkIcon,
  braces: BracesIcon,
  layers: LayersIcon,
  plug: PlugGlyph,
  inbox: InboxGlyph,
  book: BookGlyph,
};

/** Section a path belongs to, or the first one when nothing matches. */
function activeSection(sections: DocSection[], pathname: string): DocSection {
  const owner = sections.find((section) =>
    section.groups.some((group) => group.pages.some((page) => page.href === pathname)),
  );
  return owner ?? sections[0];
}

/* ---------------------------------------------------------------------- rows */

function SectionRow({
  section,
  active,
  onNavigate,
}: {
  section: DocSection;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = ICONS[section.icon];
  const first = section.groups[0].pages[0];

  return (
    <Link
      href={first.href}
      onClick={onNavigate}
      aria-current={active ? "true" : undefined}
      // A filled row for the section you are in, which is how the app marks
      // the thing you are looking at everywhere else — the search history and
      // the outbox rail both do it.
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[15px] font-medium transition-colors ${
        active
          ? "bg-indigo-500/10 text-indigo-200"
          : "text-neutral-400 hover:bg-white/5 hover:text-white"
      }`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${active ? "text-indigo-300" : "text-neutral-500"}`} />
      {section.label}
    </Link>
  );
}

function PageRow({
  href,
  label,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // Colour alone marks the current page. A bullet or a rule beside it is
      // one more mark doing a job the colour already did, and the filled
      // treatment is spoken for by the section switcher above — two rows
      // claiming to be the current thing is worse than none.
      className={`block truncate rounded-lg px-2.5 py-1.5 text-[15px] transition-colors ${
        active ? "text-indigo-300" : "text-neutral-400 hover:bg-white/5 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}

/* -------------------------------------------------------------------- panel */

function NavPanel({
  sections,
  onNavigate,
}: {
  sections: DocSection[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
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

  const current = useMemo(() => activeSection(sections, pathname), [sections, pathname]);
  const needle = filter.trim().toLowerCase();

  /**
   * Filtering deliberately leaves the current section: a reader who types
   * "retry" wants the page, wherever it lives, and being shown only the
   * matches inside the section they happen to be in is the behaviour that
   * makes a filter feel broken.
   */
  const matches =
    needle === ""
      ? null
      : sections.flatMap((section) =>
          section.groups.flatMap((group) =>
            group.pages
              .filter(
                (page) =>
                  page.title.toLowerCase().includes(needle) ||
                  page.blurb.toLowerCase().includes(needle) ||
                  page.toc.some((entry) => entry.label.toLowerCase().includes(needle)),
              )
              .map((page) => ({ page, section: section.label })),
          ),
        );

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pt-4 pb-3">
        <label className="relative block">
          <SearchGlyph className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-600" />
          <input
            ref={input}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            type="search"
            placeholder="Search the docs"
            aria-label="Search the docs"
            className="h-9.5 w-full rounded-lg border border-line-strong bg-white/[0.03] pr-14 pl-9 text-[13px] text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-neutral-600"
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

      {matches === null ? (
        <>
          <div className="shrink-0 space-y-0.5 px-3 pb-4">
            {sections.map((section) => (
              <SectionRow
                key={section.id}
                section={section}
                active={section.id === current.id}
                onNavigate={onNavigate}
              />
            ))}
          </div>

          <nav
            aria-label={`${current.label} pages`}
            className="scrollbar-thin min-h-0 flex-1 overflow-y-auto border-t border-line px-3 pt-4 pb-10"
          >
            {/* No inline contents under the current page. The rail on the
                right is already "on this page", and duplicating it here put a
                second list of the same anchors in the reader's eyeline. */}
            {current.groups.map((group, i) => {
              const Icon = group.icon === undefined ? null : ICONS[group.icon];
              return (
                <div key={group.label ?? i} className="mt-6 first:mt-0">
                  {group.label === undefined ? null : (
                    <p className="flex items-center gap-2 px-2.5 pb-1.5 text-[15px] font-semibold text-white">
                      {Icon === null ? null : <Icon className="h-4 w-4 shrink-0 text-neutral-400" />}
                      {group.label}
                    </p>
                  )}
                  <div className="space-y-px">
                    {group.pages.map((page) => (
                      <PageRow
                        key={page.href}
                        href={page.href}
                        label={page.navLabel ?? page.title}
                        active={page.href === pathname}
                        onNavigate={onNavigate}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>
        </>
      ) : (
        <nav
          aria-label="Search results"
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto border-t border-line px-3 pt-3 pb-10"
        >
          {matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-neutral-600">
              Nothing matches “{filter}”.
            </p>
          ) : (
            matches.map(({ page, section }) => (
              <Link
                key={page.href}
                href={page.href}
                onClick={onNavigate}
                className="block rounded-lg px-2.5 py-2 transition-colors hover:bg-white/5"
              >
                <span className="block text-[15px] text-neutral-200">{page.title}</span>
                <span className="block text-[12px] text-neutral-600">{section}</span>
              </Link>
            ))
          )}
        </nav>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ exports */

export function DocsSidebar({ sections }: { sections: DocSection[] }) {
  return (
    <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[292px] shrink-0 border-r border-line bg-ink-900 lg:block">
      <NavPanel sections={sections} />
    </aside>
  );
}

/**
 * The same tree, as a full-screen sheet, below `lg`.
 *
 * A sheet rather than a drawer with the page peeking behind it, because the
 * app answers this question the same way — `InboxApp` renders its mobile nav
 * as `fixed inset-0 bg-ink-900` — and a second mobile-nav idiom in one product
 * is a seam.
 */
export function MobileNav({ sections }: { sections: DocSection[] }) {
  // Every link inside the panel closes it through `onNavigate`, which is why
  // there is no effect watching the pathname: the sheet staying up over the
  // page it just took you to reads as the tap having failed, and closing on
  // the click itself is both immediate and one render cheaper.
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
        aria-label="Open documentation navigation"
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[13px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white lg:hidden"
      >
        <MenuGlyph className="h-4 w-4" />
        <span className="hidden min-[420px]:inline">Docs</span>
      </button>

      {/*
       * Through a portal, for the reason `Modal` in `app/(inbox)/ui.tsx` is:
       * `fixed` is only the viewport when no ancestor establishes a containing
       * block, and this trigger lives inside a `backdrop-blur` header — which
       * does. Laid out in place, `inset-0` resolved against the header's own
       * box, so the sheet covered a strip and the page showed through below it.
       */}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div className="slide-in-left fixed inset-0 z-50 flex flex-col bg-ink-900 lg:hidden">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
                <span className="text-[13px] font-semibold text-white">Documentation</span>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <XGlyph className="h-5 w-5" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <NavPanel sections={sections} onNavigate={() => setOpen(false)} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
