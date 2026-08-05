/**
 * Scheduled maintenance.
 *
 * Everything here is a *backstop*, not a mechanism. Each fan-out already
 * schedules its own watchdog at dispatch time, so these crons only matter when
 * the scheduler itself lost work — a deploy mid-run, a deployment paused and
 * resumed. Stating that plainly is the point: if a cron were load-bearing, the
 * latency of the feature would be the cron's interval.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Searches whose workers never reported. Five minutes is far longer than the
// per-search watchdog needs, because this only ever catches what that missed.
crons.interval(
  "sweep stuck searches",
  { minutes: 5 },
  internal.orchestrator.sweepStuckSearches,
  {},
);

// Spent OAuth states. Kept a full TTL past expiry first, so a replay is still
// answered with "replayed" rather than "unknown" while it can be.
crons.interval(
  "collect expired oauth states",
  { hours: 1 },
  internal.oauth.gcExpiredStates,
  {},
);

export default crons;
