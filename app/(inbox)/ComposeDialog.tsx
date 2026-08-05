"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { describeError, type AppErrorView } from "./appError";
import { SOURCE_META } from "./mock-data";
import type { ComposePrefill, Draft, UiResult } from "./types";
import { Button, Modal, StatusPill } from "./ui";
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  ReplyIcon,
  ShieldIcon,
} from "./icons";

type Step = "compose" | "review" | "sending" | "sent";

/** One line in the call log: a real delivery attempt, or a de-duplicated call. */
interface LogRow {
  n: number;
  trigger: string;
  outcome: string;
  providerCalls: number;
}

function quoted(result: UiResult) {
  const who = result.author ?? "them";
  return `\n\n---\n${result.age} ago, ${who} wrote:\n> ${result.snippet}`;
}

/** Copy for a settled send that did not succeed. Each status gets the sentence
 *  that says what actually happens next, because they genuinely differ. */
function failureCopy(status: string, message: string | undefined) {
  const detail = message ?? "The provider gave no further detail.";
  switch (status) {
    case "failed_transient":
      return {
        title: "Not delivered — transient failure",
        body: `The provider failed in a way that may clear on its own, and the automatic retries are spent. Nothing was delivered, and the idempotency key is still yours to retry. ${detail}`,
      };
    case "failed_permanent":
      return {
        title: "Not delivered — permanent failure",
        body: `The provider rejected this message outright, so retrying it unchanged would fail the same way. ${detail}`,
      };
    case "needs_reconnect":
      return {
        title: "Not delivered — the grant needs reconnecting",
        body: `The account's authorisation is no longer valid. Reconnect it, then retry: the draft stays confirmed, so the retry reuses this same key and still cannot send twice. ${detail}`,
      };
    default:
      return {
        title: "Outcome unknown — not retried automatically",
        body: `The message was handed to the provider but never acknowledged, so whether it arrived is genuinely unknown. Retrying under this key could deliver a second copy, so it will not happen automatically. ${detail}`,
      };
  }
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
 * producing a second one.
 *
 * Every step is a real round trip now, and the shape of them is the point:
 * `drafts.create` writes a row, `drafts.reviewPayload` is the *only* source of
 * the digest below, `drafts.confirm` takes that digest back, and `sends.send`
 * names nothing but the draft. What is rendered on the review step is the
 * server's copy of the payload, not the local form state, so "confirm what you
 * saw" means the thing that was seen came from the same place the send will
 * read.
 */
/**
 * The caller mounts this keyed on the result, so every field can be seeded from
 * a `useState` initialiser rather than reset by an effect.
 */
export function ComposeDialog({
  result,
  prefill,
  onClose,
  onSent,
}: {
  result: UiResult;
  /** Carry a known payload in (e.g. resending an indeterminate delivery) instead
   *  of the reply template. The idempotency key is still minted fresh. */
  prefill?: ComposePrefill;
  onClose: () => void;
  onSent: (draft: Draft) => void;
}) {
  const channel: "gmail" | "slack" = result.source === "slack" ? "slack" : "gmail";

  const [step, setStep] = useState<Step>("compose");
  const [acknowledged, setAcknowledged] = useState(false);
  const [subject, setSubject] = useState(
    () =>
      prefill?.subject ??
      (result.title.startsWith("Re: ") ? result.title : `Re: ${result.title}`),
  );
  const [body, setBody] = useState(() =>
    prefill !== undefined
      ? prefill.body
      : channel === "slack"
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

  const [draftId, setDraftId] = useState<Id<"drafts"> | null>(null);
  const [sendId, setSendId] = useState<Id<"sends"> | null>(null);
  /** `true` when the last call to `sends.send` did not claim the key — i.e. the
   *  delivery it returned was one that already existed. */
  const [deduped, setDeduped] = useState(false);
  /** Calls to the send endpoint, including the ones that delivered nothing. */
  const [sendCalls, setSendCalls] = useState(0);
  /** Calls that were answered from the existing claim. Shown in the log, because
   *  "this call sent nothing" is the observation the whole demo is about. */
  const [dedupedCalls, setDedupedCalls] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorView | null>(null);

  const createDraft = useMutation(api.drafts.create);
  const updateDraft = useMutation(api.drafts.update);
  const confirmDraft = useMutation(api.drafts.confirm);
  const sendDraft = useMutation(api.sends.send);
  const retrySend = useMutation(api.sends.retry);

  // The digest lives here and only here. It is a subscription rather than a
  // one-shot read so that an edit invalidating a confirmation is visible
  // immediately instead of on the next click.
  const review = useQuery(
    api.drafts.reviewPayload,
    draftId === null ? "skip" : { draftId },
  );
  const watched = useQuery(api.sends.watch, sendId === null ? "skip" : { sendId });

  const to = result.replyTo ?? "";
  const meta = SOURCE_META[channel];
  const isSlack = channel === "slack";

  const outgoingSubject = isSlack ? undefined : subject.trim();

  const draft: Draft = useMemo(
    () => ({
      id: draftId ?? "draft_pending",
      channel,
      to,
      toLabel: to,
      subject: outgoingSubject,
      body,
      idempotency_key: key,
    }),
    [draftId, channel, to, outgoingSubject, body, key],
  );

  /**
   * Does the reviewed payload still describe what is in the form?
   *
   * The server's copy is authoritative, and for the instant between an edit
   * landing and the subscription catching up the two disagree. Confirming then
   * would present a digest for the previous revision and be refused — correctly,
   * but confusingly — so the button waits instead.
   */
  const reviewMatches =
    review !== undefined &&
    review.to === to.trim() &&
    review.body === body.trim() &&
    (review.subject ?? "") === (outgoingSubject ?? "");

  const send = watched?.send ?? null;
  const status = send?.status;
  const settled =
    status !== undefined && status !== "queued" && status !== "in_flight";
  const succeeded = status === "succeeded";

  /** Real attempts first, then the calls that produced no attempt at all. */
  const log: LogRow[] = useMemo(() => {
    const attempts = watched?.attempts ?? [];
    const rows: LogRow[] = attempts.map((attempt) => ({
      n: attempt.attemptNumber,
      trigger: attempt.trigger,
      outcome: attempt.outcome ?? "in flight",
      providerCalls: 1,
    }));
    for (let i = 0; i < dedupedCalls; i += 1) {
      rows.push({
        n: rows.length + 1,
        trigger: "manual",
        outcome: "deduped",
        providerCalls: 0,
      });
    }
    return rows;
  }, [watched, dedupedCalls]);

  /**
   * The step actually rendered.
   *
   * Only the first three are user-driven; "sent" is *derived* from the send
   * settling, because delivery finishes on the server — in an action, some time
   * after the mutation that queued it returned. Deriving it rather than storing
   * it means the screen follows the row: a manual retry shows the spinner again
   * while the new attempt is in flight and returns to the receipt when it lands,
   * with no state to keep in sync.
   */
  const displayStep: Step = step === "sending" && settled ? "sent" : step;

  // The toast belongs to the delivery, not to the click, and fires once.
  const announced = useRef(false);
  useEffect(() => {
    if (succeeded && !announced.current) {
      announced.current = true;
      onSent(draft);
    }
  }, [succeeded, onSent, draft]);

  /**
   * Step one to step two: write the draft (or update the one already written).
   *
   * Re-entering review after an edit goes through `drafts.update`, which bumps
   * the revision and clears any confirmation — so the digest shown on the next
   * screen belongs to this version of the text and no other.
   */
  const openReview = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (draftId === null) {
        if (result.connectionId === undefined) {
          setError({
            code: "CONNECTION_UNAVAILABLE",
            message:
              "This result did not come from a connected account, so there is nothing to reply through.",
          });
          return;
        }
        const created = await createDraft({
          channel,
          connectionId: result.connectionId as Id<"connections">,
          to,
          toLabel: to,
          subject: outgoingSubject,
          body,
          idempotencyKey: key,
          replyToExternalId: result.externalId,
          threadId: result.threadId,
        });
        setDraftId(created.draft.id);
      } else {
        await updateDraft({ draftId, to, subject: outgoingSubject, body });
      }
      setStep("review");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [
    body,
    channel,
    createDraft,
    draftId,
    key,
    outgoingSubject,
    result.connectionId,
    result.externalId,
    result.threadId,
    to,
    updateDraft,
  ]);

  /** Confirm the reviewed digest, then claim the key. Two calls, in that order,
   *  because the second one refuses to run without the first. */
  const confirmSend = useCallback(async () => {
    if (draftId === null || review === undefined) return;
    setError(null);
    setBusy(true);
    setStep("sending");
    try {
      await confirmDraft({ draftId, reviewedHash: review.hash });
      const claim = await sendDraft({ draftId });
      setSendId(claim.sendId);
      setDeduped(!claim.claimed);
      setSendCalls((calls) => calls + 1);
      if (!claim.claimed) setDedupedCalls((calls) => calls + 1);
    } catch (err) {
      setError(describeError(err));
      setStep("review");
    } finally {
      setBusy(false);
    }
  }, [confirmDraft, draftId, review, sendDraft]);

  /**
   * "Retry with the same key", meaning it literally.
   *
   * A delivered send goes back through `sends.send`: the key is already claimed,
   * so the stored delivery comes back and no provider call happens — which is the
   * property worth being able to press a button on. A failed one goes through
   * `sends.retry`, which starts a new attempt against the *same* claim. An
   * indeterminate one is refused by the server, and that refusal is shown.
   */
  const retry = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (succeeded && draftId !== null) {
        const claim = await sendDraft({ draftId });
        setDeduped(!claim.claimed);
        setSendCalls((calls) => calls + 1);
        if (!claim.claimed) setDedupedCalls((calls) => calls + 1);
        return;
      }
      if (sendId !== null) {
        await retrySend({ sendId });
        setSendCalls((calls) => calls + 1);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [draftId, retrySend, sendDraft, sendId, succeeded]);

  const title =
    displayStep === "compose"
      ? isSlack
        ? "Reply in Slack"
        : "Reply by email"
      : displayStep === "sent"
        ? "Send recorded"
        : "Confirm before sending";

  /** The payload as the server holds it, once it does. */
  const shownTo = review?.to ?? to;
  const shownSubject = review?.subject ?? subject;
  const shownBody = review?.body ?? body;

  const banner =
    error === null ? null : (
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
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      subtitle={
        displayStep === "compose"
          ? "Composing produces a draft. Nothing leaves until you confirm the exact payload on the next step."
          : displayStep === "review"
            ? "This is the whole payload. Check the recipient, then confirm."
            : undefined
      }
      width="max-w-2xl"
      footer={
        displayStep === "compose" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Discard
            </Button>
            <Button
              variant="primary"
              disabled={body.trim().length === 0 || busy}
              onClick={() => void openReview()}
            >
              <ShieldIcon className="h-4 w-4" />
              Review before sending
            </Button>
          </>
        ) : displayStep === "review" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("compose")}>
              Back to draft
            </Button>
            <Button
              variant="primary"
              disabled={!acknowledged || !reviewMatches || busy}
              onClick={() => void confirmSend()}
            >
              <CheckIcon className="h-4 w-4" />
              {isSlack ? `Post to ${shownTo}` : `Send to ${shownTo}`}
            </Button>
          </>
        ) : displayStep === "sent" ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void retry()}>
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
      {displayStep === "compose" ? (
        <div className="space-y-4 px-5 py-4">
          {banner}
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
              <span className="font-mono text-[13px] text-neutral-200">{to}</span>
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
      {displayStep === "review" ? (
        <div className="space-y-4 px-5 py-4">
          {banner}
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
              [isSlack ? "Channel" : "Recipient", shownTo],
              ["Account", review?.accountLabel ?? "…"],
              ...(isSlack ? [] : [["Subject", shownSubject ?? ""]]),
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
              {shownBody}
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
              <span className="font-mono text-white">{shownTo}</span> — and the
              body above.
            </span>
          </label>
        </div>
      ) : null}

      {/* ---------- Step 3: in flight ---------- */}
      {displayStep === "sending" ? (
        <div className="flex flex-col items-center gap-3 px-5 py-16">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-400" />
          <p className="text-[13px] text-neutral-400">
            Claiming the idempotency key, then handing off to the {meta.name}{" "}
            adapter…
          </p>
        </div>
      ) : null}

      {/* ---------- Step 4: delivered (and dedupe proof) ---------- */}
      {displayStep === "sent" && send !== null ? (
        <div className="space-y-4 px-5 py-4">
          {banner}
          {succeeded ? (
            <div
              className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 ${
                deduped
                  ? "border-indigo-500/30 bg-indigo-500/[0.07]"
                  : "border-emerald-500/30 bg-emerald-500/[0.07]"
              }`}
            >
              {deduped ? (
                <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" />
              ) : (
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              )}
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-white">
                  {deduped
                    ? "Retry deduplicated — nothing sent twice"
                    : `Delivered once to ${send.to}`}
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">
                  {deduped
                    ? "The second call carried the same idempotency key, so the stored delivery was returned instead of a new message being sent. Exactly one message exists."
                    : "One delivery recorded against this idempotency key. Any retry carrying the same key returns this same result."}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-3.5 py-3">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-white">
                  {failureCopy(send.status, send.lastErrorMessage).title}
                </p>
                <p className="mt-1 text-[12px] leading-relaxed break-words text-neutral-400">
                  {failureCopy(send.status, send.lastErrorMessage).body}
                </p>
              </div>
            </div>
          )}

          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-850">
            {[
              [
                "Status",
                succeeded && deduped ? "succeeded (returned)" : send.status,
              ],
              ["Provider message id", send.providerMessageId ?? "—"],
              ["Idempotency key", send.idempotencyKey],
              ["Deliveries", succeeded ? "1" : "0"],
              ["Calls to /send", String(sendCalls)],
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
              {log.map((row) => (
                <li
                  key={`${row.n}-${row.outcome}`}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-ink-850/60 px-3 py-2 text-[12px]"
                >
                  <span className="font-mono text-neutral-500">#{row.n}</span>
                  <span className="text-neutral-400">{row.trigger}</span>
                  <StatusPill
                    tone={
                      row.outcome === "succeeded"
                        ? "ok"
                        : row.outcome === "failed" || row.outcome === "unknown"
                          ? "bad"
                          : "info"
                    }
                  >
                    {row.outcome}
                  </StatusPill>
                  <span className="ml-auto font-mono text-[11px] text-neutral-600">
                    {row.providerCalls === 0
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
