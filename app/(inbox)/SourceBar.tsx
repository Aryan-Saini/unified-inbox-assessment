"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BRAND_LOGO } from "./brand-icons";
import { ConnectorSwitchboard } from "./ConnectorSwitchboard";
import { SOURCE_META } from "./mock-data";
import type { Connection, Source } from "./types";
import { AlertIcon, ChevronDownIcon } from "./icons";

/** The account-backed connectors, i.e. everything the dropdown covers. */
const CONNECTOR_SOURCES = ["gmail", "slack"] as const;

/**
 * The control row inside the search field. One trigger, not three toggles: the
 * connector detail lives behind it, so the composer stays a single line of
 * chrome no matter how many accounts are connected.
 *
 * Every button here is explicitly `type="button"` — this renders inside the
 * search <form>, so an unmarked button would submit it and fire a search.
 */
export function SourceBar({
  enabled,
  connections,
  onToggleSource,
  onToggleAccount,
  onAddAccount,
  onReconnect,
}: {
  enabled: Source[];
  connections: Connection[];
  onToggleSource: (source: Source) => void;
  onToggleAccount: (id: string) => void;
  onAddAccount: (provider: "gmail" | "slack") => void;
  onReconnect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /**
   * The panel is portalled to <body>, so it needs the trigger's viewport
   * position. It cannot be a normal absolute child: the composer clips to its
   * rounded corners with `overflow-hidden`, and the bar's collapse animation
   * adds a second clip, so anything extending past the box is invisible.
   */
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null,
  );

  // Escape closes the panel wherever focus happens to be.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Re-measure while open: the hero field moves when the window resizes, and
  // the results pane can scroll underneath it.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = trigger.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const width = Math.min(544, window.innerWidth - 40);
      setAnchor({
        // Keep the panel on screen when the trigger sits near the right edge.
        left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)),
        bottom: window.innerHeight - box.top + 8,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // Web is not in the dropdown — it has no account, so it is its own toggle in
  // the bar. The dropdown speaks only for the account-backed connectors.
  const on = CONNECTOR_SOURCES.filter((s) => enabled.includes(s));
  const webOn = enabled.includes("web");
  const needsAttention = connections.filter(
    (c) => c.status !== "active" && c.enabled,
  ).length;

  // Name the connector when there is only one; count them otherwise. "All
  // connectors" is worth saying explicitly — it is the default state.
  const label =
    on.length === 0
      ? "No connectors"
      : on.length === CONNECTOR_SOURCES.length
        ? "All connectors"
        : SOURCE_META[on[0]].name;

  const WebLogo = BRAND_LOGO.web;

  return (
    <div className="relative flex items-center gap-0.5">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
          open
            ? "bg-white/[0.08] text-white"
            : "text-neutral-300 hover:bg-white/[0.05] hover:text-white"
        }`}
      >
        {/* The enabled marks stack like avatars, so the trigger says which
            connectors are live without spelling them out. Each sits on its own
            tile with a border: bare overlapping logos bleed into each other,
            whereas a tile gives every mark a clean edge to overlap against.
            `isolate` keeps the z-order local, and earlier marks stack on top. */}
        <span className="isolate flex shrink-0 items-center">
          {on.length === 0 ? (
            <span className="text-neutral-500">None</span>
          ) : (
            on.map((source, i) => {
              const Logo = BRAND_LOGO[source];
              return (
                <span
                  key={source}
                  style={{ zIndex: on.length - i }}
                  className={`relative flex h-5 w-5 items-center justify-center rounded-md border border-line-strong bg-ink-850 ${
                    i > 0 ? "-ml-2" : ""
                  }`}
                >
                  <Logo className="h-3 w-3" />
                </span>
              );
            })
          )}
        </span>

        <span>{label}</span>

        {needsAttention > 0 ? (
          <span className="flex items-center gap-1 rounded-md bg-amber-400/15 px-1.5 py-px text-[10.5px] font-semibold text-amber-300">
            <AlertIcon className="h-2.5 w-2.5" />
            {needsAttention}
          </span>
        ) : null}

        <ChevronDownIcon
          className={`h-3 w-3 text-neutral-500 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      <span className="mx-1 h-4 w-px bg-line" />

      {/* Web search: no account to manage, so it toggles straight from the bar
          rather than costing a trip through the dropdown. */}
      <button
        type="button"
        onClick={() => onToggleSource("web")}
        aria-pressed={webOn}
        title={
          webOn
            ? "Web search is included — click to exclude it"
            : "Web search is excluded — click to include it"
        }
        aria-label={
          webOn ? "Exclude web search" : "Include web search"
        }
        className="flex items-center justify-center rounded-xl p-1.5 transition-colors hover:bg-white/[0.05]"
      >
        <WebLogo
          className={`h-4 w-4 transition-all duration-200 ${
            webOn ? "" : "opacity-40 grayscale"
          }`}
        />
      </button>

      {open && anchor
        ? createPortal(
            <>
              {/* A click anywhere else dismisses. Rendered behind the panel so
                  the panel's own clicks land first. */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className="fixed inset-0 z-50 cursor-default"
              />
              {/* Opens upward: the bar sits at the bottom edge of the composer. */}
              <div
                role="dialog"
                aria-label="Connectors"
                style={{ left: anchor.left, bottom: anchor.bottom }}
                className="pop-in fixed z-50 w-[min(34rem,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-line-strong bg-ink-900 shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
              >
                <div className="border-b border-line px-3.5 py-2.5">
                  <p className="text-[12px] font-semibold tracking-wide text-neutral-400 uppercase">
                    Connectors
                  </p>
                </div>
                <ConnectorSwitchboard
                  compact
                  connections={connections}
                  enabledSources={enabled}
                  onToggleSource={onToggleSource}
                  onToggleAccount={onToggleAccount}
                  onAddAccount={onAddAccount}
                  onReconnect={onReconnect}
                />
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
