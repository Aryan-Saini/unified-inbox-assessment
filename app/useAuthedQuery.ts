"use client";

import {
  useConvexAuth,
  useQuery,
  type OptionalRestArgsOrSkip,
} from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

/**
 * `useQuery`, held at `"skip"` until Convex has an identity it accepts.
 *
 * Every query in this app resolves an owner (`requireUser`), so calling one a
 * beat too early throws "Not signed in." — a server error for a state that is
 * completely normal: React renders before Clerk has a session and before Convex
 * has traded it for a token. The gates mean that mostly cannot happen; this makes
 * it structurally impossible, including during SSR and on the frame after a sign
 * out, and it costs nothing because `undefined` is the same "still loading" value
 * these call sites already handle.
 *
 * Pass `"skip"` yourself as usual for the conditional cases (a dialog that is
 * closed, an id that does not exist yet); the two conditions compose.
 */
export function useAuthedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
): FunctionReturnType<Query> | undefined {
  const { isAuthenticated } = useConvexAuth();

  // The cast re-states what the line above guarantees: the value is either this
  // query's args or the "skip" sentinel, which is exactly the rest-args tuple.
  return useQuery(
    query,
    ...([isAuthenticated ? args : "skip"] as OptionalRestArgsOrSkip<Query>),
  );
}
