"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { describeError, type AppErrorView } from "./appError";
import { ResultIdentity, faviconForEmail, whereLine } from "./ResultIdentity";
import { SOURCE_META } from "./mock-data";
import type { ComposePrefill, ConnectionStatus, Draft, UiResult } from "./types";
import { Button, Modal } from "./ui";
import { AlertIcon, CheckIcon, PlugIcon, ShieldIcon } from "./icons";

type Step = "compose" | "review";

/**
 * The compose step's field shell, lifted verbatim from the search field.
 *
 * The draft is the same kind of surface as the composer that produced the result
 * it answers — same fill, same `border-line-strong` hairline, same focus
 * lightening — so a reply does not look like a form bolted onto the app that the
 * search bar belongs to.
 */
const FIELD =
  "rounded-xl border border-line-strong bg-ink-850 transition-colors duration-500 focus-within:border-neutral-600 focus:border-neutral-600";

/**
 * The confirm gate, as UI.
 *
 * Two things are load-bearing here and both are deliberate friction:
 * 1. Composing never sends. The primary action on step one is *review*.
 * 2. Review shows the exact recipient, channel and body that will go out, and
 *    the send button names that recipient — so confirming is an act about a
 *    payload you have been shown, not a blind "yes".
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
  accountLabel,
  connectionStatus,
  prefill,
  onClose,
  onReconnect,
  onSending,
}: {
  result: UiResult;
  /** The connected account this result was found by, for the header's second
   *  line — the same one the result row shows. */
  accountLabel?: string;
  /** The grant this reply would go out on. `undefined` when the account behind
   *  the result is gone, which is a disconnection like any other. */
  connectionStatus?: ConnectionStatus;
  /** Carry a known payload in (e.g. resending an indeterminate delivery) instead
   *  of the reply template. The idempotency key is still minted fresh. */
  prefill?: ComposePrefill;
  onClose: () => void;
  /** Opens the connections settings *over* this dialog, so the draft is still
   *  here when it closes again. */
  onReconnect: () => void;
  /** The key is claimed and the delivery is the server's problem now. The shell
   *  takes it from here — a toast while it runs, a dialog only if it fails. */
  onSending: (claim: { sendId: Id<"sends">; draft: Draft }) => void;
}) {
  const channel: "gmail" | "slack" = result.source === "slack" ? "slack" : "gmail";

  const [step, setStep] = useState<Step>("compose");
  const [subject, setSubject] = useState(
    () =>
      prefill?.subject ??
      (result.title.startsWith("Re: ") ? result.title : `Re: ${result.title}`),
  );
  /**
   * Empty unless a payload was carried in. A canned opener is not a favour: it
   * is a sentence you did not write, sitting in a box whose whole promise is
   * that what you see is what goes out.
   */
  const [body, setBody] = useState(() => prefill?.body ?? "");
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorView | null>(null);

  const createDraft = useMutation(api.drafts.create);
  const updateDraft = useMutation(api.drafts.update);
  const confirmDraft = useMutation(api.drafts.confirm);
  const sendDraft = useMutation(api.sends.send);

  // The digest lives here and only here. It is a subscription rather than a
  // one-shot read so that an edit invalidating a confirmation is visible
  // immediately instead of on the next click.
  const review = useAuthedQuery(
    api.drafts.reviewPayload,
    draftId === null ? "skip" : { draftId },
  );

  /**
   * Where this reply goes.
   *
   * `replyTo` is the message's sender, which is the right answer for everything
   * that arrived — and the wrong one for a message the user sent, where the sender
   * is the user's own alias and replying would mail themselves. There the thread
   * continues to the recipient.
   */
  const to =
    (result.outgoing === true ? result.recipient : result.replyTo) ?? "";
  const meta = SOURCE_META[channel];
  const isSlack = channel === "slack";

  /**
   * What a person calls that destination. Slack's `to` is a channel id — the
   * right thing to send to and the wrong thing to read — and the result's
   * context line already carries the name, so the label is taken from there and
   * the id stays untouched underneath it.
   */
  const toLabel =
    (isSlack ? result.context?.split(" · ")[0] : result.recipientName) ?? to;

  /**
   * The grant, in the only two states worth a word here.
   *
   * A healthy grant says nothing: it is what every reply assumes, so printing it
   * spends a line telling you that nothing is wrong. A dead one takes over the
   * primary button instead of sitting beside it as a pill, because there is
   * exactly one useful next action and it is not "review".
   */
  const grantBroken = connectionStatus !== "active";
  const grantLabel =
    connectionStatus === "expired" ? "Needs reconnect" : "Disconnected";

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
          // What a person calls the destination: "#finance", not "C0FINANCE".
          // The raw id is still `to`, and still what the confirm screen and the
          // provider see — this is only the label over it.
          toLabel,
          subject: outgoingSubject,
          body,
          idempotencyKey: key,
          // The row being answered, so the send is recorded as a reply to a
          // specific message rather than as a message into the void.
          replyToResultId: result.resultId as Id<"searchResults"> | undefined,
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
    result.resultId,
    result.threadId,
    to,
    toLabel,
    updateDraft,
  ]);

  /**
   * Confirm the reviewed digest, then claim the key. Two calls, in that order,
   * because the second one refuses to run without the first.
   *
   * The claim is where this dialog's job ends. Delivery finishes on the server,
   * in an action, some time after the mutation returns — so waiting for it here
   * meant a modal with a spinner in it, blocking the app to watch something it
   * was not doing. The claim is handed to the shell, which reports progress in a
   * toast and puts a dialog back up only if it fails.
   */
  const confirmSend = useCallback(async () => {
    if (draftId === null || review === undefined) return;
    setError(null);
    setBusy(true);
    try {
      await confirmDraft({ draftId, reviewedHash: review.hash });
      const claim = await sendDraft({ draftId });
      onSending({ sendId: claim.sendId, draft });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [confirmDraft, draftId, review, sendDraft, onSending, onClose, draft]);

  const title =
    step === "compose"
      ? isSlack
        ? "Reply in Slack"
        : "Reply by email"
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
        step === "review"
          ? "This is the whole payload. Check the recipient, then confirm."
          : undefined
      }
      // Step one is a reply to one message, so the header states that message —
      // face, name, channel — instead of a sentence about the dialog. The
      // no-send-without-confirm promise is not lost: the primary button says
      // "Review before sending", which is the same promise as an action.
      heading={
        step === "compose" ? (
          <div className="flex items-start gap-3">
            <ResultIdentity
              source={result.source}
              avatarUrl={result.avatarUrl}
              favicon={isSlack ? undefined : faviconForEmail(to)}
              seed={to}
              label={
                result.outgoing === true
                  ? (result.recipientName ?? to)
                  : (result.author ?? meta.name)
              }
              where={whereLine(result, accountLabel)}
            />
          </div>
        ) : undefined
      }
      width="max-w-2xl"
      footer={
        step === "compose" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Discard
            </Button>
            {grantBroken ? (
              <>
                <span className="text-[12.5px] text-amber-300/90">
                  {grantLabel}
                </span>
                <Button
                  variant="primary"
                  onClick={onReconnect}
                >
                  <PlugIcon className="h-4 w-4" />
                  {connectionStatus === undefined
                    ? `Connect ${meta.name}`
                    : `Reconnect ${meta.name}`}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={body.trim().length === 0 || busy}
                onClick={() => void openReview()}
              >
                <ShieldIcon className="h-4 w-4" />
                Review before sending
              </Button>
            )}
          </>
        ) : step === "review" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("compose")}>
              Back to draft
            </Button>
            {/* The button names the recipient — that is the confirm gate's
                whole promise — but a recipient may be 254 characters, and
                interpolating one turned the primary action into a four-line
                block of address. The verb and the ellipsised name stay on one
                line; the payload table directly above shows the address in
                full, which is where "check the recipient" is actually done. */}
            <Button
              variant="primary"
              disabled={!reviewMatches || busy}
              onClick={() => void confirmSend()}
              title={isSlack ? `Post to ${shownTo}` : `Send to ${shownTo}`}
              className="min-w-0 max-w-full"
            >
              <CheckIcon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 truncate">
                {isSlack ? `Post to ${shownTo}` : `Send to ${shownTo}`}
              </span>
            </Button>
          </>
        ) : null
      }
    >
      {/* ---------- Step 1: compose ---------- */}
      {step === "compose" ? (
        <div className="space-y-4 px-5 py-4">
          {banner}
          {/* No "Slack · in reply to #channel" line here any more: the header
              above is that fact, stated once. */}

          {/* The message being answered, shown rather than pasted into the
              draft. Quoting it into the textarea made their words part of the
              payload — editable, and about to be sent back to them — when all
              they were ever doing was reminding you what this is a reply to. */}
          <div className="rounded-lg border border-line bg-ink-850/60 px-3.5 py-3">
            <p className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              {result.author ?? meta.name} wrote · {result.age} ago
            </p>
            <p className="mt-2 max-h-28 overflow-y-auto border-l-2 border-line-strong pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-neutral-400 scrollbar-thin">
              {result.snippet}
            </p>
          </div>

          {/* Slack's channel is already the header's second line, and its id is
              not something anyone reads — so only mail, whose recipient address
              appears nowhere else on this step, gets a "To" row. The grant's
              health is not stated here at all: a working grant is the assumed
              case, and a broken one is said once, next to the button it blocks. */}
          {!isSlack ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                To
              </span>
              <div className={`flex items-center gap-2 ${FIELD} px-3 py-2.5`}>
                <span className="font-mono text-[13px] text-neutral-200">{to}</span>
              </div>
            </label>
          ) : null}

          {!isSlack ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                Subject
              </span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={`w-full ${FIELD} px-3 py-2.5 text-[13px] text-neutral-100 outline-none`}
              />
            </label>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
              Your reply
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply…"
              rows={8}
              className={`scrollbar-thin w-full resize-none ${FIELD} px-3 py-2.5 text-[13px] leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-600`}
            />
          </label>
        </div>
      ) : null}

      {/* ---------- Step 2: review ---------- */}
      {step === "review" ? (
        <div className="space-y-4 px-5 py-4">
          {banner}
          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-850">
            {[
              ["Source", meta.name],
              [isSlack ? "Channel" : "Recipient", shownTo],
              ["Account", review?.accountLabel ?? "…"],
              ...(isSlack ? [] : [["Subject", shownSubject ?? ""]]),
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
        </div>
      ) : null}

    </Modal>
  );
}
