"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { describeError, type AppErrorView } from "./appError";
import { BRAND_LOGO } from "./brand-icons";
import { formatAge } from "./format";
import { SOURCE_META } from "./mock-data";
import type { Connection } from "./types";
import { Button, Modal, StatusPill } from "./ui";
import { useClockMinute } from "./useClock";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  PlugIcon,
  PlusIcon,
  RerunIcon,
} from "./icons";

/** One row of `sends.list` — the send exactly as the server reports it. */
export type OutboxSend = FunctionReturnType<typeof api.sends.list>[number];

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
          failed — retryable
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
        body: "An attempt is talking to the provider right now, which is why retry is unavailable — racing it could send twice.",
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
        title: "Not delivered — transient failure",
        body:
          send.nextRetryAt !== undefined
            ? "The provider failed in a way that may clear on its own; an automatic retry is already scheduled. A manual retry reuses the same key, so it still cannot send twice."
            : "The provider failed in a way that may clear on its own, and the automatic retries are spent. Nothing was delivered — a manual retry reuses the same key, so it still cannot send twice.",
      };
    case "failed_permanent":
      return {
        tone: "bad",
        title: "Not delivered — permanent failure",
        body: "The provider rejected this message outright, so retrying it unchanged is expected to fail the same way. The error below is the provider's own verdict.",
      };
    case "needs_reconnect":
      return {
        tone: "warn",
        title: "Not delivered — the grant needs reconnecting",
        body: "The account's authorisation is no longer valid. Reconnect it, then retry: the retry reuses this same idempotency key, so it still cannot send twice.",
      };
    case "unknown":
      return {
        tone: "bad",
        title: "Could not confirm delivery",
        body: "The message was handed to the provider but never acknowledged, so whether it arrived is genuinely unknown. Retrying under this key could send a second copy, so it is refused — compose again with a new key if it must go out.",
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

/** Wall-clock time of an attempt. Only ever rendered client-side, after a
 *  click, so it cannot disagree with server-rendered HTML. */
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
    <li className="rounded-lg border border-line bg-ink-850/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
        <span className="font-mono text-neutral-500">
          #{attempt.attemptNumber}
        </span>
        <span className="text-neutral-400">
          {TRIGGER_LABEL[attempt.trigger]}
        </span>
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
 * The outbox: every send this account has recorded, and — one click in — the
 * exact payload, the connection it went through, and the attempt-by-attempt
 * history behind its status. One dialog, two panes, so a phone flips between
 * list and detail instead of nesting drawers.
 */
export function OutboxDialog({
  open,
  onClose,
  connections,
  onReconnect,
  onComposeAgain,
}: {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  /** Starts the OAuth re-grant for a connection id. Navigates away. */
  onReconnect: (connectionId: string) => void;
  /** Opens the compose dialog prefilled with this send's payload — the only
   *  safe way forward for an `unknown` outcome. */
  onComposeAgain: (send: OutboxSend) => void;
}) {
  const [selectedId, setSelectedId] = useState<Id<"sends"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorView | null>(null);

  // Subscriptions only while the dialog is up; the detail one keeps the
  // timeline live, so a retry's new attempt appears the moment it starts.
  const sends = useAuthedQuery(api.sends.list, open ? {} : "skip");
  const detail = useAuthedQuery(
    api.sends.watch,
    open && selectedId !== null ? { sendId: selectedId } : "skip",
  );
  const retryMutation = useMutation(api.sends.retry);
  const now = useClockMinute();

  // The list row bridges the frame before the watch subscription answers, so
  // opening a detail never flashes empty.
  const send =
    detail?.send ??
    (selectedId === null
      ? null
      : (sends?.find((row) => row.id === selectedId) ?? null));
  const attempts = detail?.attempts ?? [];

  const connectionLabel =
    send === null
      ? null
      : (connections.find((c) => c.id === send.connectionId)?.label ??
        "disconnected account");

  const back = () => {
    setSelectedId(null);
    setError(null);
  };

  const close = () => {
    back();
    onClose();
  };

  const retry = async () => {
    if (send === null) return;
    setError(null);
    setBusy(true);
    try {
      await retryMutation({ sendId: send.id });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = send === null ? null : statusCopy(send);
  const meta = send === null ? null : SOURCE_META[send.channel];
  const isSlack = send?.channel === "slack";

  return (
    <Modal
      open={open}
      onClose={close}
      title={send === null ? "Outbox" : "Send detail"}
      subtitle={
        send === null
          ? "Every delivery recorded against your account — the payload sent, its status, and the attempt history behind it."
          : undefined
      }
      badge={
        send?.isSeed === true ? <StatusPill tone="idle">demo</StatusPill> : null
      }
      width="max-w-2xl"
      mobileFullScreen
      footer={
        send === null ? undefined : (
          <>
            <Button variant="ghost" onClick={back}>
              <ChevronDownIcon className="h-4 w-4 rotate-90" />
              Back to outbox
            </Button>
            {send.status === "needs_reconnect" ? (
              <Button
                variant="outline"
                onClick={() => onReconnect(send.connectionId)}
              >
                <PlugIcon className="h-4 w-4" />
                Reconnect account
              </Button>
            ) : null}
            {RETRYABLE.includes(send.status) ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void retry()}
              >
                <RerunIcon className="h-4 w-4" />
                Retry with the same key
              </Button>
            ) : null}
            {send.status === "unknown" ? (
              <Button variant="primary" onClick={() => onComposeAgain(send)}>
                <PlusIcon className="h-4 w-4" />
                Compose again with a new key
              </Button>
            ) : null}
          </>
        )
      }
    >
      {/* ---------- List ---------- */}
      {send === null ? (
        <div className="px-4 py-4 sm:px-5">
          {sends === undefined ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-neutral-500">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-400" />
              loading sends…
            </div>
          ) : sends.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong px-3.5 py-8 text-center text-[13px] text-neutral-500">
              Nothing sent yet. Reply to a search result to record your first
              delivery — or load the demo data in Settings to see every status.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {sends.map((row) => {
                const Logo = BRAND_LOGO[row.channel];
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(row.id)}
                      className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03]"
                    >
                      <Logo className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-neutral-100">
                            {row.to}
                          </span>
                          {row.isSeed ? (
                            <StatusPill tone="idle">demo</StatusPill>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-neutral-500">
                          {row.subject ?? row.body}
                        </span>
                      </span>
                      <SendStatusBadge status={row.status} />
                      <span className="w-8 shrink-0 text-right text-[11px] text-neutral-500">
                        {formatAge(row.createdAt, now)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        /* ---------- Detail ---------- */
        <div className="space-y-4 px-4 py-4 sm:px-5">
          {error !== null ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-3.5 py-3">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <div className="min-w-0">
                <p className="text-[12.5px] leading-relaxed text-rose-100/90">
                  {error.message}
                </p>
                <code className="mt-1 block font-mono text-[11px] text-rose-300/70">
                  {error.code}
                </code>
              </div>
            </div>
          ) : null}

          {copy !== null ? (
            <div
              className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 ${BANNER_TONE[copy.tone]}`}
            >
              {copy.tone === "ok" ? (
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-white">
                  {copy.title}
                  <SendStatusBadge status={send.status} />
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">
                  {copy.body}
                </p>
              </div>
            </div>
          ) : null}

          {/* The payload as it was frozen at claim time — what actually went
              (or would have gone) to the provider, not the draft's latest text. */}
          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-850">
            {[
              ["Channel", meta?.name ?? send.channel],
              [isSlack ? "Slack channel" : "Recipient", send.to],
              ["Account", connectionLabel ?? "…"],
              ...(isSlack ? [] : [["Subject", send.subject ?? ""]]),
              ["Idempotency key", send.idempotencyKey],
              ...(send.providerMessageId !== undefined
                ? [["Provider message id", send.providerMessageId]]
                : []),
              ["Attempts", `${send.attemptCount} of ${send.maxAttempts} auto`],
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

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              Exact body sent
            </span>
            <pre className="scrollbar-thin max-h-56 overflow-y-auto rounded-lg border border-line bg-ink-950 px-3.5 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-neutral-200">
              {send.body}
            </pre>
          </div>

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              Attempt timeline
            </span>
            {attempts.length === 0 ? (
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
      )}
    </Modal>
  );
}
