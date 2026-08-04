"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ComposeDialog } from "./ComposeDialog";
import { ResultsList } from "./ResultsList";
import { SearchField } from "./SearchField";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { SourceStatus } from "./SourceStatus";
import { TypedHeading } from "./TypedHeading";
import { MOCK_CONNECTIONS, MOCK_HISTORY, SOURCES, SOURCE_META } from "./mock-data";
import { SourceBar } from "./SourceBar";
import type { Connection, Draft, SearchRecord, Source, UiResult } from "./types";
import {
  DEFAULT_DEMO,
  useMockSearch,
  type DemoOptions,
  type RunSummary,
} from "./useMockSearch";
import {
  ArchiveIcon,
  CheckIcon,
  MenuIcon,
  RerunIcon,
  UnarchiveIcon,
} from "./icons";

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export function InboxApp() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [demo, setDemo] = useState<DemoOptions>(DEFAULT_DEMO);
  const [connections, setConnections] = useState<Connection[]>(MOCK_CONNECTIONS);
  const [history, setHistory] = useState<SearchRecord[]>(MOCK_HISTORY);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<UiResult | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [text, setText] = useState("");
  /** Which connectors a search fans out to, driven by the source bar. */
  const [enabledSources, setEnabledSources] = useState<Source[]>(SOURCES);

  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);
  /** Which history row the in-flight run belongs to, readable from a timer. */
  const activeIdRef = useRef<string | null>(null);

  /**
   * Fold the settled outcome back into the history row. This is a callback from
   * the last adapter finishing, not an effect watching state — the sidebar row
   * is updated once, by the event that actually changed something.
   */
  const handleSettled = useCallback((summary: RunSummary) => {
    const id = activeIdRef.current;
    if (id === null) return;
    setHistory((prev) =>
      prev.map((h) =>
        h.id === id
          ? {
              ...h,
              resultCount: summary.resultCount,
              sources: summary.returned,
              degraded: summary.degraded,
              pending: false,
            }
          : h,
      ),
    );
  }, []);

  const { phase, query, runs, results, working, elapsed, run, reset } =
    useMockSearch(demo, handleSettled);

  const hero = phase === "idle";

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = (nextId.current += 1);
    setToasts((prev) => [...prev, { id, text, action }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      4500,
    );
  }, []);

  // --- Search ------------------------------------------------------------

  const startSearch = useCallback(
    (q: string, existingId?: string) => {
      const trimmed = q.trim();
      if (trimmed.length === 0) return;

      setText(trimmed);
      setMobileNavOpen(false);

      // A connector with every account switched off has nothing to query, so it
      // is dropped from the fan-out as well — otherwise it would report an
      // empty success and look like "no matches".
      const dispatchable = enabledSources.filter(
        (s) => s === "web" || connections.some((c) => c.provider === s && c.enabled),
      );
      run(trimmed, dispatchable.length > 0 ? dispatchable : enabledSources);

      if (existingId) {
        setActiveId(existingId);
        activeIdRef.current = existingId;
        setHistory((prev) =>
          prev.map((h) => (h.id === existingId ? { ...h, pending: true } : h)),
        );
        return;
      }

      // A new run gets its own history row immediately, so the sidebar reflects
      // in-flight work rather than only settled work.
      const id = `s_live_${nextId.current += 1}`;
      setActiveId(id);
      activeIdRef.current = id;
      setHistory((prev) => [
        {
          id,
          query: trimmed,
          age: "now",
          resultCount: 0,
          sources: [],
          archived: false,
          isSeed: false,
          pending: true,
        },
        ...prev,
      ]);
    },
    [run, enabledSources, connections],
  );

  // --- Connectors --------------------------------------------------------

  /**
   * Turning the last source off would make the search button a no-op with no
   * explanation, so the final enabled source is held on and the attempt is
   * explained instead.
   */
  const toggleSource = useCallback((source: Source) => {
    setEnabledSources((prev) => {
      if (!prev.includes(source)) return [...prev, source];
      if (prev.length === 1) return prev;
      return prev.filter((s) => s !== source);
    });
  }, []);

  const addAccount = useCallback(
    (provider: "gmail" | "slack") => {
      const seq = (nextId.current += 1);
      const label =
        provider === "gmail"
          ? `team-${seq}@northwind.test`
          : `Northwind Workspace ${seq}`;

      setConnections((prev) => [
        ...prev,
        {
          id: `conn_${provider}_${seq}`,
          provider,
          label,
          detail:
            provider === "gmail" ? "Added from the source bar" : "ada@northwind.test",
          status: "active",
          scopes:
            provider === "gmail"
              ? ["gmail.readonly", "gmail.send"]
              : ["search:read", "chat:write"],
          lastUsed: "just now",
          enabled: true,
        },
      ]);

      // A newly connected account is useless if its source is still excluded.
      setEnabledSources((prev) =>
        prev.includes(provider) ? prev : [...prev, provider],
      );
      toast(`Connected ${label}`);
    },
    [toast],
  );

  const newSearch = useCallback(() => {
    reset();
    setText("");
    setActiveId(null);
    activeIdRef.current = null;
    setMobileNavOpen(false);
    requestAnimationFrame(() => input.current?.focus());
  }, [reset]);

  // --- History -----------------------------------------------------------

  const toggleArchive = useCallback(
    (id: string) => {
      let restored = false;
      setHistory((prev) =>
        prev.map((h) => {
          if (h.id !== id) return h;
          restored = h.archived;
          return { ...h, archived: !h.archived };
        }),
      );
      toast(restored ? "Search restored" : "Search archived", {
        label: "Undo",
        run: () =>
          setHistory((prev) =>
            prev.map((h) => (h.id === id ? { ...h, archived: restored } : h)),
          ),
      });
    },
    [toast],
  );

  const activeRecord = history.find((h) => h.id === activeId) ?? null;

  // --- Connections -------------------------------------------------------

  const toggleAccount = useCallback((id: string) => {
    setConnections((prev) =>
      prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
    );
  }, []);

  const reconnect = useCallback(
    (id: string) => {
      setConnections((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, status: "active", statusReason: undefined, lastUsed: "just now" }
            : c,
        ),
      );
      toast("Connection restored — identity preserved");
    },
    [toast],
  );

  /** The source strip's reconnect button routes to the matching connection. */
  const reconnectSource = useCallback(
    (source: Source) => {
      if (source === "slack") {
        setDemo((d) => ({ ...d, slackNeedsReconnect: false }));
        toast("Slack grant restored — re-run the search to pick it up", {
          label: "Re-run",
          run: () => startSearch(query, activeId ?? undefined),
        });
        return;
      }
      setConnectionsOpen(true);
    },
    [toast, query, activeId, startSearch],
  );

  const retrySource = useCallback(
    (source: Source) => {
      if (source === "gmail") setDemo((d) => ({ ...d, gmailTransientFailure: false }));
      toast(`Retrying ${SOURCE_META[source].name}…`);
      startSearch(query, activeId ?? undefined);
    },
    [toast, query, activeId, startSearch],
  );

  const needsAttention = connections.filter((c) => c.status !== "active").length;

  // --- Shortcuts ---------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
      if (meta && e.key === "\\") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
      // The mobile drawer is an overlay, so Escape should dismiss it like the
      // dialogs do.
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSent = useCallback(
    (draft: Draft) => toast(`Recorded one delivery to ${draft.to}`),
    [toast],
  );

  const renderSidebar = (sheet: boolean) => (
    <Sidebar
      sheet={sheet}
      onClose={() => setMobileNavOpen(false)}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((v) => !v)}
      history={history}
      activeId={activeId}
      onSelect={(record) => startSearch(record.query, record.id)}
      onNewSearch={newSearch}
      onArchiveToggle={toggleArchive}
      onOpenSettings={() => {
        setSettingsOpen(true);
        setMobileNavOpen(false);
      }}
      needsAttention={needsAttention}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-ink-950">
      {/* Desktop rail */}
      <div className="hidden md:block">{renderSidebar(false)}</div>

      {/* Mobile: a full-screen sheet, not a drawer with the content peeking
          behind it. Picking a search closes it and lands on the results. */}
      {mobileNavOpen ? (
        <div className="slide-in-left fixed inset-0 z-40 bg-ink-900 md:hidden">
          {renderSidebar(true)}
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile only: the nav toggle has nowhere else to live. On desktop
            there is no top bar — the search context and its controls sit in the
            composer itself. */}
        <div className="flex h-14 shrink-0 items-center px-3 sm:px-5 md:hidden">
          <button
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
        </div>

        {/* The lift. One flex column. In the hero state this spacer and the
            (empty) results pane below both grow, so the free space splits
            evenly and the field sits dead centre. On search the spacer's
            flex-grow animates to 0 and the field rises to the top. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={`shrink-0 basis-0 transition-[flex-grow] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              hero ? "grow" : "grow-0"
            }`}
          />

          {/* No rule under the docked composer: the field's own border already
              separates it from the results, and a full-width line across the
              pane read as a second, competing edge. */}
          <div
            className={`shrink-0 px-4 transition-[padding] duration-500 sm:px-6 ${
              hero ? "" : "pt-2 pb-1"
            }`}
          >
            <div className="mx-auto w-full max-w-3xl">
              {/* The heading collapses on the same curve as the spacer above,
                  so the lift to the docked state reads as one motion. */}
              <div
                className={`grid transition-[grid-template-rows,opacity] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  hero ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                }`}
              >
                <div className="overflow-hidden">
                  <div className="pb-8">{hero ? <TypedHeading /> : null}</div>
                </div>
              </div>

              <SearchField
                ref={input}
                value={text}
                onChange={setText}
                onSubmit={() => startSearch(text, hero ? undefined : activeId ?? undefined)}
                onClear={newSearch}
                working={working}
                footer={
                  <div className="flex items-center gap-0.5">
                    <SourceBar
                      enabled={enabledSources}
                      connections={connections}
                      onToggleSource={toggleSource}
                      onToggleAccount={toggleAccount}
                      onAddAccount={addAccount}
                      onReconnect={reconnect}
                    />

                    {/* Run controls only exist once there is a run to act on. */}
                    {hero ? null : (
                      <>
                        <span className="mx-1 h-4 w-px bg-line" />
                        <button
                          type="button"
                          onClick={() => startSearch(query, activeId ?? undefined)}
                          title="Re-run this search"
                          className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-white"
                        >
                          <RerunIcon className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Re-run</span>
                        </button>
                        {activeRecord ? (
                          <button
                            type="button"
                            onClick={() => toggleArchive(activeRecord.id)}
                            title={
                              activeRecord.archived
                                ? "Restore this search"
                                : "Archive this search"
                            }
                            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-white"
                          >
                            {activeRecord.archived ? (
                              <UnarchiveIcon className="h-3.5 w-3.5" />
                            ) : (
                              <ArchiveIcon className="h-3.5 w-3.5" />
                            )}
                            <span className="hidden sm:inline">
                              {activeRecord.archived ? "Restore" : "Archive"}
                            </span>
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                }
              />
            </div>
          </div>

          {/* Results */}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {hero ? null : (
              <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pt-2 pb-6 sm:px-6">
                <SourceStatus runs={runs} />
                <ResultsList
                  query={query}
                  results={results}
                  runs={runs}
                  working={working}
                  elapsed={elapsed}
                  onReply={setDraftFor}
                  onReconnect={reconnectSource}
                  onRetry={retrySource}
                />
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pop-in pointer-events-auto flex items-center gap-3 rounded-xl border border-line-strong bg-ink-850 px-3.5 py-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
          >
            <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
            <span className="text-[13px] whitespace-nowrap text-neutral-200">
              {t.text}
            </span>
            {t.action ? (
              <button
                onClick={() => {
                  t.action?.run();
                  setToasts((prev) => prev.filter((x) => x.id !== t.id));
                }}
                className="rounded-md px-2 py-1 text-[12px] font-semibold text-indigo-300 transition-colors hover:bg-indigo-500/10 hover:text-indigo-200"
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <ConnectionsDialog
        open={connectionsOpen}
        onClose={() => setConnectionsOpen(false)}
        connections={connections}
        enabledSources={enabledSources}
        onToggleSource={toggleSource}
        onToggleAccount={toggleAccount}
        onAddAccount={addAccount}
        onReconnect={reconnect}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connections={connections}
        onReconnect={reconnect}
      />

      {/* Keyed on the result: opening a reply to a different row remounts the
          dialog, which resets the draft without an effect to do it. */}
      {draftFor ? (
        <ComposeDialog
          key={draftFor.id}
          result={draftFor}
          onClose={() => setDraftFor(null)}
          onSent={onSent}
        />
      ) : null}
    </div>
  );
}
