"use client";

import { SOURCE_META } from "./mock-data";
import type { Source, SourceRun } from "./types";
import { AlertIcon, PlugIcon } from "./icons";

/**
 * One banner per failing source, carrying the actual provider error.
 *
 * The per-source chips used to live here too, but they duplicated the result
 * counts in the filter row below — they are now one merged strip in
 * `ResultsList`, where the state and the filter are the same control.
 *
 * A revoked grant is the one failure the reader can fix, so its banner carries
 * the reconnect action itself rather than pointing at the chip above.
 */
export function SourceStatus({
  runs,
  onReconnect,
}: {
  runs: SourceRun[];
  onReconnect: (source: Source) => void;
}) {
  const problems = runs.filter(
    (r) => r.status === "failed" || r.status === "needs_reconnect",
  );

  return (
    <div className="space-y-2.5">
      {problems.map((run) => (
        <div
          key={run.source}
          className={`fade-in flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${
            run.status === "needs_reconnect"
              ? "border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90"
              : "border-rose-500/25 bg-rose-500/[0.06] text-rose-200/90"
          }`}
        >
          <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold">
              {SOURCE_META[run.source].name} · {run.label}
            </span>
            <span className="mx-1.5 opacity-40">—</span>
            <span className="font-mono text-[11px] break-words opacity-90">
              {run.errorMessage}
            </span>
          </span>
          {run.status === "needs_reconnect" ? (
            <button
              type="button"
              onClick={() => onReconnect(run.source)}
              className="ml-auto flex shrink-0 items-center gap-1 self-center rounded-md bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/25"
            >
              <PlugIcon className="h-3 w-3" />
              Reconnect
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
