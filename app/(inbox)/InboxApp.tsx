"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ComposeDialog } from "./ComposeDialog";
import { ResultsList } from "./ResultsList";
import { SearchField } from "./SearchField";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { OutboxDialog, type OutboxSend } from "./OutboxDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { SourceStatus } from "./SourceStatus";
import { TypedHeading } from "./TypedHeading";
import { SOURCES, SOURCE_META } from "./mock-data";
import { SourceBar } from "./SourceBar";
import type { ComposePrefill, Draft, SearchRecord, Source, UiResult } from "./types";
import { formatAge } from "./format";
import { useClockMinute } from "./useClock";
import { useConnections } from "./useConnections";
import { DEFAULT_DEMO, useSearch, type DemoOptions } from "./useSearch";
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

/** What the compose dialog is opened on: the result being answered, plus an
 *  optional payload to seed it with instead of the reply template. */
interface ComposeTarget {
  result: UiResult;
  prefill?: ComposePrefill;
}

export function InboxApp() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [demo, setDemo] = useState<DemoOptions>(DEFAULT_DEMO);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [text, setText] = useState("");
  /** Which connectors a search fans out to, driven by the source bar. */
  const [enabledSources, setEnabledSources] = useState<Source[]>(SOURCES);

  /**
   * Real connections, real OAuth. `addAccount` and `reconnect` navigate to the
   * provider and come back through the Convex callback, so neither resolves — the
   * "connected" feedback arrives as a URL param, handled below.
   */
  const {
    connections,
    addAccount,
    reconnect,
    toggleAccount,
    disconnect: disconnectAccount,
  } = useConnections();

  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);

  /**
   * The live fan-out. Every run is a real search row on the server, so the
   * sidebar below reads the same history a `curl` session would.
   */
  const {
    phase,
    query,
    runs,
    results,
    working,
    elapsed,
    run,
    reset,
    searchId,
    open,
    rerun,
    rerunFrom,
  } = useSearch(demo);

  /**
   * History, straight from the server. The in-flight run is already in here —
   * `searches.run` inserts the row before the workers are scheduled — so the
   * sidebar reflects work in progress without a local optimistic copy to
   * reconcile afterwards.
   */
  const historyRows = useQuery(api.searches.history);
  const setArchived = useMutation(api.searches.setArchived);
  const now = useClockMinute();

  const history = useMemo<SearchRecord[]>(
    () =>
      (historyRows ?? []).map((row) => ({
        id: row.id,
        query: row.query,
        age: formatAge(row.createdAt, now),
        resultCount: row.resultCount,
        sources: row.sources,
        archived: row.archived,
        isSeed: row.isSeed,
        degraded: row.degraded,
        pending: row.status === "running",
      })),
    [historyRows, now],
  );

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
    (q: string) => {
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

  const newSearch = useCallback(() => {
    reset();
    setText("");
    setMobileNavOpen(false);
    requestAnimationFrame(() => input.current?.focus());
  }, [reset]);

  // --- History -----------------------------------------------------------

  /**
   * Archiving is a soft hide on the server — the search and its results are
   * kept, because a "14 results at 09:12" claim you can no longer inspect is
   * not history. Undo is the same mutation with the flag flipped back.
   */
  const toggleArchive = useCallback(
    (id: string) => {
      const record = history.find((h) => h.id === id);
      if (record === undefined) return;
      const searchRef = id as Id<"searches">;

      void setArchived({ searchId: searchRef, archived: !record.archived });
      toast(record.archived ? "Search restored" : "Search archived", {
        label: "Undo",
        run: () => {
          void setArchived({ searchId: searchRef, archived: record.archived });
        },
      });
    },
    [history, setArchived, toast],
  );

  /**
   * The sidebar's re-run action: a NEW search with `rerunOf` pointing at the
   * old row, never an overwrite — the "14 results at 09:12" claim stays
   * inspectable after today's answer arrives.
   */
  const rerunFromHistory = useCallback(
    (record: SearchRecord) => {
      setText(record.query);
      setMobileNavOpen(false);
      rerunFrom(record.id as Id<"searches">, record.query, record.sources);
    },
    [rerunFrom],
  );

  const activeRecord = history.find((h) => h.id === searchId) ?? null;

  // --- Connections -------------------------------------------------------

  const disconnect = useCallback(
    (id: string) => {
      const label = connections.find((c) => c.id === id)?.label ?? "account";
      disconnectAccount(id);
      toast(`Disconnected ${label} — history kept`);
    },
    [connections, disconnectAccount, toast],
  );

  /**
   * Report what the OAuth callback did, then strip the params.
   *
   * Without this the interesting outcomes are invisible: a reconnect rejected for
   * being a different account, or a consent screen the user cancelled, would both
   * look like a page that simply reloaded. `replaceState` clears the params so a
   * refresh does not replay the toast.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("oauth_error");
    if (connected === null && error === null) return;

    if (connected !== null) {
      // The callback always names the account; the provider is the fallback.
      toast(`Connected ${params.get("account") ?? connected}`);
    } else if (error === "identity_mismatch") {
      const expected = params.get("oauth_expected") ?? "the original account";
      const actual = params.get("oauth_actual") ?? "a different account";
      toast(
        `This connection is ${expected}, but you signed in as ${actual}. Add it as another account instead.`,
      );
    } else if (error === "access_denied") {
      toast("Connection cancelled — nothing was changed");
    } else {
      toast(`Could not connect: ${params.get("oauth_error_detail") ?? error}`);
    }

    for (const key of [
      "connected",
      "account",
      "oauth_error",
      "oauth_error_detail",
      "oauth_expected",
      "oauth_actual",
    ]) {
      params.delete(key);
    }
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query === "" ? "" : `?${query}`}`,
    );
  }, [toast]);

  /**
   * The source strip's reconnect button.
   *
   * A *simulated* revocation is undone by turning the fault off; a real one is
   * only fixed by re-granting, which lives in the connections dialog. The two
   * are told apart by the marker the injector stamps on every simulated
   * failure — a demo affordance must never be able to masquerade as a real one.
   */
  const reconnectSource = useCallback(
    (source: Source) => {
      const failing = runs.find((r) => r.source === source);
      if (failing?.errorMessage?.includes("[simulated]") === true) {
        const next = { ...demo, slackNeedsReconnect: false };
        setDemo(next);
        toast("Simulated revocation cleared — re-run to pick the grant back up", {
          label: "Re-run",
          run: () => rerun(next),
        });
        return;
      }
      // One dead grant is unambiguous, so go straight to the provider's consent
      // screen. Anything less clear-cut goes through the connections dialog,
      // where each account's status is visible.
      const broken = connections.filter(
        (c) => c.provider === source && c.status !== "active",
      );
      if (broken.length === 1) {
        reconnect(broken[0].id);
        return;
      }
      setConnectionsOpen(true);
    },
    [runs, demo, toast, rerun, connections, reconnect],
  );

  /**
   * Retry a failed source by re-running the search. A rerun is a *new* search
   * row (with `rerunOf` set) rather than an overwrite, so the failure that
   * prompted it stays in history where it can still be read.
   */
  const retrySource = useCallback(
    (source: Source) => {
      const next =
        source === "gmail" ? { ...demo, gmailTransientFailure: false } : demo;
      if (next !== demo) setDemo(next);
      toast(`Retrying ${SOURCE_META[source].name}…`);
      rerun(next);
    },
    [demo, toast, rerun],
  );


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

  // --- Outbox --------------------------------------------------------------

  /**
   * The only exit from an `unknown` send: the same payload under a *new*
   * idempotency key, minted by the freshly-mounted compose dialog. The old key
   * stays claimed by the indeterminate delivery, exactly as it should.
   */
  const composeAgain = useCallback((send: OutboxSend) => {
    setOutboxOpen(false);
    setCompose({
      result: {
        source: send.channel,
        id: send.id,
        title: send.subject ?? `Message to ${send.to}`,
        snippet: send.body,
        url: "",
        age: "",
        replyTo: send.to,
        connectionId: send.connectionId,
        threadId: send.threadId,
      },
      prefill: { subject: send.subject, body: send.body },
    });
  }, []);

  const renderSidebar = (sheet: boolean) => (
    <Sidebar
      sheet={sheet}
      onClose={() => setMobileNavOpen(false)}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((v) => !v)}
      history={history}
      activeId={searchId}
      // Selecting a past search *reads* it rather than re-running it: the rows
      // are still on the server, and silently re-querying five providers
      // because someone clicked history would spend real quota.
      onSelect={(record) => {
        setText(record.query);
        setMobileNavOpen(false);
        open(record.id as Id<"searches">, record.query);
      }}
      onRerun={rerunFromHistory}
      onNewSearch={newSearch}
      onArchiveToggle={toggleArchive}
      onOpenOutbox={() => {
        setOutboxOpen(true);
        setMobileNavOpen(false);
      }}
      onOpenSettings={() => {
        setSettingsOpen(true);
        setMobileNavOpen(false);
      }}
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
                onSubmit={() => startSearch(text)}
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
                          onClick={() => rerun()}
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
                <SourceStatus runs={runs} onReconnect={reconnectSource} />
                <ResultsList
                  query={query}
                  results={results}
                  runs={runs}
                  working={working}
                  elapsed={elapsed}
                  onReply={(result) => setCompose({ result })}
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
        onAddAccount={addAccount}
        onDisconnect={disconnect}
      />

      <OutboxDialog
        open={outboxOpen}
        onClose={() => setOutboxOpen(false)}
        connections={connections}
        onReconnect={reconnect}
        onComposeAgain={composeAgain}
      />

      {/* Keyed on the result: opening a reply to a different row remounts the
          dialog, which resets the draft — and mints a fresh idempotency key —
          without an effect to do it. */}
      {compose ? (
        <ComposeDialog
          key={compose.result.id}
          result={compose.result}
          prefill={compose.prefill}
          onClose={() => setCompose(null)}
          onSent={onSent}
        />
      ) : null}
    </div>
  );
}
