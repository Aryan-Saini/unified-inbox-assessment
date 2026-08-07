"use client";

import { useState } from "react";
import { BRAND_LOGO } from "./brand-icons";
import { SOURCE_META } from "./mock-data";
import type { Connection, ConnectionStatus, Source } from "./types";
import { PlusIcon } from "./icons";
import { Button, StatusPill, Truncated } from "./ui";

/**
 * Only the account-backed sources appear here. Web has nothing to sign in to,
 * so it would be a rail entry leading to a single switch — it lives directly in
 * the search bar as its own icon toggle instead.
 */
const CONNECTOR_SOURCES = ["gmail", "slack"] as const;
type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];

/**
 * The pill states a condition; the button beside it offers the action. The
 * expired pill used to read "Reconnect", which put the same word twice on one
 * row — once as a diagnosis and once as a cure — and left the row unable to say
 * what was actually wrong with the grant.
 */
const STATUS: Record<
  ConnectionStatus,
  { tone: "ok" | "warn" | "bad"; label: string }
> = {
  active: { tone: "ok", label: "Active" },
  expired: { tone: "warn", label: "Expired" },
  errored: { tone: "bad", label: "Errored" },
  revoked: { tone: "bad", label: "Revoked" },
};

/**
 * How many scopes a grant holds, with the list itself on hover.
 *
 * A count answers the question the row is actually asking — "is this grant
 * narrow, and does it still match what the app requests?" — in one short line,
 * where five printed scopes wrapped the row and buried the account label they
 * belong to. The names are one hover away for anyone auditing them.
 *
 * Google's `https://www.googleapis.com/auth/` prefix is dropped in the tooltip:
 * it is the same on every Gmail scope, so it is noise in a vertical list.
 */
export function ScopeSummary({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;

  const names = scopes.map((scope) =>
    scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ""),
  );

  return (
    <span
      title={names.join("\n")}
      className="mt-0.5 inline-block cursor-help text-[12.5px] text-neutral-500 underline decoration-dotted decoration-neutral-700 underline-offset-2"
    >
      {scopes.length} {scopes.length === 1 ? "scope" : "scopes"}
    </span>
  );
}

/**
 * What a row is called: the account first, then where it lives.
 *
 * Slack's label is the *workspace*, and a workspace has many members whose
 * searches differ — so "aryan-test" alone never said whose Slack this is. The
 * member leads and the workspace qualifies it: "George at aryan-test". Gmail is
 * just its address, which is already both halves.
 */
export function AccountName({
  account,
}: {
  account: { label: string; accountName?: string };
}) {
  // `min-w-0 flex-1` rather than a bare `truncate`: a flex child will not
  // shrink below its content by default, so a 254-character address — which is
  // a legal one — pushed the status pill off the row instead of ellipsising.
  // The name yields, the pill does not, and `Truncated` hands the whole thing
  // back on hover.
  const shell = "min-w-0 flex-1 text-[14.5px] font-medium text-neutral-100";

  if (account.accountName === undefined || account.accountName === "") {
    return <Truncated text={account.label} label="Account" className={shell} />;
  }

  return (
    <Truncated
      text={`${account.accountName} at ${account.label}`}
      label="Account"
      className={shell}
    >
      {account.accountName}
      <span className="font-normal text-neutral-400"> at {account.label}</span>
    </Truncated>
  );
}

/** The row-level switch. Label-less; the row it sits in is the label. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${
        checked ? "bg-indigo-500" : "bg-neutral-700"
      }`}
    >
      {/* Anchored 2px inside the left edge and moved by exactly the track's
          spare width, so the thumb can never overhang the track. */}
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export interface SwitchboardProps {
  connections: Connection[];
  enabledSources: Source[];
  onToggleSource: (source: Source) => void;
  onToggleAccount: (id: string) => void;
  onAddAccount: (provider: "gmail" | "slack") => void;
  onReconnect: (id: string) => void;
}

/**
 * Connections as a two-level switchboard: a rail of connectors, and for the
 * selected one a master switch plus a switch per account.
 *
 * Shared verbatim by the dropdown in the search bar and the standalone modal,
 * so the two entry points can never drift apart.
 *
 * The two levels are deliberately independent. Turning the connector off
 * excludes the whole source without forgetting which accounts were on; turning
 * one account off narrows the fan-out while leaving the connector live. Neither
 * disconnects anything — that is a separate, and in this build absent, action.
 */
