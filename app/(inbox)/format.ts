/**
 * Presentation helpers shared by every live-data hook.
 *
 * The mock driver pre-formats its timestamps as strings so server and client
 * render identical markup. Live data cannot do that — it arrives as epoch ms —
 * so formatting happens here, in one place, and only ever runs on the client:
 * a Convex `useQuery` returns `undefined` during SSR, so nothing derived from
 * `Date.now()` reaches the server-rendered HTML.
 */

/**
 * An account's name in running prose — a toast, a confirmation, an outbox line.
 *
 * A Slack label is the workspace, so on its own it names the wrong thing:
 * "Removed aryan-test" is ambiguous the moment two members of that workspace
 * have been connected. Gmail is unchanged, its label being the address already.
 */
export function accountTitle(
  account: { label: string; accountName?: string } | undefined,
  fallback = "account",
): string {
  if (account === undefined) return fallback;
  return account.accountName === undefined
    ? account.label
    : `${account.accountName} at ${account.label}`;
}

/** "now" · "23m" · "6h" · "3d". Matches the strings the mock data uses. */
export function formatAge(epochMs: number | undefined, now = Date.now()): string {
  if (epochMs === undefined) return "never";

  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
