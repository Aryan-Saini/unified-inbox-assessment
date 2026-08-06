"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { describeError, type AppErrorView } from "./appError";
import type { OutboxSend } from "./OutboxPage";
import { Button, Modal, StatusPill } from "./ui";
import { AlertIcon, ClockIcon, PlugIcon, PlusIcon } from "./icons";

/** Copy for a settled send that did not succeed. Each status gets the sentence
 *  that says what actually happens next, because they genuinely differ. */
function failureCopy(status: string, message: string | undefined) {
  const detail = message ?? "The provider gave no further detail.";
  switch (status) {
    case "failed_transient":
      return {
        title: "Not delivered: transient failure",
        body: `The provider failed in a way that may clear on its own, and the automatic retries are spent. Nothing was delivered, and the idempotency key is still yours to retry. ${detail}`,
      };
    case "failed_permanent":
      return {
        title: "Not delivered: permanent failure",
        body: `The provider rejected this message outright, so retrying it unchanged would fail the same way. ${detail}`,
      };
    case "needs_reconnect":
      return {
        title: "Not delivered: the grant needs reconnecting",
        body: `The account's authorisation is no longer valid. Reconnect it, then retry: the draft stays confirmed, so the retry reuses this same key and still cannot send twice. ${detail}`,
      };
    default:
      return {
        title: "Outcome unknown, so it is not retried automatically",
        body: `The message was handed to the provider but never acknowledged, so whether it arrived is genuinely unknown. Retrying under this key could deliver a second copy, so it will not happen automatically. ${detail}`,
      };
  }
}

/**
 * A send that did not go out, and the decision it needs.
 *
 * Only failure gets a dialog. A working send is a toast, because there is
 * nothing to decide and nothing to read; this one interrupts precisely because
 * something is now waiting on a person — retry it, fix the grant behind it, or
 * accept an indeterminate outcome and compose again under a fresh key.
 *
 * It watches the row rather than being told about it, so a retry started from
 * here updates the same dialog: the attempt appears, and if it lands the caller
 * is told and this closes.
 */
export function SendFailureDialog({
  sendId,
  onClose,
  onDelivered,
  onReconnect,
  onComposeAgain,
}: {
  sendId: Id<"sends">;
  onClose: () => void;
  /** The retry worked after all. The caller announces it and closes this. */
  onDelivered: (send: OutboxSend) => void;
  /** Starts the OAuth re-grant for a connection id. Navigates away. */
  onReconnect: (connectionId: string) => void;
  /** The only way forward from an indeterminate delivery: the same payload
   *  under a new key. */
  onComposeAgain: (send: OutboxSend) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorView | null>(null);
  const retryMutation = useMutation(api.sends.retry);

  const watched = useAuthedQuery(api.sends.watch, { sendId });
  const send = watched?.send ?? null;
  const attempts = watched?.attempts ?? [];

  // A retry that lands is not this dialog's news to report — it is the same
  // "delivered" the caller announces for any other send, so it is handed back
  // up and this closes. Once, however many times the subscription re-renders.
  const announced = useRef(false);
  useEffect(() => {
    if (send !== null && send.status === "succeeded" && !announced.current) {
      announced.current = true;
      onDelivered(send);
    }
  }, [send, onDelivered]);

  const inFlight =
    send !== null && (send.status === "queued" || send.status === "in_flight");

  const retry = async () => {
    setError(null);
    setBusy(true);
    try {
      await retryMutation({ sendId });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const copy =
    send === null ? null : failureCopy(send.status, send.lastErrorMessage);

  return (
    <Modal
      open
      onClose={onClose}
      title="Not delivered"
      width="max-w-2xl"
      footer={
        send === null ? undefined : (
          <>
            {send.status === "needs_reconnect" ? (
              <Button variant="outline" onClick={() => onReconnect(send.connectionId)}>
                <PlugIcon className="h-4 w-4" />
                Reconnect account
              </Button>
            ) : null}
            {send.status === "unknown" ? (
              <Button variant="outline" onClick={() => onComposeAgain(send)}>
                <PlusIcon className="h-4 w-4" />
                Compose again with a new key
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy || inFlight}
                onClick={() => void retry()}
              >
                <ClockIcon className="h-4 w-4" />
                Retry with the same key
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {send === null ? (
        <div className="flex items-center justify-center gap-2 px-5 py-12 text-[12px] text-neutral-500">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-400" />
          loading the delivery…
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
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

          <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-3.5 py-3">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-white">{copy?.title}</p>
              <p className="mt-1 text-[12px] leading-relaxed break-words text-neutral-400">
                {copy?.body}
              </p>
            </div>
          </div>

          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-ink-850">
            {[
              ["Status", inFlight ? `${send.status} (retrying)` : send.status],
              ["Recipient", send.to],
              ["Idempotency key", send.idempotencyKey],
              ["Deliveries", "0"],
              ["Attempts", `${send.attemptCount} of ${send.maxAttempts} auto`],
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
              {attempts.map((attempt) => (
                <li
                  key={attempt.id}
                  className="rounded-lg border border-line bg-ink-850/60 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2.5 text-[12px]">
                    <span className="font-mono text-neutral-500">
                      #{attempt.attemptNumber}
                    </span>
                    <span className="text-neutral-400">{attempt.trigger}</span>
                    <StatusPill
                      tone={attempt.outcome === undefined ? "info" : "bad"}
                    >
                      {attempt.outcome ?? "in flight"}
                    </StatusPill>
                    {attempt.httpStatus !== undefined ? (
                      <span className="font-mono text-[11px] text-neutral-600">
                        HTTP {attempt.httpStatus}
                      </span>
                    ) : null}
                  </div>
                  {attempt.errorMessage !== undefined ? (
                    <p className="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-neutral-400">
                      {attempt.errorMessage}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
