"use client";

import { SOURCE_META } from "./mock-data";
import type { SourceRun } from "./types";
import { AlertIcon } from "./icons";

/**
 * One banner per failing source, carrying the actual provider error.
 *
 * The per-source chips used to live here too, but they duplicated the result
 * counts in the filter row below — they are now one merged strip in
 * `ResultsList`, where the state and the filter are the same control.
 */
export function SourceStatus({ runs }: { runs: SourceRun[] }) {
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
        </div>
      ))}
    </div>
  );
}
