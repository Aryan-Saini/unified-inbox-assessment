"use client";

import { useMemo, useState } from "react";
import { SOURCE_META } from "./mock-data";
import type { Draft, UiResult } from "./types";
import { Button, Modal, StatusPill } from "./ui";
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  ReplyIcon,
  ShieldIcon,
} from "./icons";

type Step = "compose" | "review" | "sending" | "sent";

/** Deliveries observed for this draft, keyed by idempotency key. */
interface Delivery {
  providerMessageId: string;
  attempts: { n: number; trigger: string; outcome: string }[];
  deduped: boolean;
}

function quoted(result: UiResult) {
  const who = result.author ?? "them";
  return `\n\n---\n${result.age} ago, ${who} wrote:\n> ${result.snippet}`;
}

/**
 * The confirm gate, as UI.
 *
 * Two things are load-bearing here and both are deliberate friction:
 * 1. Composing never sends. The primary action on step one is *review*.
 * 2. Review shows the exact recipient, channel and body that will go out, and
 *    the send button is disabled until the recipient has been acknowledged.
 *
 * The idempotency key is minted with the draft and shown at every step, so
 * "retry" visibly reuses it. Retrying returns the first delivery instead of
 * producing a second one — mocked here, but the surface is the real one.
 */
/**
 * The caller mounts this keyed on the result, so every field can be seeded from
 * a `useState` initialiser rather than reset by an effect.
 */
