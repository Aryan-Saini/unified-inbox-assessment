"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { ComposeDialog } from "./ComposeDialog";
import { ResultsList } from "./ResultsList";
import { SearchField } from "./SearchField";
import { ConnectionsDialog } from "./ConnectionsDialog";
import { OutboxPage, type OutboxSend } from "./OutboxPage";
import { SendFailureDialog } from "./SendFailureDialog";
import { SendWatcher } from "./SendWatcher";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { TypedHeading } from "./TypedHeading";
import { SOURCE_META } from "./mock-data";
import { SourceBar } from "./SourceBar";
import type { ComposePrefill, Draft, SearchRecord, Source, UiResult } from "./types";
import { accountTitle, formatAge } from "./format";
import { useClockMinute } from "./useClock";
import { useConnections } from "./useConnections";
import { useEnabledSources } from "./useEnabledSources";
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
  /** `pending` swaps the tick for a spinner — the toast is the progress. */
  tone?: "ok" | "pending";
}

/** What the compose dialog is opened on: the result being answered, plus an
 *  optional payload to seed it with instead of the reply template. */
interface ComposeTarget {
  result: UiResult;
  prefill?: ComposePrefill;
}

/**
 * Which pane the shell is showing. Both are real routes — `/dashboard` and
 * `/outbox` — rendering one shell so the sidebar, the dialogs and the toast
 * deck are not built twice and cannot drift.
 */
export type InboxView = "search" | "outbox";

