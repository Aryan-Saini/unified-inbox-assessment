"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { BRAND_LOGO } from "./brand-icons";
import { AccountName, ScopeSummary } from "./ConnectorSwitchboard";
import { accountTitle, formatAge } from "./format";
import type { Connection, ConnectionStatus } from "./types";
import { Button, ConfirmDialog, Modal, StatusPill } from "./ui";
import { KeyIcon, PlugIcon, SlidersIcon, TrashIcon } from "./icons";

/** Section heading, matching the "ACCOUNTS" label in the connectors panel. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11.5px] font-semibold tracking-wide text-neutral-500 uppercase">
      {children}
    </h3>
  );
}

type Tab = "connections" | "api" | "demo";

const TABS: { id: Tab; label: string; icon: (p: { className?: string }) => React.ReactNode }[] = [
  { id: "connections", label: "Connections", icon: PlugIcon },
  { id: "api", label: "API keys", icon: KeyIcon },
  { id: "demo", label: "Demo data", icon: SlidersIcon },
];

const TONE: Record<ConnectionStatus, "ok" | "warn" | "bad"> = {
  active: "ok",
  expired: "warn",
  revoked: "warn",
  errored: "bad",
};

function ConnectionRow({
  connection,
  reconnecting,
  onReconnect,
  onDisconnect,
  onRemove,
}: {
  connection: Connection;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const Logo = BRAND_LOGO[connection.provider];
  const healthy = connection.status === "active";

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Logo className="mt-0.5 h-4 w-4 shrink-0" />

      <div className="min-w-0 flex-1">
        {/* No wrapping. The name is the only thing on this row that can be
            arbitrarily long, so it is the only thing that gives way — a wrapped
            row put the status pill on a line of its own and made every long
            account two rows tall. */}
        <div className="flex min-w-0 items-center gap-2">
          <AccountName account={connection} />
          <StatusPill tone={TONE[connection.status]}>
            {connection.status}
          </StatusPill>
        </div>
        {/* The grant's actual scopes. "Scoped narrowly rather than blanket
            access" is only a claim until it is shown, and this is also how a
            grant predating a scope change is spotted: it is missing one. */}
        <ScopeSummary scopes={connection.scopes} />
      </div>

      {/* One action, matched to the state the row is actually in.
          Live: give up the grant. Not live: get it back.

          Remove appears only once the grant is gone. Offering it beside
          Disconnect made the destructive option permanently available next to
          the reversible one, and the two are a sequence, not a choice: give the
          grant up first, then decide whether the account should stay listed. */}
      {healthy ? (
        <Button
          variant="ghost"
          onClick={onDisconnect}
          className="!px-2.5 !py-1.5 !text-[12px]"
        >
          Disconnect
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            onClick={onReconnect}
            disabled={reconnecting}
            className="!px-2.5 !py-1.5 !text-[12px]"
          >
            {reconnecting ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200" />
                Reconnecting…
              </>
            ) : (
              <>
                <PlugIcon className="h-3.5 w-3.5" />
                Reconnect
              </>
            )}
          </Button>

          <Button
            variant="danger"
            onClick={onRemove}
            title={`Remove ${connection.label}`}
            aria-label={`Remove ${connection.label}`}
            className="!px-2 !py-1.5 !text-[12px]"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </li>
  );
}

