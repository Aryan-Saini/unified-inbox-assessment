"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { describeError, type AppErrorView } from "./appError";
import { accountTitle, formatAge } from "./format";
import { ResultIdentity, faviconForEmail, faviconForUrl } from "./ResultIdentity";
import { SOURCE_META } from "./mock-data";
import { Button, StatusPill } from "./ui";
import { useClockMinute } from "./useClock";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  PlugIcon,
  PlusIcon,
  ReplyIcon,
  RerunIcon,
  SendIcon,
  ShieldIcon,
} from "./icons";

/** One row of `sends.listDetailed` — a send with its account and its origin. */
export type OutboxEntry = FunctionReturnType<typeof api.sends.listDetailed>[number];
/** The send itself, as the server reports it. */
export type OutboxSend = OutboxEntry["send"];

type SendStatus = OutboxSend["status"];
type Attempt = NonNullable<
  FunctionReturnType<typeof api.sends.watch>
>["attempts"][number];

/** The three statuses an operator retry is allowed to act on. `unknown` is
 *  deliberately absent — the server refuses it, so the button never shows. */
const RETRYABLE: SendStatus[] = [
  "failed_transient",
  "failed_permanent",
  "needs_reconnect",
];

/**
 * All seven statuses, each with its own reading. Tone alone cannot carry seven
 * distinct meanings through five colours, so the ambiguous pairs get a glyph:
 * a plug for "fix the grant", a spinner for "someone is mid-attempt", an alert
 * for "we genuinely do not know".
 */
function SendStatusBadge({ status }: { status: SendStatus }) {
  switch (status) {
    case "queued":
      return <StatusPill tone="idle">queued</StatusPill>;
    case "in_flight":
      return (
        <StatusPill tone="info">
          <span className="h-2.5 w-2.5 animate-spin rounded-full border border-indigo-400/40 border-t-indigo-300" />
          in flight
        </StatusPill>
      );
    case "succeeded":
      return (
        <StatusPill tone="ok">
          <CheckIcon className="h-3 w-3" />
          delivered
        </StatusPill>
      );
    case "failed_transient":
      return (
        <StatusPill tone="warn">
          <RerunIcon className="h-3 w-3" />
          failed, retryable
        </StatusPill>
      );
    case "failed_permanent":
      return <StatusPill tone="bad">failed</StatusPill>;
    case "needs_reconnect":
      return (
        <StatusPill tone="warn">
          <PlugIcon className="h-3 w-3" />
          needs reconnect
        </StatusPill>
      );
    case "unknown":
      return (
        <StatusPill tone="bad">
          <AlertIcon className="h-3 w-3" />
          unknown
        </StatusPill>
      );
  }
}

/** What the status *means* for this delivery, and what to do about it. The
 *  interesting sentences are the non-obvious ones: why a retry is safe, and
 *  why (for `unknown`) it is refused. */
function statusCopy(send: OutboxSend): {
  tone: "ok" | "warn" | "bad" | "info";
  title: string;
  body: string;
} {
  switch (send.status) {
    case "queued":
      return {
        tone: "info",
        title: "Queued",
        body: "The delivery attempt is scheduled and will start momentarily. Its outcome lands in the timeline below.",
      };
    case "in_flight":
      return {
        tone: "info",
        title: "Attempt in flight",
        body: "An attempt is talking to the provider right now, which is why retry is unavailable: racing it could send twice.",
      };
    case "succeeded":
      return {
        tone: "ok",
        title: `Delivered once to ${send.to}`,
        body: "The provider acknowledged this message. Any retry carrying the same idempotency key returns this receipt instead of sending again.",
      };
    case "failed_transient":
      return {
        tone: "warn",
        title: "Not delivered: transient failure",
        body:
          send.nextRetryAt !== undefined
            ? "The provider failed in a way that may clear on its own; an automatic retry is already scheduled. A manual retry reuses the same key, so it still cannot send twice."
            : "The provider failed in a way that may clear on its own, and the automatic retries are spent. Nothing was delivered, and a manual retry reuses the same key, so it still cannot send twice.",
      };
    case "failed_permanent":
      return {
        tone: "bad",
        title: "Not delivered: permanent failure",
        body: "The provider rejected this message outright, so retrying it unchanged is expected to fail the same way. The error below is the provider's own verdict.",
      };
    case "needs_reconnect":
      return {
        tone: "warn",
        title: "Not delivered: the grant needs reconnecting",
        body: "The account's authorisation is no longer valid. Reconnect it, then retry: the retry reuses this same idempotency key, so it still cannot send twice.",
      };
    case "unknown":
      return {
        tone: "bad",
        title: "Could not confirm delivery",
        body: "The message was handed to the provider but never acknowledged, so whether it arrived is genuinely unknown. Retrying under this key could send a second copy, so it is refused. Compose again with a new key if it must go out.",
      };
  }
}

