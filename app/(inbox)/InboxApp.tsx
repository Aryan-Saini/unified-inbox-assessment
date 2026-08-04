"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ComposeDialog } from "./ComposeDialog";
import { ResultsList } from "./ResultsList";
import { SearchField } from "./SearchField";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { SourceStatus } from "./SourceStatus";
import { MOCK_CONNECTIONS, MOCK_HISTORY, SOURCE_META } from "./mock-data";
import type { Connection, Draft, SearchRecord, Source, UiResult } from "./types";
import {
  DEFAULT_DEMO,
  useMockSearch,
  type DemoOptions,
  type RunSummary,
} from "./useMockSearch";
import { MockBadge } from "./ui";
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
  const [demo, setDemo] = useState<DemoOptions>(DEFAULT_DEMO);
  const [connections, setConnections] = useState<Connection[]>(MOCK_CONNECTIONS);
  const [history, setHistory] = useState<SearchRecord[]>(MOCK_HISTORY);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<UiResult | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [text, setText] = useState("");

  const input = useRef<HTMLInputElement>(null);
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
      run(trimmed);

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
    [run],
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
      setSettingsOpen(true);
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

  const sidebar = useMemo(
    () => (
      <Sidebar
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
    ),
    [collapsed, history, activeId, startSearch, newSearch, toggleArchive, needsAttention],
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-ink-950">
      {/* Desktop rail */}
      <div className="hidden md:block">{sidebar}</div>

      {/* Mobile drawer */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="fade-in absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
          />
          <div className="pop-in absolute inset-y-0 left-0">{sidebar}</div>
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top bar: mobile nav toggle plus the active-search context. */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-5">
          <button
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/5 hover:text-white md:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1">
            {hero ? (
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-neutral-300">
                  Unified search
                </span>
                <MockBadge>UI only</MockBadge>
              </div>
            ) : (
              <div className="fade-in flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-[13px] text-neutral-500">
                  Results for
                </span>
                <span className="min-w-0 truncate text-[13px] font-medium text-white">
                  “{query}”
                </span>
              </div>
            )}
          </div>

          {!hero ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => startSearch(query, activeId ?? undefined)}
                title="Re-run this search"
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
              >
                <RerunIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Re-run</span>
              </button>
              {activeRecord ? (
                <button
                  onClick={() => toggleArchive(activeRecord.id)}
                  title={
                    activeRecord.archived
                      ? "Restore this search"
                      : "Archive this search"
                  }
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
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
              <button
                onClick={newSearch}
                className="ml-1 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white"
              >
                New search
              </button>
            </div>
          ) : null}
        </div>

        {/* The lift. One flex column: a collapsing spacer above the search
            field pulls it from the vertical centre to the top, and the heading
            collapses at the same time, so the two read as one motion. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={`shrink-0 transition-[height] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              hero ? "h-[20vh]" : "h-0"
            }`}
          />

          <div
            className={`shrink-0 px-4 transition-[padding,background-color,border-color] duration-500 sm:px-6 ${
              hero ? "" : "border-b border-line bg-ink-950/95 py-3 backdrop-blur"
            }`}
          >
            <div className="mx-auto w-full max-w-3xl">
              <div
                className={`grid transition-[grid-template-rows,opacity] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  hero ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                }`}
              >
                <div className="overflow-hidden">
                  <div className="pb-6 text-center">
                    <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-white sm:text-[34px]">
                      One search. Every inbox.
                    </h1>
                    <p className="mx-auto mt-2.5 max-w-md text-[13.5px] leading-relaxed text-neutral-500">
                      Gmail, Slack and the web answer at their own speed. Fast
                      sources land first — nothing waits on the slowest.
                    </p>
                  </div>
                </div>
              </div>

              <SearchField
                ref={input}
                value={text}
                onChange={setText}
                onSubmit={() => startSearch(text, hero ? undefined : activeId ?? undefined)}
                onClear={newSearch}
                hero={hero}
                working={working}
              />
            </div>
          </div>

          {/* Results */}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {hero ? null : (
              <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5 sm:px-6">
                <SourceStatus
                  runs={runs}
                  resultCount={results.length}
                  working={working}
                  elapsed={elapsed}
                  onReconnect={reconnectSource}
                  onRetry={retrySource}
                />
                <ResultsList
                  query={query}
                  results={results}
                  working={working}
                  onReply={setDraftFor}
                />
                <p className="pt-2 pb-6 text-center text-[11.5px] text-neutral-600">
                  Mock results — generated locally from a fixed fixture set. No
                  provider was contacted.
                </p>
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

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connections={connections}
        onReconnect={reconnect}
        demo={demo}
        onDemoChange={setDemo}
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
