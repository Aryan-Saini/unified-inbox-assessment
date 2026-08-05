"use client";

/**
 * Live connections, in the shape the existing components already consume.
 *
 * The whole point of this hook is that nothing below it changes. Every component
 * keeps taking `Connection[]` and the same four callbacks; only the source of the
 * data moves from `MOCK_CONNECTIONS` to Convex. The mapping to the UI type lives
 * here rather than in a component so there is exactly one place where the backend
 * row shape and the UI's view of it meet.
 */

import { useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthedQuery } from "@/app/useAuthedQuery";
import { formatAge } from "./format";
import { useClockMinute } from "./useClock";
import type { Connection } from "./types";

export interface UseConnections {
  connections: Connection[];
  /** `true` until the first server response — distinct from "none connected". */
  loading: boolean;
  /** Starts an OAuth flow and navigates. Never returns. */
  addAccount: (provider: "gmail" | "slack") => void;
  /** Re-grants an existing connection, preserving its id. */
  reconnect: (id: string) => void;
  toggleAccount: (id: string) => void;
  disconnect: (id: string) => void;
}

export function useConnections(): UseConnections {
  const rows = useAuthedQuery(api.connections.list, {});
  const begin = useMutation(api.oauth.begin);
  const setEnabled = useMutation(api.connections.setEnabled);
  const disconnectMutation = useMutation(api.connections.disconnect);

  // Ticks once a minute, so "last used" ages instead of freezing at first paint.
  const now = useClockMinute();

  const connections = useMemo<Connection[]>(() => {
    if (rows === undefined) return [];

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      label: row.label,
      detail:
        row.statusReason ??
        (row.provider === "gmail"
          ? (row.accountEmail ?? "Gmail account")
          : `${row.teamName ?? row.label} workspace`),
      status: row.status,
      statusReason: row.statusReason,
      scopes: row.scopes,
      lastUsed: formatAge(row.lastUsedAt, now),
      enabled: row.enabled,
    }));
  }, [rows, now]);

  /**
   * Send the browser to the provider.
   *
   * `returnTo` is the path we are on right now, so the callback lands the user
   * back where they started rather than at the app root — mid-search, with the
   * results still on screen.
   *
   * `origin` is the other half of that: the deployment cannot know which port
   * `next dev` picked today, so the browser says where it is. The backend only
   * honours it if it is loopback or registered (`resolveAppOrigin`), so proposing
   * it is safe and being ignored is harmless.
   */
  const startFlow = useCallback(
    async (provider: "gmail" | "slack", reconnectConnectionId?: Id<"connections">) => {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      const { url } = await begin({
        provider,
        reconnectConnectionId,
        returnTo,
        origin: window.location.origin,
      });
      // `assign` rather than `href =` so the app page stays in history and Back
      // returns here instead of bouncing through the consent screen again.
      window.location.assign(url);
    },
    [begin],
  );

  const addAccount = useCallback(
    (provider: "gmail" | "slack") => {
      void startFlow(provider);
    },
    [startFlow],
  );

  const reconnect = useCallback(
    (id: string) => {
      const existing = rows?.find((row) => row.id === id);
      if (existing === undefined) return;
      void startFlow(existing.provider, existing.id);
    },
    [rows, startFlow],
  );

  const toggleAccount = useCallback(
    (id: string) => {
      const existing = rows?.find((row) => row.id === id);
      if (existing === undefined) return;
      void setEnabled({ connectionId: existing.id, enabled: !existing.enabled });
    },
    [rows, setEnabled],
  );

  const disconnect = useCallback(
    (id: string) => {
      void disconnectMutation({ connectionId: id as Id<"connections"> });
    },
    [disconnectMutation],
  );

  return {
    connections,
    loading: rows === undefined,
    addAccount,
    reconnect,
    toggleAccount,
    disconnect,
  };
}