export function ConnectorSwitchboard({
  connections,
  enabledSources,
  onToggleSource,
  onToggleAccount,
  onAddAccount,
  onReconnect,
  compact = false,
}: SwitchboardProps & { compact?: boolean }) {
  const [selected, setSelected] = useState<ConnectorSource>("gmail");

  const Logo = BRAND_LOGO[selected];
  const meta = SOURCE_META[selected];
  const connectorOn = enabledSources.includes(selected);
  const accounts = connections.filter((c) => c.provider === selected);
  const isLastOn = connectorOn && enabledSources.length === 1;

  return (
    // A fixed height, not a content-driven one: Gmail with three accounts and
    // the account-less web connector must occupy the same box, or switching
    // between them makes the panel jump.
    <div
      className={`flex ${compact ? "h-[21rem]" : "h-[24rem]"} flex-col sm:flex-row`}
    >
      {/* Rail. Horizontal strip on mobile, vertical rail from sm up. */}
      <div className="flex shrink-0 flex-row gap-1 border-b border-line p-2 sm:w-14 sm:flex-col sm:border-r sm:border-b-0">
        {CONNECTOR_SOURCES.map((source) => {
          const RailLogo = BRAND_LOGO[source];
          const active = source === selected;
          const on = enabledSources.includes(source);

          return (
            <button
              key={source}
              type="button"
              onClick={() => setSelected(source)}
              aria-current={active}
              title={SOURCE_META[source].name}
              className={`flex h-10 flex-1 items-center justify-center rounded-xl transition-colors sm:flex-none ${
                active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"
              }`}
            >
              {/* A switched-off connector reads as drained rather than hidden,
                  so you can still see that it exists. */}
              <RailLogo
                className={`h-5 w-5 transition-all duration-200 ${
                  on ? "" : "opacity-40 grayscale"
                }`}
              />
            </button>
          );
        })}
      </div>

      {/* Pane. Scrolls internally so a long account list grows the list, not
          the panel. */}
      <div className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-3.5 sm:p-4">
        {/* Master switch */}
        <div className="flex items-center gap-3 rounded-xl border border-line bg-ink-850/60 p-3">
          <Logo className="h-6 w-6 shrink-0" />
          <p className="min-w-0 flex-1 text-[15px] font-semibold text-white">
            Turn on {meta.name} connector
          </p>
          <Switch
            checked={connectorOn}
            onChange={() => onToggleSource(selected)}
            label={`Turn on the ${meta.name} connector`}
            disabled={isLastOn}
          />
        </div>

        {/* Accounts */}
        <div className="mt-3.5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-[12.5px] font-semibold tracking-wide text-neutral-500 uppercase">
                Accounts
              </h3>
              <Button
                variant="outline"
                onClick={() => onAddAccount(selected)}
                className="!px-2.5 !py-1.5 !text-[13px]"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Add account
              </Button>
            </div>

            {accounts.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line-strong px-3.5 py-6 text-center text-[14.5px] text-neutral-500">
                No {meta.name} accounts yet. Add one to search it.
              </p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {accounts.map((account) => (
                  // `items-start`, not `items-center`. The left column is two
                  // lines (name, then scopes) and the right one is a single row
                  // of controls, so centring the row centred the controls
                  // against the *pair* — leaving the pill and the switch that
                  // belong to the same line visibly off each other. Both
                  // clusters are pinned to the top instead and given the same
                  // line box, so the first line aligns across the row whether or
                  // not the account has a Reconnect button under it.
                  <li
                    key={account.id}
                    className={`flex items-start gap-3 px-3 py-2.5 transition-opacity ${
                      connectorOn ? "" : "opacity-50"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex h-7 min-w-0 items-center gap-2">
                        <AccountName account={account} />
                        <StatusPill tone={STATUS[account.status].tone}>
                          {STATUS[account.status].label}
                        </StatusPill>
                        {/* Same badge the outbox puts on a seeded send: a demo
                            account holds no grant, and a status pill alone would
                            let it read as a real one. */}
                        {account.isSeed ? <StatusPill tone="idle">demo</StatusPill> : null}
                      </div>
                      {/* What this grant can actually do. Narrow scopes are a
                          claim worth being able to check rather than trust, and
                          it is also how you tell a stale grant from a current
                          one after the requested set changes. */}
                      <ScopeSummary scopes={account.scopes} />
                    </div>

                    <div className="flex h-7 shrink-0 items-center gap-2">
                      {account.status !== "active" ? (
                        <Button
                          variant="ghost"
                          onClick={() => onReconnect(account.id)}
                          className="!px-2.5 !py-1 !text-[13px]"
                        >
                          Reconnect
                        </Button>
                      ) : null}

                      <Switch
                        checked={account.enabled}
                        onChange={() => onToggleAccount(account.id)}
                        label={`Include ${account.label} in searches`}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </div>
  );
}
