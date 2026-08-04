"use client";

import { SOURCE_META } from "./mock-data";
import type { Source, SourceRun } from "./types";
import { AlertIcon, GmailGlyph, PlugIcon, RerunIcon, SlackGlyph, WebGlyph } from "./icons";

const GLYPH: Record<Source, (p: { className?: string }) => React.ReactNode> = {
  gmail: GmailGlyph,
  slack: SlackGlyph,
  web: WebGlyph,
};

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One chip per adapter run — the UI's answer to "which sources are still
 * working". A source never disappears from this strip: it moves between
 * running, returned, needs-reconnect and failed, so a partial result set is
 * always legible as *why* it is partial.
 */
function Chip({
  run,
  elapsed,
  onReconnect,
  onRetry,
}: {
  run: SourceRun;
  elapsed: number;
  onReconnect: () => void;
  onRetry: () => void;
}) {
  const meta = SOURCE_META[run.source];
  const Glyph = GLYPH[run.source];
  const inFlight = run.status === "pending" || run.status === "running";

  const shell =
    run.status === "needs_reconnect"
      ? "border-amber-500/35 bg-amber-500/[0.08] text-amber-200"
      : run.status === "failed"
        ? "border-rose-500/35 bg-rose-500/[0.08] text-rose-200"
        : inFlight
          ? "border-line-strong bg-white/[0.04] text-neutral-300"
          : "border-line bg-white/[0.02] text-neutral-400";

  return (
    <div
      className={`relative flex items-center gap-2 overflow-hidden rounded-full border py-1.5 pr-2.5 pl-2.5 text-[12px] transition-colors duration-300 ${shell} ${
        run.status === "running" ? "sweep" : ""
      }`}
    >
      <Glyph className={`h-3.5 w-3.5 shrink-0 ${meta.color}`} />
      <span className="font-medium text-neutral-200">{meta.name}</span>

      {run.status === "pending" ? (
        <span className="text-neutral-500">queued</span>
      ) : null}

      {run.status === "running" ? (
        <span className="flex items-center gap-1.5 text-neutral-400">
          <span
            className={`pulse-ring relative h-1.5 w-1.5 rounded-full ${meta.dot}`}
          />
          searching… <span className="tabular-nums">{seconds(elapsed)}</span>
        </span>
      ) : null}

      {run.status === "succeeded" ? (
        <span className="text-neutral-500">
          <span className="tabular-nums text-neutral-300">
            {run.resultCount}
          </span>{" "}
          · <span className="tabular-nums">{seconds(run.durationMs ?? 0)}</span>
        </span>
      ) : null}

      {run.status === "needs_reconnect" ? (
        <>
          <span>needs reconnect</span>
          <button
            onClick={onReconnect}
            className="-mr-1 ml-0.5 flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/25"
          >
            <PlugIcon className="h-3 w-3" />
            Reconnect
          </button>
        </>
      ) : null}

      {run.status === "failed" ? (
        <>
          <span>{run.errorKind === "transient" ? "rate limited" : "failed"}</span>
          <button
            onClick={onRetry}
            className="-mr-1 ml-0.5 flex items-center gap-1 rounded-full bg-rose-400/15 px-2 py-0.5 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-400/25"
          >
            <RerunIcon className="h-3 w-3" />
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

export function SourceStatus({
  runs,
  resultCount,
  working,
  elapsed,
  onReconnect,
  onRetry,
}: {
  runs: SourceRun[];
  resultCount: number;
  working: boolean;
  elapsed: number;
  onReconnect: (source: Source) => void;
  onRetry: (source: Source) => void;
}) {
  const settled = runs.filter(
    (r) => r.status !== "pending" && r.status !== "running",
  ).length;
  const stillWorking = runs.filter(
    (r) => r.status === "pending" || r.status === "running",
  );
  const problems = runs.filter(
    (r) => r.status === "failed" || r.status === "needs_reconnect",
  );

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {runs.map((run) => (
          <Chip
            key={run.source}
            run={run}
            elapsed={elapsed}
            onReconnect={() => onReconnect(run.source)}
            onRetry={() => onRetry(run.source)}
          />
        ))}

        <span className="ml-auto flex items-center gap-2 text-[12px] text-neutral-500">
          <span>
            <span className="tabular-nums text-neutral-300">{resultCount}</span>{" "}
            results
          </span>
          <span className="text-neutral-700">·</span>
          <span className="tabular-nums">
            {settled}/{runs.length} sources
          </span>
        </span>
      </div>

      {working && stillWorking.length > 0 && resultCount > 0 ? (
        <p className="fade-in text-[12px] text-neutral-500">
          Showing partial results —{" "}
          <span className="text-neutral-300">
            {stillWorking.map((r) => SOURCE_META[r.source].name).join(" and ")}
          </span>{" "}
          {stillWorking.length === 1 ? "is" : "are"} still working. Nothing waits
          on {stillWorking.length === 1 ? "it" : "them"}.
        </p>
      ) : null}

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
