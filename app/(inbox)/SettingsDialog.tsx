"use client";

import { useState } from "react";
import type { Connection, ConnectionStatus } from "./types";
import type { DemoOptions } from "./useMockSearch";
import { Button, MockBadge, Modal, StatusPill, Toggle } from "./ui";
import {
  GmailGlyph,
  KeyIcon,
  PlugIcon,
  SlackGlyph,
  SlidersIcon,
} from "./icons";

type Tab = "connections" | "demo" | "api" | "preferences";

const TABS: { id: Tab; label: string; icon: (p: { className?: string }) => React.ReactNode }[] = [
  { id: "connections", label: "Connections", icon: PlugIcon },
  { id: "api", label: "API keys", icon: KeyIcon },
  { id: "preferences", label: "Preferences", icon: SlidersIcon },
  { id: "demo", label: "Demo controls", icon: SlidersIcon },
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
}: {
  connection: Connection;
  reconnecting: boolean;
  onReconnect: () => void;
}) {
  const Glyph = connection.provider === "gmail" ? GmailGlyph : SlackGlyph;
  const healthy = connection.status === "active";

  return (
    <div className="rounded-xl border border-line bg-ink-850/60 p-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line ${
            connection.provider === "gmail"
              ? "bg-[#f0655a]/10 text-[#f0655a]"
              : "bg-[#a78bfa]/10 text-[#a78bfa]"
          }`}
        >
          <Glyph className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-white">
              {connection.label}
            </span>
            <StatusPill tone={TONE[connection.status]}>
              {connection.status}
            </StatusPill>
          </div>
          <p className="mt-0.5 text-[12px] text-neutral-500">
            {connection.detail} · last used {connection.lastUsed}
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {connection.scopes.map((scope) => (
              <code
                key={scope}
                className="rounded border border-line bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-500"
              >
                {scope}
              </code>
            ))}
          </div>

          {connection.statusReason ? (
            <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-amber-200/80">
              {connection.statusReason}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {healthy ? (
            <Button variant="ghost" className="px-2.5">
              Disconnect
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={onReconnect}
              disabled={reconnecting}
              className="px-2.5"
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
        </div>
      </div>

      {healthy && connection.lastUsed === "just now" ? (
        <p className="fade-in mt-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-emerald-200/90">
          Reconnected. The connection id was preserved, so history and drafts
          hanging off it are intact.
        </p>
      ) : null}
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  connections,
  onReconnect,
  demo,
  onDemoChange,
}: {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  onReconnect: (id: string) => void;
  demo: DemoOptions;
  onDemoChange: (next: DemoOptions) => void;
}) {
  const [tab, setTab] = useState<Tab>("connections");
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [prefs, setPrefs] = useState({
    openInNewTab: true,
    unreadDots: true,
    denseRows: false,
  });

  function reconnect(id: string) {
    setReconnecting(id);
    // Stands in for the OAuth round trip.
    setTimeout(() => {
      onReconnect(id);
      setReconnecting(null);
    }, 1200);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      badge={<MockBadge>Mock — nothing here persists</MockBadge>}
      subtitle="Every control on this screen is a UI placeholder. No OAuth flow runs, no key is issued, and nothing is written anywhere."
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex min-h-[26rem] flex-col sm:flex-row">
        {/* Tab rail — horizontal on mobile, vertical from sm up. */}
        <nav className="scrollbar-thin flex shrink-0 gap-1 overflow-x-auto border-b border-line p-3 sm:w-44 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium whitespace-nowrap transition-colors ${
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

        <div className="min-w-0 flex-1 p-5">
          {tab === "connections" ? (
            <section className="space-y-3">
              <header>
                <h3 className="text-[13px] font-semibold text-white">
                  Connected accounts
                </h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500">
                  One row per OAuth grant. A grant that goes bad shows its real
                  reason and offers reconnect — which preserves the connection
                  identity so dependent state survives.
                </p>
              </header>

              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  reconnecting={reconnecting === connection.id}
                  onReconnect={() => reconnect(connection.id)}
                />
              ))}

              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline">
                  <GmailGlyph className="h-3.5 w-3.5" />
                  Connect another Gmail
                </Button>
                <Button variant="outline">
                  <SlackGlyph className="h-3.5 w-3.5" />
                  Connect another Slack
                </Button>
              </div>
            </section>
          ) : null}

          {tab === "api" ? (
            <section className="space-y-3">
              <header>
                <h3 className="text-[13px] font-semibold text-white">
                  API keys
                </h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500">
                  Scoped to your data. A key is shown once at creation and stored
                  only as a digest.
                </p>
              </header>

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
                    `uik_${(globalThis.crypto?.randomUUID?.() ?? "mockmockmock")
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

          {tab === "preferences" ? (
            <section className="space-y-1">
              <header className="mb-2">
                <h3 className="text-[13px] font-semibold text-white">
                  Preferences
                </h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500">
                  Local display options. These toggle state but are not wired to
                  the list yet.
                </p>
              </header>

              <Toggle
                checked={prefs.openInNewTab}
                onChange={(v) => setPrefs({ ...prefs, openInNewTab: v })}
                label="Open results in a new tab"
                description="Keeps the search screen and its streaming state intact."
              />
              <Toggle
                checked={prefs.unreadDots}
                onChange={(v) => setPrefs({ ...prefs, unreadDots: v })}
                label="Show unread markers"
                description="A dot beside Gmail and Slack results you have not opened."
              />
              <Toggle
                checked={prefs.denseRows}
                onChange={(v) => setPrefs({ ...prefs, denseRows: v })}
                label="Dense result rows"
                description="Drops the snippet to one line to fit more on screen."
              />
            </section>
          ) : null}

          {tab === "demo" ? (
            <section className="space-y-1">
              <header className="mb-2">
                <h3 className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-white">
                  Demo controls
                  <MockBadge>Drives the mock adapters</MockBadge>
                </h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500">
                  These make the failure paths reachable on demand, so the
                  partial-results, reconnect and retry states can be seen without
                  waiting for a real outage.
                </p>
              </header>

              <Toggle
                checked={demo.slowWebSource}
                onChange={(v) => onDemoChange({ ...demo, slowWebSource: v })}
                label="Make the web adapter slow (~3.6s)"
                description="Gmail and Slack land first; the strip keeps showing Web as still working."
              />
              <Toggle
                checked={demo.slackNeedsReconnect}
                onChange={(v) =>
                  onDemoChange({ ...demo, slackNeedsReconnect: v })
                }
                label="Slack grant is revoked"
                description="Returns a distinct needs-reconnect state with a reconnect action, not a generic error."
              />
              <Toggle
                checked={demo.gmailTransientFailure}
                onChange={(v) =>
                  onDemoChange({ ...demo, gmailTransientFailure: v })
                }
                label="Gmail hits a rate limit"
                description="A transient failure: surfaced with its attempt history and offered as a retry."
              />
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
