"use client";

import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import type { OutboxSend } from "./OutboxPage";

/**
 * Follows one claimed send to its outcome, and renders nothing.
 *
 * A send finishes on the server — in an action, after the mutation that queued
 * it has already returned — so something has to keep watching once the compose
 * dialog is gone. That is this: a subscription with no UI, mounted by the shell
 * for as long as a delivery is in flight and unmounted (and so unsubscribed)
 * the moment it settles.
 *
 * `queued` and `in_flight` are not outcomes, so they are ignored rather than
 * reported: the pending toast the shell already put up is the right answer to
 * "what is happening" until there is something better to say.
 */
export function SendWatcher({
  sendId,
  onSettled,
}: {
  sendId: Id<"sends">;
  /** Fires exactly once, with the send in its settled state. */
  onSettled: (send: OutboxSend) => void;
}) {
  const watched = useAuthedQuery(api.sends.watch, { sendId });
  const reported = useRef(false);

  useEffect(() => {
    if (watched === undefined || watched === null || reported.current) return;
    const { status } = watched.send;
    if (status === "queued" || status === "in_flight") return;

    reported.current = true;
    onSettled(watched.send);
  }, [watched, onSettled]);

  return null;
}
