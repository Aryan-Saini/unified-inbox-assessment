"use client";

import { useMemo, useState } from "react";
import { BRAND_LOGO } from "./brand-icons";
import { SOURCE_META } from "./mock-data";
import type { Source, SourceRun, UiResult } from "./types";
import {
  ClockIcon,
  ExternalIcon,
  PlugIcon,
  ReplyIcon,
  RerunIcon,
  SearchIcon,
} from "./icons";

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One chip per source, doing two jobs that used to be two rows: it reports the
 * adapter's state (queued, searching, returned in Xs, needs reconnect, failed)
 * *and* filters the list to that source. The count and the name were printed
 * twice before, once in each row — the same fact stated twice reads as two
 * facts.
 *
 * A source never disappears from the strip, so a partial result set stays
 * legible as *why* it is partial.
 */
function SourceChip({
  run,
  count,
  elapsed,
  selected,
  onSelect,
  onReconnect,
  onRetry,
}: {
  run: SourceRun;
  count: number;
  elapsed: number;
  selected: boolean;
  onSelect: () => void;
  onReconnect: () => void;
  onRetry: () => void;
}) {
  const meta = SOURCE_META[run.source];
  const Logo = BRAND_LOGO[run.source];
  const inFlight = run.status === "pending" || run.status === "running";

  const shell =
    run.status === "needs_reconnect"
      ? "border-amber-500/35 bg-amber-500/[0.08]"
      : run.status === "failed"
        ? "border-rose-500/35 bg-rose-500/[0.08]"
        : selected
          ? "border-line-strong bg-white/[0.08]"
          : inFlight
            ? "border-line-strong bg-white/[0.04]"
            : "border-line bg-white/[0.02]";

  // Filtering to a source with nothing in it would blank the list for no
  // reason, so the chip is only a control once it has results.
  const selectable = count > 0;

  return (
    <div
      className={`relative flex items-center overflow-hidden rounded-lg border text-[12px] transition-colors duration-300 ${shell} ${
        run.status === "running" ? "sweep" : ""
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!selectable}
        aria-pressed={selected}
        // The mark identifies the source, so the name would be redundant — but
        // it still has to be the button's accessible name.
        aria-label={
          selectable
            ? `Show only ${meta.name} results`
            : `${meta.name} has no results to show`
        }
        title={
          selectable
            ? `Show only ${meta.name} results`
            : `${meta.name} has no results to show`
        }
        className="flex items-center gap-2 py-1.5 pr-2.5 pl-2.5 transition-colors enabled:hover:bg-white/[0.04] disabled:cursor-default"
      >
        <Logo className="h-4 w-4 shrink-0" />

        {run.status === "pending" ? (
          <span className="text-neutral-500">queued</span>
        ) : null}

        {run.status === "running" ? (
          <span className="flex items-center gap-1.5 text-neutral-400">
            <span
              className={`pulse-ring relative h-1.5 w-1.5 rounded-full ${meta.dot}`}
            />
            <span className="tabular-nums">{seconds(elapsed)}</span>
          </span>
        ) : null}

        {run.status === "succeeded" ? (
          <span className="text-neutral-500">
            <span className="tabular-nums text-neutral-300">{count}</span> ·{" "}
            <span className="tabular-nums">{seconds(run.durationMs ?? 0)}</span>
          </span>
        ) : null}

        {run.status === "needs_reconnect" ? (
          <span className="text-amber-200">needs reconnect</span>
        ) : null}

        {run.status === "failed" ? (
          <span className="text-rose-200">
            {run.errorKind === "transient" ? "rate limited" : "failed"}
          </span>
        ) : null}
      </button>

      {/* Recovery actions are siblings, not children, of the filter button — a
          button cannot nest inside another button. */}
      {run.status === "needs_reconnect" ? (
        <button
          type="button"
          onClick={onReconnect}
          className="mr-1.5 flex items-center gap-1 rounded-md bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/25"
        >
          <PlugIcon className="h-3 w-3" />
          Reconnect
        </button>
      ) : null}

      {run.status === "failed" ? (
        <button
          type="button"
          onClick={onRetry}
          className="mr-1.5 flex items-center gap-1 rounded-md bg-rose-400/15 px-2 py-0.5 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-400/25"
        >
          <RerunIcon className="h-3 w-3" />
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Wrap query terms so a reader can see why a row matched. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  if (tokens.length === 0) return <>{text}</>;

  const pattern = new RegExp(
    `(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  // `split` with a capturing group puts the matches at the odd indices, which
  // is cheaper and safer than re-testing each part (a /g regex carries
  // `lastIndex` between `test` calls and would mis-report).
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && part.length > 0 ? (
          <mark
            key={i}
            className="bg-indigo-400/20 text-inherit [text-decoration:inherit]"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      className="rise-in flex gap-3 rounded-xl border border-line/60 px-4 py-3.5"
      style={{ "--delay": `${index * 80}ms` } as React.CSSProperties}
    >
      <div className="sweep relative h-8 w-8 shrink-0 overflow-hidden rounded-lg bg-white/[0.04]" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="sweep relative h-3 w-2/5 overflow-hidden rounded bg-white/[0.05]" />
        <div className="sweep relative h-3 w-11/12 overflow-hidden rounded bg-white/[0.03]" />
        <div className="sweep relative h-3 w-3/5 overflow-hidden rounded bg-white/[0.03]" />
      </div>
    </div>
  );
}

function ResultCard({
  result,
  tokens,
  onReply,
}: {
  result: UiResult;
  tokens: string[];
  onReply: () => void;
}) {
  const meta = SOURCE_META[result.source];
  const host = result.url.replace(/^https?:\/\//, "").split("/")[0];

  return (
    <article className="rise-in group relative overflow-hidden rounded-xl border border-line bg-ink-900/60 transition-colors hover:border-line-strong hover:bg-ink-850">
      {/* Source rail. The only place colour carries meaning in a row. */}
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.dot} opacity-60`} />

      <div className="px-4 py-3.5 pl-5">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium ${meta.tint}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.name}
          </span>

          {result.author ? (
            <span className="max-w-[16rem] truncate text-neutral-300">
              {result.author}
            </span>
          ) : null}

          {result.context ? (
            <>
              <span className="text-neutral-700">·</span>
              <span className="truncate text-neutral-500">{result.context}</span>
            </>
          ) : null}

          <span className="ml-auto flex shrink-0 items-center gap-1 text-neutral-500">
            <ClockIcon className="h-3 w-3" />
            <time dateTime={result.timestamp}>{result.age}</time>
          </span>
        </header>

        <h3 className="mt-2 text-[14.5px] leading-snug font-medium text-neutral-100">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="decoration-neutral-600 underline-offset-2 hover:underline"
          >
            <Highlight text={result.title} tokens={tokens} />
          </a>
          {result.unread ? (
            <span
              title="Unread"
              className="ml-2 inline-block h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-indigo-400"
            />
          ) : null}
        </h3>

        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-neutral-400">
          <Highlight text={result.snippet} tokens={tokens} />
        </p>

        <footer className="mt-2.5 flex items-center gap-2">
          <span className="truncate font-mono text-[11px] text-neutral-600">
            {host}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {result.replyTo ? (
              <button
                onClick={onReply}
                className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] font-medium text-neutral-200 transition-colors hover:border-indigo-500/50 hover:bg-indigo-500/10 hover:text-white"
              >
                <ReplyIcon className="h-3.5 w-3.5" />
                Reply
              </button>
            ) : null}
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] font-medium text-neutral-300 transition-colors hover:border-neutral-500 hover:text-white"
            >
              <ExternalIcon className="h-3.5 w-3.5" />
              Open
            </a>
          </span>
        </footer>
      </div>
    </article>
  );
}

export function ResultsList({
  query,
  results,
  runs,
  working,
  elapsed,
  onReply,
  onReconnect,
  onRetry,
}: {
  query: string;
  results: UiResult[];
  runs: SourceRun[];
  working: boolean;
  elapsed: number;
  onReply: (result: UiResult) => void;
  onReconnect: (source: Source) => void;
  onRetry: (source: Source) => void;
}) {
  const [filter, setFilter] = useState<Source | "all">("all");
  const [sort, setSort] = useState<"arrival" | "newest" | "rank">("arrival");

  const SORT_LABEL = { arrival: "Arrival order", newest: "Newest first", rank: "Relevance" } as const;
  const NEXT_SORT = { arrival: "newest", newest: "rank", rank: "arrival" } as const;

  const tokens = useMemo(
    () =>
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((t) => t.length > 2),
    [query],
  );

  const counts = useMemo(() => {
    const map = { gmail: 0, slack: 0, web: 0 } as Record<Source, number>;
    results.forEach((r) => (map[r.source] += 1));
    return map;
  }, [results]);

  const shown = useMemo(() => {
    const list =
      filter === "all" ? results : results.filter((r) => r.source === filter);
    // Arrival order is the default *because* it is honest about streaming;
    // re-sorting is opt-in and only offered once a run has settled. Both sorts
    // copy before sorting, and ties keep arrival order (Array.sort is stable).
    if (sort === "newest") {
      return [...list].sort((a, b) =>
        (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
      );
    }
    if (sort === "rank") {
      return [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
    return list;
  }, [results, filter, sort]);

  const empty = results.length === 0;

  return (
    <div className="space-y-3">
      {/* One row: source state and source filter are the same control. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setFilter("all")}
          aria-pressed={filter === "all"}
          className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
            filter === "all"
              ? "border-line-strong bg-white/[0.08] text-white"
              : "border-transparent text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
          }`}
        >
          All <span className="tabular-nums opacity-60">{results.length}</span>
        </button>

        {runs.map((run) => (
          <SourceChip
            key={run.source}
            run={run}
            count={counts[run.source]}
            elapsed={elapsed}
            selected={filter === run.source}
            onSelect={() => setFilter(run.source)}
            onReconnect={() => onReconnect(run.source)}
            onRetry={() => onRetry(run.source)}
          />
        ))}

        <button
          type="button"
          onClick={() => setSort((v) => NEXT_SORT[v])}
          disabled={working}
          title={
            working
              ? "Available once every source has returned"
              : "Cycle sort: arrival → newest → relevance"
          }
          className="ml-auto rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-500 transition-colors hover:bg-white/[0.04] hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {SORT_LABEL[sort]}
        </button>
      </div>

      <div className="space-y-2">
        {shown.map((result) => (
          <ResultCard
            key={`${result.source}-${result.id}`}
            result={result}
            tokens={tokens}
            onReply={() => onReply(result)}
          />
        ))}

        {working && empty
          ? [0, 1, 2, 3].map((i) => <SkeletonRow key={i} index={i} />)
          : null}

        {!working && empty ? (
          <div className="rounded-xl border border-line bg-ink-900/60 px-6 py-12 text-center">
            <SearchIcon className="mx-auto h-6 w-6 text-neutral-700" />
            <p className="mt-3 text-[14px] font-medium text-neutral-300">
              No results for “{query}”
            </p>
            <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-neutral-500">
              Every source returned, and none of them matched. Try fewer words,
              or check the source strip above for a connection that needs
              attention.
            </p>
          </div>
        ) : null}

        {/* A tail spinner makes "more is coming" explicit once rows are on screen. */}
        {working && !empty ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-neutral-500">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-400" />
            more sources still returning…
          </div>
        ) : null}
      </div>
    </div>
  );
}
