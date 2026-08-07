"use client";

/**
 * The screenshot harness.
 *
 * One scene per surface that has to survive a 254-character address, rendered
 * from fixed props so two captures of the same scene differ only where the code
 * changed. No Convex data and no session: `ComposeDialog` needs a Convex client
 * in context, so it gets one that is never connected and an auth hook that
 * reports "signed out" — every query it makes stays `skip`, which is the same
 * `undefined` the dialog already renders while a real one is in flight.
 */

import { useMemo, useState, useSyncExternalStore } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuth } from "convex/react";
import { ComposeDialog } from "../../(inbox)/ComposeDialog";
import { ResultsList } from "../../(inbox)/ResultsList";
import { SettingsDialog } from "../../(inbox)/SettingsDialog";
import { ConfirmDialog } from "../../(inbox)/ui";
import {
  CONNECTIONS,
  GMAIL_CONNECTION,
  LONG,
  LONG_EMAIL,
  RESULTS,
  RUNS,
} from "./stress-fixtures";

const noAuth = () => ({
  isLoading: false,
  isAuthenticated: false,
  fetchAccessToken: async () => null,
});

/** The results column, copied from `InboxApp`, so widths match the real shell. */
function Column({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-4 pt-6 pb-6 sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-3">{children}</div>
    </div>
  );
}

export function Stress({ scene }: { scene: string }) {
  const client = useMemo(
    () => new ConvexReactClient("https://harness.convex.cloud"),
    [],
  );

  /**
   * After mount only. A dialog scene is open on its first render, and `Modal`
   * goes through a portal — which does not exist on the server — so rendering
   * one during SSR is a guaranteed hydration mismatch. In the app this never
   * arises: every dialog starts closed and is opened by a click.
   */
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  if (!mounted) return null;

  return (
    <ConvexProviderWithAuth client={client} useAuth={noAuth}>
      <Scene scene={scene} />
    </ConvexProviderWithAuth>
  );
}

function Scene({ scene }: { scene: string }) {
  // Kept open: every scene here is a still of one state.
  const [, setNothing] = useState(0);
  const nudge = () => setNothing((n) => n + 1);

  if (scene === "remove-confirm") {
    return (
      <ConfirmDialog
        open
        onClose={nudge}
        onConfirm={nudge}
        title={`Remove ${LONG.address}?`}
        confirmLabel="Remove account"
      >
        <p>
          This deletes the stored grant for{" "}
          <span className="text-neutral-200">{LONG.address}</span> and takes it
          off this list. Nothing is revoked at Google, so you can connect it
          again at any time.
        </p>
        <p className="mt-2.5">
          Sends already made through it keep their history, so the outbox can
          still explain what each one went through.
        </p>
      </ConfirmDialog>
    );
  }

  /**
   * The settings panel, for the API-keys tab and its link into the docs.
   *
   * The sidebar's link is deliberately *not* a scene here: `Sidebar` renders
   * Clerk's `SignOutButton`, which throws outside a `ClerkProvider` — and this
   * harness exists precisely because it needs neither a session nor a
   * deployment. Wiring Clerk in for one still would cost the property that
   * makes every other scene capturable on a bare machine.
   */
  if (scene === "settings") {
    return (
      <SettingsDialog
        open
        onClose={nudge}
        connections={CONNECTIONS}
        onReconnect={nudge}
        onAddAccount={nudge}
        onDisconnect={nudge}
        onRemove={nudge}
      />
    );
  }

  if (scene === "compose") {
    return (
      <ComposeDialog
        result={LONG_EMAIL}
        accountLabel={GMAIL_CONNECTION.label}
        connectionStatus="active"
        onClose={nudge}
        onReconnect={nudge}
        onSending={nudge}
      />
    );
  }

  return (
    <Column>
      <ResultsList
        query={LONG.query}
        results={RESULTS}
        runs={RUNS}
        connections={CONNECTIONS}
        working={false}
        elapsed={4_120}
        onReply={nudge}
        onReconnect={nudge}
        onRetry={nudge}
      />
    </Column>
  );
}
