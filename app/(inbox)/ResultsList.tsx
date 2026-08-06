"use client";

import { useMemo, useState } from "react";
import { BRAND_LOGO } from "./brand-icons";
import {
  ResultIdentity,
  faviconForEmail,
  faviconForUrl,
  siteNameOf,
  whereLine,
} from "./ResultIdentity";
import { SOURCE_META } from "./mock-data";
import type { Connection, Source, SourceRun, UiResult } from "./types";
import {
  AlertIcon,
  ClockIcon,
  ExternalIcon,
  PlugIcon,
  ReplyIcon,
  RerunIcon,
  SearchIcon,
  SendIcon,
  SortIcon,
  UpDownIcon,
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

  // No border of its own: the chip is a segment inside the bordered strip, and
  // a box drawn inside a box reads as two competing edges. Fill alone carries
  // the state.
  const shell =
    run.status === "needs_reconnect"
      ? "bg-amber-500/[0.14]"
      : run.status === "failed"
        ? "bg-rose-500/[0.14]"
        : selected
          ? "bg-white/[0.09]"
          : inFlight
            ? "bg-white/[0.05]"
            : "bg-transparent hover:bg-white/[0.04]";

  // Filtering to a source with nothing in it would blank the list for no
  // reason, so the chip is only a control once it has results.
  const selectable = count > 0;

  return (
    <div
      className={`relative flex items-center overflow-hidden rounded-xl text-[12px] transition-colors duration-300 ${shell} ${
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

        {/* The three states a chip passes through in one search are given a
            common minimum width, so the strip does not twitch under the reader
            as "queued" becomes a timer and then a count. */}
        {run.status === "pending" ? (
          <span className="min-w-[3.25rem] text-neutral-500">queued</span>
        ) : null}

        {/* No marker while in flight — the chip's own sweep already says the
            adapter is working, and the timer is ticking next to it. */}
        {run.status === "running" ? (
          <span className="min-w-[3.25rem] tabular-nums text-neutral-400">
            {seconds(elapsed)}
          </span>
        ) : null}

        {run.status === "succeeded" ? (
          <span className="min-w-[3.25rem] text-neutral-500">
            <span className="tabular-nums text-neutral-300">{count}</span> ·{" "}
            <span className="tabular-nums">{seconds(run.durationMs ?? 0)}</span>
          </span>
        ) : null}

        {/* A hazard mark rather than the words "needs reconnect": the
            Reconnect button beside it already says what the state is and what
            to do about it, so the label was the same sentence twice, in the
            widest form available. */}
        {run.status === "needs_reconnect" ? (
          <span role="img" aria-label={`${meta.name} needs reconnecting`}>
            <AlertIcon className="h-3.5 w-3.5 text-amber-300" />
          </span>
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

/**
 * A stand-in for one `ResultCard`, block for block: avatar, two identity lines,
 * headline, two snippet lines, action row. The wrapper heights are the *line
 * boxes* of the real thing rather than the bar heights, so a skeleton occupies
 * the same space its result will — otherwise every arriving row shoves the list
 * down under the reader's eye, which is the one job a skeleton has.
 */
function SkeletonRow({ index }: { index: number }) {
  const bar = "sweep relative overflow-hidden rounded bg-white/[0.04]";

  return (
    <div
      className="rise-in rounded-2xl border border-line-strong bg-ink-850 px-4 py-3.5"
      style={{ "--delay": `${index * 80}ms` } as React.CSSProperties}
    >
      <div className="flex items-start gap-3">
        <div className={`${bar} mt-0.5 h-8 w-8 shrink-0 rounded-full`} />

        <div className="min-w-0 flex-1">
          <div className="flex h-4 items-center">
            <div className={`${bar} h-3 w-32`} />
          </div>
          <div className="mt-0.5 flex h-3.5 items-center">
            <div className={`${bar} h-2.5 w-52`} />
          </div>
        </div>

        <div className="flex h-4 items-center">
          <div className={`${bar} h-2.5 w-10`} />
        </div>
      </div>

      {/* Headline: 16px on `leading-snug`. */}
      <div className="mt-2.5 flex h-[22px] items-center">
        <div className={`${bar} h-4 w-3/5`} />
      </div>

      {/* Snippet: two lines of 13px on `leading-relaxed`. */}
      <div className="mt-1 flex h-[21px] items-center">
        <div className={`${bar} h-3 w-full`} />
      </div>
      <div className="flex h-[21px] items-center">
        <div className={`${bar} h-3 w-4/5`} />
      </div>

      {/* The action row. An invisible copy of the real button rather than a
          measured height, so it cannot drift out of step when that button's
          padding or type size changes. */}
      <div className="mt-2.5 flex items-center" aria-hidden>
        <span className="invisible flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] font-medium">
          <ReplyIcon className="h-3.5 w-3.5" />
          Reply
        </span>
      </div>
    </div>
  );
}

function ResultCard({
  result,
  tokens,
  account,
  onReply,
}: {
  result: UiResult;
  tokens: string[];
  /** The connected account this result was found by, if it is still connected. */
  account?: Connection;
  onReply: () => void;
}) {
  const meta = SOURCE_META[result.source];

  /** Chat, i.e. a source whose rows are messages with no subject of their own. */
  const isMessage = result.source === "slack";
  const isWeb = result.source === "web";

  /** One of the user's own sent messages, which Gmail search returns too. */
  const isSent = result.outgoing === true;

  // Who the row is *about*. Normally the sender; on a message you sent, the person
  // you sent it to — naming yourself on your own outgoing mail says nothing, and
  // the name beside the "to" address has to be the same party as the address. A
  // web hit has no author at all, and "Web" only repeats the chip beside it, so
  // the site takes the line.
  const who = isWeb
    ? siteNameOf(result.url)
    : isSent
      ? (result.recipientName ?? result.recipient ?? "(no recipient)")
      : (result.author ?? meta.name);

  // The address beside that name, and it must belong to the same party: the
  // recipient's on a sent message, the sender's otherwise. Dropped when it only
  // repeats the name, and never shown for Slack, where `replyTo` is a channel id.
  const address = isSent ? result.recipient : result.replyTo;
  const sender =
    result.source === "gmail" && address !== who ? address : undefined;

  return (
    // Same shell as the search field — `border-line-strong` on `bg-ink-850`,
    // rounded-2xl — so the composer and the rows it produced read as one
    // surface rather than two different card styles.
    <article className="rise-in group relative rounded-2xl border border-line-strong bg-ink-850 transition-colors duration-300 hover:border-neutral-600">
      <div className="px-4 py-3.5">
        {/* A search-engine result row: who it came from and where it lives sit
            beside the brand mark, then the title as the link, then the snippet.
            Reading top to bottom answers "from whom, about what" before the
            body — the order a person scans a list of hits in. */}
        <header className="flex items-start gap-3">
          <ResultIdentity
            source={result.source}
            avatarUrl={result.avatarUrl}
            favicon={
              isWeb
                ? faviconForUrl(result.url)
                : result.source === "gmail"
                  ? faviconForEmail(address)
                  : undefined
            }
            seed={isWeb ? result.url : address}
            where={whereLine(result, account?.label)}
            label={who}
            fullName={`${isSent ? "to " : ""}${who}${sender ? ` <${sender}>` : ""}`}
            name={
              <>
                {/* "to" rather than a pill, because it is the grammar of the
                    line: "to Sam <sam@…>" reads as one fact, where a Sent badge
                    plus an unqualified name reads as two. */}
                {isSent ? <span className="text-neutral-500">to </span> : null}
                {who}
                {sender ? (
                  <span className="text-neutral-500"> &lt;{sender}&gt;</span>
                ) : null}
              </>
            }
          />

          <span className="flex shrink-0 items-center gap-2 text-[11px] text-neutral-500">
            {/* Your own message, marked where the eye already goes for the
                row's metadata. The "to" in the name line says the same thing
                grammatically, but it is one word deep in a sentence — scanning
                a column of results, a mark on the right edge is what separates
                what you sent from what you received without reading either. */}
            {isSent ? (
              <span
                title="You sent this"
                className="flex items-center gap-1 rounded-md bg-indigo-500/12 px-1.5 py-0.5 font-medium text-indigo-300"
              >
                <SendIcon className="h-3 w-3" />
                Sent
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <ClockIcon className="h-3 w-3" />
              <time dateTime={result.timestamp}>{result.age}</time>
            </span>
          </span>
        </header>

        {/* Two body treatments, because two different things are being shown.
            An email has a subject: a short label, written to be scanned, and it
            earns the headline. A chat message has no subject — the text *is* the
            message — so styling it as a big coloured link made it read as a
            title someone wrote, which is exactly why a Slack row did not look
            like a message. It gets body type instead: white, unemphasised, up to
            three lines, underlined only on hover. */}
        {isMessage ? (
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block line-clamp-3 text-[14px] leading-relaxed text-neutral-100 decoration-neutral-600 underline-offset-2 hover:underline"
          >
            <Highlight text={result.snippet} tokens={tokens} />
          </a>
        ) : (
          <>
            {/* Clamped, because a subject line is capped at 988 characters and
                one written to the cap otherwise renders as ten lines of
                headline and pushes the snippet off the card. */}
            <h3 className="mt-2.5 line-clamp-3 text-[16px] leading-snug font-medium text-indigo-300">
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                <Highlight text={result.title} tokens={tokens} />
              </a>
            </h3>

            <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-neutral-400">
              <Highlight text={result.snippet} tokens={tokens} />
            </p>
          </>
        )}

        <footer className="mt-2.5 flex items-center gap-2">
          {/* Slack puts the thread under the message it belongs to, and that is
              often where the answer actually is — so the row says a thread
              exists rather than making you open it to find out. */}
          {result.replyCount ? (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-[12px] text-neutral-500 hover:text-neutral-300"
            >
              <ReplyIcon className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
              <span className="font-medium text-indigo-300">
                {result.replyCount}{" "}
                {result.replyCount === 1 ? "reply" : "replies"}
              </span>
              {/* When the thread was last alive. A count alone does not say
                  whether the conversation is still moving. */}
              {result.lastReplyAge ? (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>last {result.lastReplyAge}</span>
                </>
              ) : null}
            </a>
          ) : null}

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
  connections,
  working,
  elapsed,
  onReply,
  onReconnect,
  onRetry,
}: {
  query: string;
  results: UiResult[];
  runs: SourceRun[];
  /** Used to name the account a result arrived at — see `ResultCard`. */
  connections: Connection[];
  working: boolean;
  elapsed: number;
  onReply: (result: UiResult) => void;
  onReconnect: (source: Source) => void;
  onRetry: (source: Source) => void;
}) {
  const [filter, setFilter] = useState<Source | "all">("all");
  const [sort, setSort] = useState<"arrival" | "newest" | "rank">("arrival");
  /** `desc` is each sort's natural reading: first-to-arrive, newest, best. */
  const [direction, setDirection] = useState<"desc" | "asc">("desc");

  const byConnection = useMemo(
    () => new Map(connections.map((c) => [c.id, c])),
    [connections],
  );

  const SORT_LABEL = { arrival: "Arrival order", newest: "Newest first", rank: "Relevance" } as const;
  const NEXT_SORT = { arrival: "newest", newest: "rank", rank: "arrival" } as const;

  // "Reversed" means something different per sort, and saying which is the
  // whole value of the control — an arrow on its own only says "not the other
  // way".
  const DIRECTION_LABEL = {
    arrival: { desc: "First to arrive", asc: "Last to arrive" },
    newest: { desc: "Newest first", asc: "Oldest first" },
    rank: { desc: "Best match first", asc: "Weakest match first" },
  } as const;

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

  // Direction is applied to the finished order rather than folded into each
  // comparator: one reversal is the same answer for all three sorts, and it
  // keeps ties in arrival order instead of inverting them too.
  const ordered = useMemo(
    () => (direction === "desc" ? shown : [...shown].reverse()),
    [shown, direction],
  );

  const empty = results.length === 0;

  return (
    <div className="space-y-3">
      {/* One row: source state and source filter are the same control. Both
          halves wear the search field's shell, so the strip reads as chrome
          belonging to the composer above rather than as the first result. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-2xl border border-line-strong bg-ink-850 p-1">
          <button
            type="button"
            onClick={() => setFilter("all")}
            aria-pressed={filter === "all"}
            className={`rounded-xl px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
              filter === "all"
                ? "bg-white/[0.09] text-white"
                : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
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
        </div>

        {/* Which order, and which way round — two questions, so two controls,
            sharing one shell built exactly like the filter bar so both ends of
            the row are the same height. */}
        <div className="ml-auto flex items-center gap-1 rounded-2xl border border-line-strong bg-ink-850 p-1">
          <button
            type="button"
            onClick={() => setSort((v) => NEXT_SORT[v])}
            disabled={working}
            title={
              working
                ? "Available once every source has returned"
                : "Cycle sort: arrival → newest → relevance"
            }
            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[12px] font-medium text-neutral-300 transition-colors hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <SortIcon className="h-3.5 w-3.5 shrink-0" />
            {/* Fixed width: the three labels are different lengths, and letting
                the button resize as it cycles would shift its own edge out from
                under the pointer that just clicked it. */}
            <span className="w-[6.5rem] text-left">{SORT_LABEL[sort]}</span>
          </button>

          <span className="h-4 w-px shrink-0 bg-line" />

          <button
            type="button"
            onClick={() => setDirection((v) => (v === "desc" ? "asc" : "desc"))}
            disabled={working}
            aria-pressed={direction === "asc"}
            aria-label={`${DIRECTION_LABEL[sort][direction]}, reverse the order`}
            title={
              working
                ? "Available once every source has returned"
                : `${DIRECTION_LABEL[sort][direction]}, click to reverse`
            }
            className={`flex shrink-0 items-center justify-center rounded-xl p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
              direction === "asc"
                ? "bg-white/[0.09] text-white"
                : "text-neutral-400 hover:bg-white/[0.05] hover:text-white"
            }`}
          >
            <UpDownIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {ordered.map((result) => (
          <ResultCard
            key={`${result.source}-${result.id}`}
            result={result}
            tokens={tokens}
            account={
              result.connectionId ? byConnection.get(result.connectionId) : undefined
            }
            onReply={() => onReply(result)}
          />
        ))}

        {working && empty
          ? [0, 1, 2, 3].map((i) => <SkeletonRow key={i} index={i} />)
          : null}

        {/* Not a card. A card is a container for a thing, and there is no thing
            here — an empty list should read as absence, not as a result whose
            content happens to be the word "none". */}
        {!working && empty ? (
          <div className="px-6 py-14 text-center">
            <SearchIcon className="mx-auto h-6 w-6 text-neutral-700" />
            <p className="mt-3 text-[14px] font-medium text-neutral-300">
              No results for “{query}”
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-neutral-500">
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
