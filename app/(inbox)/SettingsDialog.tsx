"use client";

import { useState } from "react";
import { BRAND_LOGO } from "./brand-icons";
import type { Connection, ConnectionStatus } from "./types";
import { Button, Modal, StatusPill } from "./ui";
import { KeyIcon, PlugIcon } from "./icons";

/** Section heading, matching the "ACCOUNTS" label in the connectors panel. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11.5px] font-semibold tracking-wide text-neutral-500 uppercase">
      {children}
    </h3>
  );
}

type Tab = "connections" | "api";

const TABS: { id: Tab; label: string; icon: (p: { className?: string }) => React.ReactNode }[] = [
  { id: "connections", label: "Connections", icon: PlugIcon },
  { id: "api", label: "API keys", icon: KeyIcon },
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
}: {
  connection: Connection;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const Logo = BRAND_LOGO[connection.provider];
  const healthy = connection.status === "active";

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Logo className="h-4 w-4 shrink-0" />

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="truncate text-[13px] font-medium text-neutral-100">
          {connection.label}
        </span>
        <StatusPill tone={TONE[connection.status]}>
          {connection.status}
        </StatusPill>
      </div>

      {healthy ? (
        <Button
          variant="ghost"
          onClick={onDisconnect}
          className="!px-2.5 !py-1.5 !text-[12px]"
        >
          Disconnect
        </Button>
      ) : (
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
}: {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  onReconnect: (id: string) => void;
  onAddAccount: (provider: "gmail" | "slack") => void;
  onDisconnect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("connections");
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

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
                    Copy this now — it will not be shown again.
                  </p>
                  <code className="mt-2 block overflow-x-auto rounded-lg border border-line bg-ink-950 px-3 py-2 font-mono text-[12px] text-white">
                    {revealedKey}
                  </code>
                  <p className="mt-2 text-[11px] text-indigo-200/70">
                    This string is fabricated by the UI and authenticates
                    nothing.
                  </p>
                </div>
              ) : null}

              <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-ink-850/60">
                {[
                  { prefix: "uik_a1b2c3", name: "local-dev script", used: "2m ago" },
                  { prefix: "uik_9f8e7d", name: "reviewer walkthrough", used: "never" },
                ].map((k) => (
                  <div
                    key={k.prefix}
                    className="flex flex-wrap items-center gap-3 px-3.5 py-3"
                  >
                    <KeyIcon className="h-4 w-4 shrink-0 text-neutral-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-neutral-200">
                        {k.name}
                      </p>
                      <p className="font-mono text-[11px] text-neutral-500">
                        {k.prefix}…{" "}
                        <span className="font-sans">· last used {k.used}</span>
                      </p>
                    </div>
                    <Button variant="danger" className="px-2.5">
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>

              <Button
                variant="outline"
                onClick={() =>
                  setRevealedKey(
                    `uik_${(globalThis.crypto?.randomUUID?.() ?? "0000000000000000")
                      .replace(/-/g, "")
                      .slice(0, 28)}`,
                  )
                }
              >
                <KeyIcon className="h-3.5 w-3.5" />
                Create key
              </Button>
            </section>
          ) : null}

        </div>
      </div>
    </Modal>
  );
}
