"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BRAND_LOGO, WebOffLogo } from "./brand-icons";
import { ConnectorSwitchboard, Switch } from "./ConnectorSwitchboard";
import { SOURCE_META } from "./mock-data";
import type { Connection, Source } from "./types";
import { AlertIcon, ChevronDownIcon } from "./icons";

/** The account-backed connectors, i.e. everything the dropdown's rail covers. */
const CONNECTOR_SOURCES = ["gmail", "slack"] as const;

/** Every adapter, for the header's all-on/all-off switch. Web included: it is a
 *  connector too, and a master switch that left one source running would be a
 *  lie. */
const ALL_SOURCES = ["gmail", "slack", "web"] as const;

/**
 * The panel is a fixed size by design (see `ConnectorSwitchboard`), so the flip
 * decision can be made from a constant rather than by measuring after paint —
 * which would place it wrong for one frame. `21rem` of switchboard plus its
 * header row.
 */
const PANEL_HEIGHT = 336 + 41;
/** Trigger-to-panel gap, and the margin kept against the window edge. */
const GAP = 8;
const EDGE = 12;

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
  onSetAllSources,
  onToggleAccount,
  onAddAccount,
  onReconnect,
}: {
  enabled: Source[];
  connections: Connection[];
  onToggleSource: (source: Source) => void;
  /** Set the whole fan-out at once, `[]` included — the one path that may leave
   *  every source off. */
  onSetAllSources: (sources: Source[]) => void;
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
  const [anchor, setAnchor] = useState<{
    left: number;
    /** Exactly one of these is set — see `measure`. */
    top?: number;
    bottom?: number;
  } | null>(null);

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
      // Keep the panel on screen when the trigger sits near the right edge.
      const left = Math.max(
        12,
        Math.min(box.left, window.innerWidth - width - 12),
      );

      // Above the trigger by default — the bar sits at the bottom edge of the
      // composer, so that is where the room usually is. But the composer docks
      // to the top of the pane once a search runs, and there the panel would
      // run off the top of the window; whichever side has more room wins.
      const above = box.top - GAP - EDGE;
      const below = window.innerHeight - box.bottom - GAP - EDGE;
      setAnchor(
        above >= PANEL_HEIGHT || above >= below
          ? { left, bottom: window.innerHeight - box.top + GAP }
          : { left, top: box.bottom + GAP },
      );
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
  const anyOn = enabled.length > 0;
  // Any grant that is not active, switched on or not. A dead account that
  // happens to be toggled off is still a dead account — it cannot be used until
  // it is reconnected, and hiding that until someone switches it on is how you
  // discover a revoked grant in the middle of a search instead of before one.
  const needsAttention = connections.filter((c) => c.status !== "active").length;

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

        {/* A hazard mark and nothing else. What is wrong, with which account,
            and the button that fixes it are all one click away inside — a count
            on the trigger only raises the question the panel answers. */}
        {needsAttention > 0 ? (
          <span
            role="img"
            aria-label={`${needsAttention} ${
              needsAttention === 1 ? "account needs" : "accounts need"
            } attention`}
            title={`${needsAttention} ${
              needsAttention === 1 ? "account needs" : "accounts need"
            } attention`}
          >
            <AlertIcon className="h-3.5 w-3.5 text-amber-300" />
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
            ? "Web search is included, click to exclude it"
            : "Web search is excluded, click to include it"
        }
        aria-label={
          webOn ? "Exclude web search" : "Include web search"
        }
        className="flex items-center justify-center rounded-xl p-1.5 transition-colors hover:bg-white/[0.05]"
      >
        {/* Struck through when off. Dimming alone left it ambiguous next to a
            connector that is simply not connected. */}
        {webOn ? (
          <WebLogo className="h-4 w-4" />
        ) : (
          <WebOffLogo className="h-4 w-4 text-neutral-600" />
        )}
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
              {/* Flips above or below the trigger — see `measure`. */}
              <div
                role="dialog"
                aria-label="Connectors"
                style={{
                  left: anchor.left,
                  top: anchor.top,
                  bottom: anchor.bottom,
                }}
                className="pop-in fixed z-50 w-[min(34rem,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-line-strong bg-ink-900 shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
              >
                <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2.5">
                  <p className="text-[12px] font-semibold tracking-wide text-neutral-400 uppercase">
                    Connectors
                  </p>
                  {/* Everything, including web — the rail below covers only the
                      account-backed connectors, but "off" should mean off.
                      Checked while *anything* is on, so switching it all off is
                      always one click rather than one per adapter. */}
                  <label className="flex cursor-pointer items-center gap-2">
                    <span className="text-[12px] text-neutral-500">
                      {anyOn ? "All on" : "All off"}
                    </span>
                    <Switch
                      checked={anyOn}
                      onChange={() => onSetAllSources(anyOn ? [] : [...ALL_SOURCES])}
                      label={
                        anyOn
                          ? "Turn every connector off"
                          : "Turn every connector on"
                      }
                    />
                  </label>
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
