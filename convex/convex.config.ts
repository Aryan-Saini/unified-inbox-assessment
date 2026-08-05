/**
 * Components mounted into this deployment.
 *
 * Only one so far: the rate limiter. It is a component rather than a counter
 * column because the interesting case is the concurrent one — two requests
 * reading the same window and both deciding they are under the limit. The
 * component does the accounting transactionally, which a hand-rolled window
 * scan cannot without serialising every request against every other.
 */

import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp();
app.use(rateLimiter);

export default app;