export function InboxApp({ view = "search" }: { view?: InboxView }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [demo, setDemo] = useState<DemoOptions>(DEFAULT_DEMO);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  /**
   * The delivery currently being watched, and the toast reporting it.
   *
   * A claimed send finishes on the server, so the shell — not the dialog that
   * started it — is what follows it: the dialog is gone by then, and closing a
   * modal must not stop the app caring how the message did.
   */
  const [watching, setWatching] = useState<{
    sendId: Id<"sends">;
    toastId: number;
  } | null>(null);
  /** Who the in-flight send is going to, for the toast that reports it. Held
   *  outside state because it is only ever read, never rendered. */
  const watchLabel = useRef("");
  /** A settled send that did not go out. The one case that still takes a modal. */
  const [failedSendId, setFailedSendId] = useState<Id<"sends"> | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [text, setText] = useState("");
  /**
   * Which connectors a search fans out to, driven by the source bar and kept
   * across reloads — turning web off is a standing preference, not a per-visit
   * one.
   */
  const [enabledSources, setEnabledSources] = useEnabledSources();

  /**
   * Real connections, real OAuth. `addAccount` and `reconnect` navigate to the
   * provider and come back through the Convex callback, so neither resolves — the
   * "connected" feedback arrives as a URL param, handled below.
   */
  const {
    connections,
    loading: connectionsLoading,
    addAccount,
    reconnect,
    toggleAccount,
    disconnect: disconnectAccount,
    remove: removeAccount,
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
  const historyRows = useAuthedQuery(api.searches.history, {});
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

  /**
   * Whether the source bar is showing the standing preference or the search on
   * screen.
   *
   * The preference is what the *next* search will use, and on the hero it is the
   * only thing there is to show. Docked on a search, though, the bar describes
   * *that* search — it fanned out to the sources it fanned out to, and repainting
   * it with today's preference claims web was off for a search that queried web.
   *
   * A toggle is intent about the next search, so it hands the bar back to the
   * preference — but only for the search it was made on. Recording *which* search
   * rather than a bare flag is what expires the override when the watched search
   * changes, without an effect that resets state on every navigation.
   */
  const [overrodeOn, setOverrodeOn] = useState<Id<"searches"> | null>(null);
  const barFollowsPreference = searchId !== null && overrodeOn === searchId;

  const searchSources = useMemo(
    () => [...new Set(runs.map((run) => run.source))],
    [runs],
  );
  const barSources =
    hero || barFollowsPreference || searchSources.length === 0
      ? enabledSources
      : searchSources;

  /** Returns the id, so a toast that reports something still in progress can be
   *  taken back down when it settles. */
  const toast = useCallback(
    (
      text: string,
      action?: Toast["action"],
      opts?: { tone?: Toast["tone"]; sticky?: boolean },
    ) => {
      const id = (nextId.current += 1);
      setToasts((prev) => [...prev, { id, text, action, tone: opts?.tone }]);
      // A sticky toast is one whose subject has not finished happening yet;
      // expiring it on a timer would leave the screen claiming nothing is going
      // on while a send is still in flight.
      if (opts?.sticky !== true) {
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
      }
      return id;
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // --- Search ------------------------------------------------------------

  const startSearch = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (trimmed.length === 0) return;

      setText(trimmed);
      setMobileNavOpen(false);

      // Every source off is a state the master switch can reach, so it needs an
      // answer here. Saying so beats the alternatives: dispatching nothing looks
      // like a dead button, and falling back to "all of them" would search the
      // exact sources that were just switched off.
      if (enabledSources.length === 0) {
        toast("Every connector is off. Turn one on to search.");
        return;
      }

      // A connector with every account switched off has nothing to query, so it
      // is dropped from the fan-out as well — otherwise it would report an
      // empty success and look like "no matches".
      const dispatchable = enabledSources.filter(
        (s) => s === "web" || connections.some((c) => c.provider === s && c.enabled),
      );
      run(trimmed, dispatchable.length > 0 ? dispatchable : enabledSources);
    },
    [run, enabledSources, connections, toast],
  );

  // --- Connectors --------------------------------------------------------

  /**
   * Turning the last source off would make the search button a no-op with no
   * explanation, so the final enabled source is held on and the attempt is
   * explained instead.
   */
  const toggleSource = useCallback((source: Source) => {
    // A toggle is intent about the *next* search, so the bar stops describing the
    // one on screen and starts showing the preference again.
    setOverrodeOn(searchId);
    setEnabledSources((prev) => {
      if (!prev.includes(source)) return [...prev, source];
      if (prev.length === 1) return prev;
      return prev.filter((s) => s !== source);
    });
  }, [searchId, setEnabledSources]);

  /**
   * The switchboard header's master switch: every source, or none.
   *
   * This is the one path allowed to land on zero. `toggleSource` still holds the
   * last source on, because reaching empty one flick at a time is almost always a
   * miscount rather than an intention — whereas "all off" is unambiguous, and
   * `startSearch` says so rather than quietly searching everything.
   */
  const setAllSources = useCallback(
    (sources: Source[]) => {
      setOverrodeOn(searchId);
      setEnabledSources(sources);
    },
    [searchId, setEnabledSources],
  );

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
      const label = accountTitle(connections.find((c) => c.id === id));
      disconnectAccount(id);
      toast(`Disconnected ${label}, history kept`);
    },
    [connections, disconnectAccount, toast],
  );

  /**
   * The toast tells the truth about which of the two removals happened, because
   * they differ in a way the user can later notice: a row with sends attached
   * survives out of sight so the outbox can still explain them.
   */
  const removeConnection = useCallback(
    (id: string) => {
      const label = accountTitle(connections.find((c) => c.id === id));
      void removeAccount(id)
        .then((deleted) =>
          toast(deleted ? `Removed ${label}` : `Removed ${label}, past sends keep their history`),
        )
        .catch((err: unknown) =>
          toast(err instanceof Error ? err.message : `Could not remove ${label}`),
        );
    },
    [connections, removeAccount, toast],
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
      toast("Connection cancelled, nothing was changed");
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
        toast("Simulated revocation cleared. Re-run to pick the grant back up", {
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
      // ⌘K is labelled "New search" on the sidebar button, so it has to *be*
      // one: clear the field and drop the results on screen rather than
      // dropping a cursor into the query that produced them.
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newSearch();
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
  }, [newSearch]);

  /**
   * A send in progress is a toast, not a screen.
   *
   * Sending is not a decision — it is a wait, and a modal spinner over the whole
   * app is a poor way to say "hold on". The toast says it instead, and the app
   * stays usable underneath: search something else while it goes.
   */
  const onSending = useCallback(
    ({ sendId, draft }: { sendId: Id<"sends">; draft: Draft }) => {
      const label = draft.toLabel || draft.to;
      watchLabel.current = label;
      const toastId = toast(`Sending to ${label}…`, undefined, {
        tone: "pending",
        sticky: true,
      });
      setWatching({ sendId, toastId });
    },
    [toast],
  );

  /**
   * The claimed send has settled.
   *
   * Delivered is a toast carrying the way to the record rather than restating
   * it; anything else opens the failure dialog, which is where a person is
   * actually needed. Either way the pending toast comes down and the watcher
   * unmounts.
   */
  const onSettled = useCallback(
    (send: OutboxSend) => {
      setWatching((current) => {
        if (current !== null) dismissToast(current.toastId);
        return null;
      });

      if (send.status === "succeeded") {
        toast(`Delivered once to ${watchLabel.current}`, {
          label: "View in outbox",
          run: () => router.push("/outbox"),
        });
      } else {
        setFailedSendId(send.id);
      }
    },
    [toast, dismissToast, router],
  );

  // --- Outbox --------------------------------------------------------------

  /**
   * The only exit from an `unknown` send: the same payload under a *new*
   * idempotency key, minted by the freshly-mounted compose dialog. The old key
   * stays claimed by the indeterminate delivery, exactly as it should.
   */
  const composeAgain = useCallback((send: OutboxSend) => {
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

  /** Back to the search pane, for an action that only makes sense there. A
   *  no-op when it is already on screen, so the URL is not churned. */
  const toSearch = useCallback(() => {
    if (view === "outbox") router.push("/dashboard");
  }, [router, view]);

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
        toSearch();
      }}
      onRerun={(record) => {
        rerunFromHistory(record);
        toSearch();
      }}
      onNewSearch={() => {
        newSearch();
        toSearch();
      }}
      onArchiveToggle={toggleArchive}
      outboxActive={view === "outbox"}
      onOpenOutbox={() => {
        setMobileNavOpen(false);
        router.push("/outbox");
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

        {/* The outbox takes the pane rather than covering it. It is a record of
            what the product did, not a setting — reading it should feel like
            reading the results, which is why it is a route with the same cards
            and the same gutters rather than a dialog over them. */}
        {view === "outbox" ? (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <OutboxPage onReconnect={reconnect} onComposeAgain={composeAgain} />
          </div>
        ) : (
        <>
        {/* The lift. One flex column. In the hero state this spacer and the
            (empty) results pane below both grow, so the free space splits
            evenly and the field sits dead centre. On search the spacer's
            flex-grow animates to 0 and the field rises to the top. */}
        {/* The whole column scrolls, not just the results under the composer,
            so the scrollbar spans the pane top to bottom the way a search
            engine's does. The composer sticks to the top of that scroll. */}
        <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div
            className={`shrink-0 basis-0 transition-[flex-grow] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              hero ? "grow" : "grow-0"
            }`}
          />

          {/* No rule under the docked composer: the field's own border already
              separates it from the results, and a full-width line across the
              pane read as a second, competing edge. */}
          <div
            className={`sticky top-0 z-10 shrink-0 bg-ink-950 px-4 transition-[padding] duration-500 sm:px-6 ${
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
                      enabled={barSources}
                      connections={connections}
                      onToggleSource={toggleSource}
                      onSetAllSources={setAllSources}
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
          <div className="shrink-0">
            {hero ? null : (
              // The gutter sits outside the max-width, exactly as it does
              // around the composer above, so a card and the field it came
              // from land on the same left and right edge.
              <div className="px-4 pt-2 pb-6 sm:px-6">
                <div className="mx-auto w-full max-w-3xl space-y-3">
                  <ResultsList
                    query={query}
                    results={results}
                    runs={runs}
                    connections={connections}
                    working={working}
                    elapsed={elapsed}
                    onReply={(result) => setCompose({ result })}
                    onReconnect={reconnectSource}
                    onRetry={retrySource}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Mirrors the spacer above the composer. The results pane used to do
              this job by growing, but it can no longer grow now that the column
              itself is what scrolls. */}
          <div
            className={`shrink-0 basis-0 transition-[flex-grow] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              hero ? "grow" : "grow-0"
            }`}
          />
        </div>
        </>
        )}
      </main>

      {/* Toasts. They stack as a deck pinned to one spot rather than growing a
          column upward, so a burst of them never walks up the screen. */}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 px-4">
        {toasts.map((t, i) => {
          const depth = toasts.length - 1 - i;
          return (
            <div
              key={t.id}
              style={{
                transform: `translateX(-50%) translateY(${-depth * 8}px) scale(${1 - depth * 0.05})`,
                opacity: depth > 2 ? 0 : 1,
                zIndex: toasts.length - depth,
              }}
              className="pointer-events-auto absolute bottom-0 left-1/2 origin-bottom transition-all duration-200 ease-out"
            >
              {/* One line, always. The action is `shrink-0` and the text
                  truncates instead: an action allowed to wrap turned "View in
                  outbox" into three stacked words taller than the toast. */}
              <div className="pop-in flex max-w-[min(92vw,30rem)] items-center gap-2.5 rounded-full border border-line-strong bg-ink-850 py-1.5 pr-1.5 pl-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
                {t.tone === "pending" ? (
                  <span
                    role="status"
                    aria-label="In progress"
                    className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-400"
                  />
                ) : (
                  <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                )}
                <span className="min-w-0 flex-1 truncate py-1 text-[13px] text-neutral-200">
                  {t.text}
                </span>
                {t.action ? (
                  <button
                    onClick={() => {
                      t.action?.run();
                      setToasts((prev) => prev.filter((x) => x.id !== t.id));
                    }}
                    className="shrink-0 rounded-full bg-white/[0.06] px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-indigo-300 transition-colors hover:bg-indigo-500/15 hover:text-indigo-200"
                  >
                    {t.action.label}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Before the settings and connections dialogs in the tree, deliberately:
          a reply whose grant is dead sends you to settings *on top of* the open
          draft, so fixing the account and closing it leaves you exactly where
          you were. Same z-index, so later siblings win. */}
      {/* Keyed on the result: opening a reply to a different row remounts the
          dialog, which resets the draft — and mints a fresh idempotency key —
          without an effect to do it. */}
      {compose ? (
        <ComposeDialog
          key={compose.result.id}
          result={compose.result}
          accountLabel={
            connections.find((c) => c.id === compose.result.connectionId)?.label
          }
          // Until the list arrives the grant is assumed healthy: an unknown
          // status is not a broken one, and the send path refuses on its own if
          // it turns out to be.
          connectionStatus={
            connectionsLoading
              ? "active"
              : connections.find((c) => c.id === compose.result.connectionId)
                  ?.status
          }
          prefill={compose.prefill}
          onClose={() => setCompose(null)}
          onReconnect={() => setSettingsOpen(true)}
          onSending={onSending}
        />
      ) : null}

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

      {watching !== null ? (
        <SendWatcher sendId={watching.sendId} onSettled={onSettled} />
      ) : null}

      {/* Failure is the one send outcome that interrupts: it is waiting on a
          decision, and a toast cannot take one. */}
      {failedSendId !== null ? (
        <SendFailureDialog
          sendId={failedSendId}
          onClose={() => setFailedSendId(null)}
          onDelivered={(send) => {
            setFailedSendId(null);
            toast(`Delivered once to ${send.to}`, {
              label: "View in outbox",
              run: () => router.push("/outbox"),
            });
          }}
          onReconnect={(connectionId) => {
            setFailedSendId(null);
            reconnect(connectionId);
          }}
          onComposeAgain={(send) => {
            setFailedSendId(null);
            composeAgain(send);
          }}
        />
      ) : null}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connections={connections}
        onReconnect={reconnect}
        onAddAccount={addAccount}
        onDisconnect={disconnect}
        onRemove={removeConnection}
      />

    </div>
  );
}