export function ComposeDialog({
  result,
  onClose,
  onSent,
}: {
  result: UiResult;
  onClose: () => void;
  onSent: (draft: Draft) => void;
}) {
  const channel: "gmail" | "slack" = result.source === "slack" ? "slack" : "gmail";

  const [step, setStep] = useState<Step>("compose");
  const [acknowledged, setAcknowledged] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [subject, setSubject] = useState(() =>
    result.title.startsWith("Re: ") ? result.title : `Re: ${result.title}`,
  );
  const [body, setBody] = useState(() =>
    channel === "slack"
      ? `Thanks for the ping — picking this up now.${quoted(result)}`
      : `Hi,\n\nThanks for the note — confirming I've seen this and will follow up today.\n\nAda${quoted(result)}`,
  );
  /**
   * Minted once with the draft and never regenerated. That is the whole point:
   * the same key is what a retry carries, and what makes the retry a no-op.
   */
  const [key] = useState(
    () =>
      `idem_${(globalThis.crypto?.randomUUID?.() ?? `${performance.now()}`)
        .replace(/-/g, "")
        .slice(0, 20)}`,
  );

  const draft: Draft = useMemo(
    () => ({
      id: "draft_01",
      channel,
      to: result.replyTo ?? "",
      toLabel: result.replyTo ?? "",
      subject: channel === "gmail" ? subject : undefined,
      body,
      idempotency_key: key,
    }),
    [result, channel, subject, body, key],
  );

  const meta = SOURCE_META[channel];
  const isSlack = channel === "slack";

  // Arrow consts, not hoisted `function` declarations: a hoisted function
  // cannot see the `draft`/`result` narrowing from the guard above.
  /** First send: one delivery. */
  const confirmSend = () => {
    setStep("sending");
    setTimeout(() => {
      setDelivery({
        providerMessageId:
          isSlack ? "1753862401.004200" : "18f2c9a41b7e0d33",
        attempts: [{ n: 1, trigger: "initial", outcome: "succeeded" }],
        deduped: false,
      });
      setStep("sent");
      onSent(draft);
    }, 1100);
  };

  /** Retry with the same key: returns the first result, sends nothing. */
  const retrySameKey = () => {
    setStep("sending");
    setTimeout(() => {
      setDelivery((prev) =>
        prev
          ? {
              ...prev,
              deduped: true,
              attempts: [
                ...prev.attempts,
                { n: prev.attempts.length + 1, trigger: "manual", outcome: "deduped" },
              ],
            }
          : prev,
      );
      setStep("sent");
    }, 700);
  };

  const title =
    step === "compose"
      ? isSlack
        ? "Reply in Slack"
        : "Reply by email"
      : step === "sent"
        ? "Send recorded"
        : "Confirm before sending";

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      subtitle={
        step === "compose"
          ? "Composing produces a draft. Nothing leaves until you confirm the exact payload on the next step."
          : step === "review"
            ? "This is the whole payload. Check the recipient, then confirm."
            : undefined
      }
      width="max-w-2xl"
      footer={
        step === "compose" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Discard
            </Button>
            <Button
              variant="primary"
              disabled={body.trim().length === 0}
              onClick={() => setStep("review")}
            >
              <ShieldIcon className="h-4 w-4" />
              Review before sending
            </Button>
          </>
        ) : step === "review" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("compose")}>
              Back to draft
            </Button>
            <Button
              variant="primary"
              disabled={!acknowledged}
              onClick={confirmSend}
            >
              <CheckIcon className="h-4 w-4" />
              {isSlack ? `Post to ${draft.to}` : `Send to ${draft.to}`}
            </Button>
          </>
        ) : step === "sent" ? (
          <>
            <Button variant="outline" onClick={retrySameKey}>
              <ClockIcon className="h-4 w-4" />
              Retry with the same key
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : null
      }
    >
      {/* ---------- Step 1: compose ---------- */}
      {step === "compose" ? (
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium ${meta.tint}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
              {meta.name}
            </span>
            <span className="text-neutral-500">
              in reply to{" "}
              <span className="text-neutral-300">{result.context ?? result.title}</span>
            </span>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              {isSlack ? "Channel" : "To"}
            </span>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-ink-850 px-3 py-2.5">
              <span className="font-mono text-[13px] text-neutral-200">
                {draft.to}
              </span>
              <StatusPill tone="ok">grant active</StatusPill>
            </div>
          </label>

          {!isSlack ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                Subject
              </span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg border border-line bg-ink-850 px-3 py-2.5 text-[13px] text-neutral-100 outline-none transition-colors focus:border-indigo-500/60"
              />
            </label>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              Message
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              className="scrollbar-thin w-full resize-none rounded-lg border border-line bg-ink-850 px-3 py-2.5 text-[13px] leading-relaxed text-neutral-100 outline-none transition-colors focus:border-indigo-500/60"
            />
          </label>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink-850/60 px-3 py-2">
            <span className="text-[11px] text-neutral-500">Idempotency key</span>
            <code className="truncate font-mono text-[11px] text-neutral-400">
              {key}
            </code>
          </div>
        </div>
      ) : null}

      {/* ---------- Step 2: review ---------- */}
      {step === "review" ? (
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-3">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-[12.5px] leading-relaxed text-amber-100/90">
              This leaves your workspace and reaches a real person on{" "}
              <span className="font-semibold">{meta.name}</span>. It cannot be
              recalled after sending.
            </p>
          </div>

          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-850">
            {[
              ["Source", meta.name],
              [isSlack ? "Channel" : "Recipient", draft.to],
              ["Account", isSlack ? "Northwind HQ" : "ada@northwind.test"],
              ...(isSlack ? [] : [["Subject", subject]]),
              ["Idempotency key", key],
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
              Exact body to be sent
            </span>
            <pre className="scrollbar-thin max-h-56 overflow-y-auto rounded-lg border border-line bg-ink-950 px-3.5 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-neutral-200">
              {body}
            </pre>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-ink-850/60 px-3.5 py-3">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
            />
            <span className="text-[12.5px] leading-relaxed text-neutral-300">
              I have checked the {isSlack ? "channel" : "recipient"} —{" "}
              <span className="font-mono text-white">{draft.to}</span> — and the
              body above.
            </span>
          </label>
        </div>
      ) : null}

      {/* ---------- Step 3: in flight ---------- */}
      {step === "sending" ? (
        <div className="flex flex-col items-center gap-3 px-5 py-16">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-400" />
          <p className="text-[13px] text-neutral-400">
            Claiming the idempotency key, then handing off to the {meta.name}{" "}
            adapter…
          </p>
        </div>
      ) : null}

      {/* ---------- Step 4: delivered (and dedupe proof) ---------- */}
      {step === "sent" && delivery ? (
        <div className="space-y-4 px-5 py-4">
          <div
            className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 ${
              delivery.deduped
                ? "border-indigo-500/30 bg-indigo-500/[0.07]"
                : "border-emerald-500/30 bg-emerald-500/[0.07]"
            }`}
          >
            {delivery.deduped ? (
              <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" />
            ) : (
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            )}
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-white">
                {delivery.deduped
                  ? "Retry deduplicated — nothing sent twice"
                  : `Delivered once to ${draft.to}`}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">
                {delivery.deduped
                  ? "The second call carried the same idempotency key, so the stored delivery was returned instead of a new message being sent. Exactly one message exists."
                  : "One delivery recorded against this idempotency key. Any retry carrying the same key returns this same result."}
              </p>
            </div>
          </div>

          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-850">
            {[
              ["Status", delivery.deduped ? "succeeded (returned)" : "succeeded"],
              ["Provider message id", delivery.providerMessageId],
              ["Idempotency key", key],
              ["Deliveries", "1"],
              ["Calls to /send", String(delivery.attempts.length)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-start gap-3 px-3.5 py-2.5 text-[12.5px]"
              >
                <dt className="w-36 shrink-0 text-neutral-500">{label}</dt>
                <dd className="min-w-0 flex-1 font-mono break-words text-neutral-100">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              Attempt log
            </span>
            <ul className="space-y-1.5">
              {delivery.attempts.map((a) => (
                <li
                  key={a.n}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-ink-850/60 px-3 py-2 text-[12px]"
                >
                  <span className="font-mono text-neutral-500">#{a.n}</span>
                  <span className="text-neutral-400">{a.trigger}</span>
                  <StatusPill tone={a.outcome === "succeeded" ? "ok" : "info"}>
                    {a.outcome}
                  </StatusPill>
                  <span className="ml-auto font-mono text-[11px] text-neutral-600">
                    {a.outcome === "deduped"
                      ? "0 provider calls"
                      : "1 provider call"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-neutral-500">
            <ReplyIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Press “Retry with the same key” as many times as you like — the
            delivery count stays at one.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