const BANNER_TONE = {
  ok: "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/[0.07] text-amber-400",
  bad: "border-rose-500/30 bg-rose-500/[0.07] text-rose-400",
  info: "border-indigo-500/30 bg-indigo-500/[0.07] text-indigo-300",
} as const;

const TRIGGER_LABEL = {
  initial: "initial",
  auto: "auto retry",
  manual: "manual retry",
} as const;

/** Wall-clock time of an attempt. Only ever rendered client-side, after the
 *  card is expanded, so it cannot disagree with server-rendered HTML. */
function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function duration(startedAt: number, finishedAt: number) {
  return `${((finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

function AttemptRow({ attempt }: { attempt: Attempt }) {
  return (
    <li className="rounded-lg border border-line bg-ink-900 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
        <span className="font-mono text-neutral-500">#{attempt.attemptNumber}</span>
        <span className="text-neutral-400">{TRIGGER_LABEL[attempt.trigger]}</span>
        <StatusPill
          tone={
            attempt.outcome === "succeeded"
              ? "ok"
              : attempt.outcome === undefined
                ? "info"
                : "bad"
          }
        >
          {attempt.outcome ?? "in flight"}
        </StatusPill>
        {attempt.httpStatus !== undefined ? (
          <span className="font-mono text-[11px] text-neutral-600">
            HTTP {attempt.httpStatus}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] text-neutral-600">
          <ClockIcon className="h-3 w-3" />
          {clock(attempt.startedAt)}
          {attempt.finishedAt !== undefined
            ? ` · ${duration(attempt.startedAt, attempt.finishedAt)}`
            : null}
        </span>
      </div>

      {/* The full redacted error, never truncated: this timeline is where an
          operator comes to read what actually happened. */}
      {attempt.errorMessage !== undefined ? (
        <p className="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-neutral-400">
          {attempt.errorKind !== undefined ? (
            <span className="text-neutral-500">{attempt.errorKind}: </span>
          ) : null}
          {attempt.errorMessage}
        </p>
      ) : null}

      {attempt.providerMessageId !== undefined ? (
        <p className="mt-1.5 font-mono text-[11px] break-all text-neutral-500">
          provider id {attempt.providerMessageId}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The message this send was an answer to, rendered with the same identity block
 * the search results use.
 *
 * A reply printed on its own is half a record — "Thanks for the ping" says
 * nothing about what was being thanked. Quoting the original above it makes the
 * pair readable as the exchange it actually is, and reuses `ResultIdentity` so
 * the face, the brand badge and the where-line match the row the reply was
 * composed from.
 */
function RepliedTo({ origin }: { origin: NonNullable<OutboxEntry["repliedTo"]> }) {
  const isWeb = origin.source === "web";
  const who = origin.author ?? SOURCE_META[origin.source].name;
  // Slack's `replyTo` is a channel id — the context line already names the
  // channel, so printing both gave "#finance · 6 replies · C0FINANCE".
  const where = [origin.context, origin.source === "gmail" ? origin.replyTo : undefined]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="px-4 pt-3.5">
      <span className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
        In reply to
      </span>
      <div className="flex items-start gap-3">
        <ResultIdentity
          source={origin.source}
          avatarUrl={origin.avatarUrl}
          favicon={
            isWeb
              ? faviconForUrl(origin.url)
              : origin.source === "gmail"
                ? faviconForEmail(origin.replyTo)
                : undefined
          }
          seed={isWeb ? origin.url : origin.replyTo}
          label={who}
          where={where === "" ? SOURCE_META[origin.source].name : where}
          name={who}
        />
      </div>

      {/* Title only where a title is a real thing: an email subject. A Slack
          message's "title" is its own first line, so printing both repeats it. */}
      {origin.source === "gmail" && origin.title !== "" ? (
        <p className="mt-2 line-clamp-1 text-[13.5px] font-medium text-neutral-200">
          {origin.title}
        </p>
      ) : null}
      <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-neutral-400">
        {origin.snippet}
      </p>
    </div>
  );
}

/**
 * One recorded delivery: what it answered, what went out, and — once expanded —
 * every attempt behind its status.
 *
 * Expansion rather than a second screen. The list is the history and the
 * timeline is evidence for one row of it; putting the evidence under the claim
 * keeps the two in one place, and means "retry this" never costs a navigation.
 */
function SendCard({
  entry,
  now,
  expanded,
  onToggle,
  onReconnect,
  onComposeAgain,
}: {
  entry: OutboxEntry;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onReconnect: (connectionId: string) => void;
  onComposeAgain: (send: OutboxSend) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorView | null>(null);
  /** What the last press of a retry button actually did, in one line. */
  const [note, setNote] = useState<string | null>(null);
  const retryMutation = useMutation(api.sends.retry);
  const sendMutation = useMutation(api.sends.send);

  const { send } = entry;
  const isSlack = send.channel === "slack";
  const meta = SOURCE_META[send.channel];
  const copy = statusCopy(send);

  // The timeline is only subscribed to while the card is open: fifty live
  // attempt subscriptions to render a list nobody has asked to read yet is a
  // cost with no reader.
  const detail = useAuthedQuery(
    api.sends.watch,
    expanded ? { sendId: send.id } : "skip",
  );
  const attempts = detail?.attempts ?? [];

  const account = accountTitle(entry.account, "removed account");

  const retry = async () => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const { retried, reason } = await retryMutation({ sendId: send.id });
      if (!retried) {
        setNote(
          reason === "already_delivered"
            ? "Already delivered, so no second attempt was started."
            : "An attempt is already in progress, so nothing was started.",
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The dedupe proof, as a button.
   *
   * It calls `sends.send` on the original draft — the same call the compose flow
   * makes — and the key is already claimed, so the stored delivery comes back
   * and no provider call happens. Pressing it repeatedly is the point: the
   * delivery count on this card stays at one however many times you do.
   */
  const sendAgainWithSameKey = async () => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const claim = await sendMutation({ draftId: send.draftId });
      setNote(
        claim.claimed
          ? "A new delivery was claimed for this key."
          : "Deduplicated. The stored delivery came back and nothing was sent, so there is still exactly one message.",
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rise-in rounded-2xl border border-line-strong bg-ink-850 transition-colors duration-300 hover:border-neutral-600">
      {entry.repliedTo !== undefined ? <RepliedTo origin={entry.repliedTo} /> : null}

      <div
        className={`px-4 py-3.5 ${
          entry.repliedTo !== undefined ? "mt-3.5 border-t border-line" : ""
        }`}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <ReplyIcon className="h-4 w-4 shrink-0 text-indigo-300" />
          <span className="text-[12.5px] text-neutral-400">
            Sent as{" "}
            <span className="font-medium text-neutral-200">{account}</span> to{" "}
            <span className="font-medium text-neutral-200">
              {entry.toLabel ?? send.to}
            </span>
          </span>
          {send.isSeed ? <StatusPill tone="idle">demo</StatusPill> : null}

          <span className="ml-auto flex shrink-0 items-center gap-2">
            <SendStatusBadge status={send.status} />
            <span className="flex items-center gap-1 text-[11px] text-neutral-500">
              <ClockIcon className="h-3 w-3" />
              {formatAge(send.createdAt, now)}
            </span>
          </span>
        </header>

        {/* The frozen payload, not the draft's latest text: this is the record
            of what left the building. */}
        {/* The subject is clamped for the same reason the result cards clamp
            theirs: it may be 988 characters, and one written to the cap is nine
            lines of heading before the message it belongs to. */}
        {!isSlack && send.subject !== undefined ? (
          <h3 className="mt-2.5 line-clamp-2 text-[15px] leading-snug font-medium text-neutral-100">
            {send.subject}
          </h3>
        ) : null}
        {/* Collapsed it clamps; expanded it scrolls. Not unbounded either way:
            a body may be 50,000 characters, and "show it all" turns one card
            into several screens of text with the actions stranded past the
            bottom of them. */}
        <p
          className={`mt-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-neutral-200 ${
            expanded ? "scrollbar-thin max-h-64 overflow-y-auto" : "line-clamp-4"
          }`}
        >
          {send.body}
        </p>

        <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-[11px] text-neutral-600">
            {send.idempotencyKey}
          </span>
          <span className="text-[11px] text-neutral-600">
            {send.attemptCount} of {send.maxAttempts} auto attempts
          </span>

          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {send.status === "needs_reconnect" ? (
              <Button
                variant="outline"
                onClick={() => onReconnect(send.connectionId)}
                className="!px-2.5 !py-1.5 !text-[12px]"
              >
                <PlugIcon className="h-3.5 w-3.5" />
                Reconnect
              </Button>
            ) : null}
            {RETRYABLE.includes(send.status) ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void retry()}
                className="!px-2.5 !py-1.5 !text-[12px]"
              >
                <RerunIcon className="h-3.5 w-3.5" />
                Retry with the same key
              </Button>
            ) : null}
            {send.status === "unknown" ? (
              <Button
                variant="primary"
                onClick={() => onComposeAgain(send)}
                className="!px-2.5 !py-1.5 !text-[12px]"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Compose again with a new key
              </Button>
            ) : null}

            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              {expanded ? "Hide detail" : "Detail"}
              <ChevronDownIcon
                className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          </span>
        </footer>

        {error !== null ? (
          <p className="mt-2.5 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-3 py-2 text-[12px] leading-relaxed text-rose-100/90">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
            <span className="min-w-0">
              {error.message}
              <code className="mt-1 block font-mono text-[11px] text-rose-300/70">
                {error.code}
              </code>
            </span>
          </p>
        ) : null}

        {note !== null ? (
          <p className="mt-2.5 flex items-start gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/[0.07] px-3 py-2 text-[12px] leading-relaxed text-indigo-100/90">
            <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300" />
            {note}
          </p>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-line px-4 py-3.5">
          <div
            className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 ${BANNER_TONE[copy.tone]}`}
          >
            {copy.tone === "ok" ? (
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-white">{copy.title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">
                {copy.body}
              </p>
            </div>
          </div>

          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-900">
            {[
              ["Channel", meta.name],
              [isSlack ? "Slack channel" : "Recipient", send.to],
              ["Account", account],
              ...(isSlack ? [] : [["Subject", send.subject ?? ""]]),
              ["Idempotency key", send.idempotencyKey],
              ...(send.providerMessageId !== undefined
                ? [["Provider message id", send.providerMessageId]]
                : []),
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-start gap-3 px-3.5 py-2.5 text-[12.5px]"
              >
                <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
                <dd className="min-w-0 flex-1 font-mono break-words text-neutral-100">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {/* Not an action on this delivery — it is finished, and pressing
              something called "retry" on a delivered message would be a strange
              thing to offer. It is a check on the guarantee: call `/send` again
              with the key this row already holds and watch nothing happen. It
              lives here, described, rather than sitting on the card next to the
              real actions. */}
          {send.status === "succeeded" ? (
            <div className="rounded-lg border border-line bg-ink-900 px-3.5 py-3">
              <p className="text-[12.5px] leading-relaxed text-neutral-400">
                This key is claimed, so calling <code className="font-mono text-neutral-300">/send</code>{" "}
                again returns this same delivery instead of producing a second
                one. Press it as often as you like — the count stays at one.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void sendAgainWithSameKey()}
                className="mt-2.5 !px-2.5 !py-1.5 !text-[12px]"
              >
                <ShieldIcon className="h-3.5 w-3.5" />
                Call /send again with this key
              </Button>
            </div>
          ) : null}

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              Attempt timeline
            </span>
            {detail === undefined ? (
              <p className="flex items-center justify-center gap-2 py-4 text-[12px] text-neutral-500">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-400" />
                loading attempts…
              </p>
            ) : attempts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-3.5 py-4 text-center text-[12px] text-neutral-500">
                No attempts recorded yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {attempts.map((attempt) => (
                  <AttemptRow key={attempt.id} attempt={attempt} />
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * The outbox, as a page rather than a dialog.
 *
 * It is the same reading as the search results — one scrollable column of cards
 * in the same shell — because it answers the same kind of question: here is a
 * thing that happened, here is who it involved, here is what it said. A modal
 * made history feel like a settings screen you visit and dismiss; history is
 * half of what this product records, and the confirm-gate story is only legible
 * if the exchange either side of it is on screen together.
 */
export function OutboxPage({
  onReconnect,
  onComposeAgain,
}: {
  /** Starts the OAuth re-grant for a connection id. Navigates away. */
  onReconnect: (connectionId: string) => void;
  /** Opens the compose dialog prefilled with this send's payload — the only
   *  safe way forward for an `unknown` outcome. */
  onComposeAgain: (send: OutboxSend) => void;
}) {
  const [expandedId, setExpandedId] = useState<Id<"sends"> | null>(null);
  const entries = useAuthedQuery(api.sends.listDetailed, {});
  const now = useClockMinute();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 sm:px-6">
      <header className="pt-2 pb-5">
        <h1 className="flex items-center gap-2.5 text-[22px] font-semibold tracking-tight text-white">
          <SendIcon className="h-5 w-5 text-indigo-300" />
          Outgoing
        </h1>
      </header>

      {entries === undefined ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-neutral-500">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-400" />
          loading sends…
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line-strong px-3.5 py-10 text-center text-[13px] text-neutral-500">
          Nothing sent yet. Reply to a search result to record your first
          delivery, or load the demo data in Settings to see every status.
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <SendCard
              key={entry.send.id}
              entry={entry}
              now={now}
              expanded={expandedId === entry.send.id}
              onToggle={() =>
                setExpandedId((prev) =>
                  prev === entry.send.id ? null : entry.send.id,
                )
              }
              onReconnect={onReconnect}
              onComposeAgain={onComposeAgain}
            />
          ))}
        </div>
      )}
    </div>
  );
}
