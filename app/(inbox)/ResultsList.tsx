"use client";

import { useMemo, useState } from "react";
import { SOURCE_META, SOURCES } from "./mock-data";
import type { Source, UiResult } from "./types";
import { ClockIcon, ExternalIcon, ReplyIcon, SearchIcon } from "./icons";

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
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium ${meta.tint}`}
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
  working,
  onReply,
}: {
  query: string;
  results: UiResult[];
  working: boolean;
  onReply: (result: UiResult) => void;
}) {
  const [filter, setFilter] = useState<Source | "all">("all");
  const [newestFirst, setNewestFirst] = useState(false);

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
    if (!newestFirst) return list;
    // Arrival order is the default *because* it is honest about streaming;
    // sorting is opt-in and only offered once a run has settled.
    return [...list].sort((a, b) =>
      (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
    );
  }, [results, filter, newestFirst]);

  const empty = results.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setFilter("all")}
          className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors ${
            filter === "all"
              ? "bg-white/[0.08] text-white"
              : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
          }`}
        >
          All{" "}
          <span className="tabular-nums opacity-60">{results.length}</span>
        </button>

        {SOURCES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            disabled={counts[s] === 0}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              filter === s
                ? "bg-white/[0.08] text-white"
                : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${SOURCE_META[s].dot}`} />
            {SOURCE_META[s].name}
            <span className="tabular-nums opacity-60">{counts[s]}</span>
          </button>
        ))}

        <button
          onClick={() => setNewestFirst((v) => !v)}
          disabled={working}
          title={
            working
              ? "Available once every source has returned"
              : "Toggle sort order"
          }
          className="ml-auto rounded-lg px-2.5 py-1 text-[12px] font-medium text-neutral-500 transition-colors hover:bg-white/[0.04] hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {newestFirst ? "Newest first" : "Relevance"}
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
