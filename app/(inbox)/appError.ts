/**
 * Reading a server error back on the client.
 *
 * The backend throws `ConvexError`s carrying `{ code, message, httpStatus }`
 * (see `convex/core/errors.ts`), so the UI can show the sentence a human wrote
 * for the situation instead of "Server Error" or a stack trace. `code` is
 * returned alongside it because the interesting refusals — an indeterminate send,
 * a re-used key — need a different affordance, not just different words.
 *
 * Anything unstructured (a network drop, a bug) falls back to a short, honest
 * line rather than leaking internals into the interface.
 */

import { ConvexError } from "convex/values";

export interface AppErrorView {
  code: string;
  message: string;
}

const FALLBACK = "Something went wrong reaching the server. Try again.";

export function describeError(err: unknown): AppErrorView {
  if (err instanceof ConvexError) {
    const data: unknown = err.data;
    if (typeof data === "object" && data !== null && "message" in data) {
      const { code, message } = data as { code?: unknown; message?: unknown };
      if (typeof message === "string") {
        return {
          code: typeof code === "string" ? code : "ERROR",
          // The server prefixes its messages with the code for logs; the UI shows
          // the sentence and renders the code separately if it needs to.
          message: message.replace(/^[A-Z_]+:\s*/, ""),
        };
      }
    }
  }
  return { code: "ERROR", message: FALLBACK };
}