export function SettingsDialog({
  open,
  onClose,
  connections,
  onReconnect,
  onAddAccount,
  onDisconnect,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  onReconnect: (id: string) => void;
  onAddAccount: (provider: "gmail" | "slack") => void;
  onDisconnect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("connections");
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [demoNote, setDemoNote] = useState<string | null>(null);
  /** The account whose removal is being confirmed. The whole row is kept, not
   *  just its id, so the dialog can name it and speak about the right provider. */
  const [pendingRemoval, setPendingRemoval] = useState<Connection | null>(null);

  // Only while the dialog is up: it stays mounted when closed, so an unguarded
  // subscription here would read keys on every page load.
  const apiKeys = useAuthedQuery(api.apiKeys.list, open ? {} : "skip");
  const createKey = useMutation(api.apiKeys.create);
  const revokeKey = useMutation(api.apiKeys.revoke);
  const loadDemoData = useMutation(api.seed.seed);
  const clearDemoData = useMutation(api.seed.reset);

  /**
   * Wrap a mutation so the button can show its own pending state and any error
   * lands in the panel rather than in the console. Convex throws structured
   * errors; the message is written for a human, so it is shown verbatim.
   */
  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    setDemoNote(null);
    try {
      setDemoNote(await action());
    } catch (err) {
      setDemoNote(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * The spinner is not cleared: `onReconnect` starts a real OAuth flow, so the
   * next thing that happens is the browser leaving this page. Keeping the row in
   * its pending state until then is the honest rendering — the request has not
   * completed, it has handed off.
   */
  function reconnect(id: string) {
    setReconnecting(id);
    onReconnect(id);
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Settings"
        mobileFullScreen
      >
        {/* A fixed height, not a content-driven one: switching tabs must not
            resize the dialog. The pane scrolls internally instead. */}
        <div className="flex min-h-0 flex-1 flex-col sm:h-[34rem] sm:flex-row">
          {/* Tab rail — horizontal on mobile, vertical from sm up. */}
          <nav className="scrollbar-thin flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 sm:w-44 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] font-medium whitespace-nowrap transition-colors ${
                  tab === id
                    ? "bg-white/[0.07] text-white"
                    : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {tab === "connections" ? (
              <section className="space-y-2">
                <SectionTitle>Connected accounts</SectionTitle>

                {/* An empty bordered box reads as a loading failure, so zero
                    connections gets the same dashed empty state the switchboard
                    uses. */}
                {connections.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line-strong px-3.5 py-6 text-center text-[13px] text-neutral-500">
                    No accounts connected yet. Connect one below to search it.
                  </p>
                ) : null}

                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line empty:hidden">
                  {connections.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      reconnecting={reconnecting === connection.id}
                      onReconnect={() => reconnect(connection.id)}
                      onDisconnect={() => onDisconnect(connection.id)}
                      onRemove={() => setPendingRemoval(connection)}
                    />
                  ))}
                </ul>

                <div className="flex flex-wrap gap-2 pt-1">
                  {(["gmail", "slack"] as const).map((provider) => {
                    const Logo = BRAND_LOGO[provider];
                    return (
                      <Button
                        key={provider}
                        variant="outline"
                        onClick={() => onAddAccount(provider)}
                        className="!px-2.5 !py-1.5 !text-[12px]"
                      >
                        <Logo className="h-3.5 w-3.5" />
                        Connect {provider === "gmail" ? "Gmail" : "Slack"}
                      </Button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {tab === "api" ? (
              <section className="space-y-3">
                <SectionTitle>API keys</SectionTitle>

                {revealedKey ? (
                  <div className="fade-in rounded-xl border border-indigo-500/30 bg-indigo-500/[0.07] p-3.5">
                    <p className="text-[12px] font-medium text-indigo-200">
                      Copy this now. It will not be shown again.
                    </p>
                    <code className="mt-2 block overflow-x-auto rounded-lg border border-line bg-ink-950 px-3 py-2 font-mono text-[12px] text-white">
                      {revealedKey}
                    </code>
                    <p className="mt-2 text-[11px] text-indigo-200/70">
                      Send it as{" "}
                      <span className="font-mono">Authorization: Bearer …</span> to
                      the REST API. Only its SHA-256 digest is stored, so this is
                      the last time it can be read.
                    </p>
                  </div>
                ) : null}

                {apiKeys !== undefined && apiKeys.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line-strong px-3.5 py-6 text-center text-[13px] text-neutral-500">
                    No keys yet. Create one to drive search and send over REST with
                    no UI at all.
                  </p>
                ) : null}

                <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-ink-850/60 empty:hidden">
                  {(apiKeys ?? []).map((k) => (
                    <div
                      key={k.id}
                      className="flex flex-wrap items-center gap-3 px-3.5 py-3"
                    >
                      <KeyIcon className="h-4 w-4 shrink-0 text-neutral-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-neutral-200">
                          {k.name}
                        </p>
                        <p className="font-mono text-[11px] text-neutral-500">
                          {k.prefix}…{" "}
                          <span className="font-sans">
                            ·{" "}
                            {k.revokedAt !== undefined
                              ? `revoked ${formatAge(k.revokedAt)}`
                              : k.lastUsedAt === undefined
                                ? "never used"
                                : `last used ${formatAge(k.lastUsedAt)}`}
                          </span>
                        </p>
                      </div>
                      {k.revokedAt === undefined ? (
                        <Button
                          variant="danger"
                          className="px-2.5"
                          disabled={busy === `revoke-${k.id}`}
                          onClick={() =>
                            void run(`revoke-${k.id}`, async () => {
                              await revokeKey({ apiKeyId: k.id });
                              return "Key revoked. Requests on it now get a 401.";
                            })
                          }
                        >
                          Revoke
                        </Button>
                      ) : (
                        <StatusPill tone="warn">revoked</StatusPill>
                      )}
                    </div>
                  ))}
                </div>

                <Button
                  variant="outline"
                  disabled={busy === "create-key"}
                  onClick={() =>
                    void run("create-key", async () => {
                      const created = await createKey({ name: "REST client" });
                      setRevealedKey(created.key);
                      return "";
                    })
                  }
                >
                  <KeyIcon className="h-3.5 w-3.5" />
                  Create key
                </Button>

                {demoNote !== null && demoNote !== "" && tab === "api" ? (
                  <p className="text-[12px] text-neutral-400">{demoNote}</p>
                ) : null}
              </section>
            ) : null}

            {tab === "demo" ? (
              <section className="space-y-3">
                <SectionTitle>Demo data</SectionTitle>

                <p className="text-[13px] leading-relaxed text-neutral-400">
                  Loads one set of fixtures onto your account: three connections,
                  four searches (including one still running and one with a revoked
                  grant), drafts in every status, and a delivery in each of the
                  seven send states with its full attempt timeline.
                </p>
                <p className="text-[12px] leading-relaxed text-neutral-500">
                  Seeded rows are badged as demo data and hold no OAuth grant, so
                  they can never cause a real provider call. Loading twice does
                  nothing the second time.
                </p>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    variant="outline"
                    disabled={busy === "seed"}
                    onClick={() =>
                      void run("seed", async () => {
                        const out = await loadDemoData({});
                        return out.created
                          ? `Loaded ${out.counts.searches} searches, ${out.counts.results} results, ${out.counts.drafts} drafts and ${out.counts.sends} sends.`
                          : "Demo data is already loaded.";
                      })
                    }
                  >
                    {busy === "seed" ? "Loading…" : "Load demo data"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy === "reset"}
                    onClick={() =>
                      void run("reset", async () => {
                        const out = await clearDemoData({});
                        return `Removed ${out.counts.searches} searches, ${out.counts.drafts} drafts and ${out.counts.sends} sends. Your real data is untouched.`;
                      })
                    }
                  >
                    {busy === "reset" ? "Removing…" : "Remove demo data"}
                  </Button>
                </div>

                {demoNote !== null && demoNote !== "" ? (
                  <p className="fade-in rounded-xl border border-line bg-ink-850/60 px-3.5 py-2.5 text-[12px] text-neutral-300">
                    {demoNote}
                  </p>
                ) : null}
              </section>
            ) : null}

          </div>
        </div>
      </Modal>

      {/* A sibling of the settings dialog, not a child: nesting it inside that
          panel would put a `fixed` overlay inside an `overflow-hidden` box. */}
      <ConfirmDialog
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        onConfirm={() => {
          if (pendingRemoval !== null) onRemove(pendingRemoval.id);
        }}
        title={`Remove ${accountTitle(pendingRemoval ?? undefined)}?`}
        confirmLabel="Remove account"
      >
        <p>
          This deletes the stored grant for{" "}
          <span className="text-neutral-200">
            {accountTitle(pendingRemoval ?? undefined, "this account")}
          </span>{" "}
          and takes it off this list. Nothing is revoked at{" "}
          {pendingRemoval?.provider === "gmail" ? "Google" : "Slack"}, so you can
          connect it again at any time.
        </p>
        <p className="mt-2.5">
          Sends already made through it keep their history, so the outbox can still
          explain what each one went through.
        </p>
      </ConfirmDialog>
    </>
  );
}
