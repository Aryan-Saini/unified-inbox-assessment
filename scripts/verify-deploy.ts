/**
 * Post-deploy verification. `pnpm verify:deploy`, or stage 3 of `pnpm deploy`.
 *
 * A deploy that succeeded and a deploy that works are different claims, and the
 * gap between them is where this project's interesting failures live: the bundle
 * inlined the wrong Convex URL, the deployment came up without its env, an API
 * key surface that authenticates nobody. None of those make `vercel deploy`
 * unhappy. So the pipeline finishes by using the thing it just shipped.
 *
 * Four checks, cheapest first, and every one of them is an assertion about the
 * deployed system rather than about our own bookkeeping:
 *
 *   1. an authenticated GET /connections answers 200          — the API is up
 *   2. the same call with no key, and with a junk key, is 401  — it is still shut
 *   3. /documentation/llms.txt on the app origin is non-empty  — the frontend
 *      renders and is talking to a backend (optional: needs APP_URL)
 *   4. the double-tap: N parallel sends, one delivery          — the guarantee
 *
 * Check 4 sends a real message, which is the point — it is the only assertion
 * here that a mocked test cannot make.
 */

import { doubleTap } from "./double-tap.ts";

interface Config {
  baseUrl: string;
  apiKey: string;
  recipient: string;
  appUrl: string | undefined;
  parallel: number;
}

const MISSING_ENV_HELP = `
Post-deploy verification needs three variables, and one more is optional. Put
them in .env.deploy at the repo root (git-ignored) or export them in the shell:

  BASE_URL   the deployed Convex HTTP API, e.g.
             https://scintillating-moose-307.convex.site
             (with or without the /api/v1 suffix — either is accepted)
  API_KEY    a uik_… key for the account being verified. Create it in the app
             under Settings → API keys; it is shown once and never again.
  RECIPIENT  where the double-tap sends its one real message — an email address
             for a Gmail connection, a channel id or name for Slack. Use an
             inbox you can actually open, because the last assertion is you
             looking at it.
  APP_URL    optional. The deployed Vercel URL, e.g.
             https://unified-inbox-assessment.vercel.app. Given it, the docs
             surface is checked too; without it, that check is skipped.
  N          optional, default 10. How many parallel sends the double-tap fires.

Run through the pipeline (\`pnpm deploy\`) these arrive as SMOKE_API_KEY,
SMOKE_RECIPIENT and SMOKE_APP_URL, so a stray API_KEY in the shell cannot point
a deploy's verification at the wrong account.
`.trim();

function readConfig(): Config {
  const baseUrlRaw = process.env.BASE_URL;
  const apiKey = process.env.API_KEY;
  const recipient = process.env.RECIPIENT;
  const missing = [
    baseUrlRaw === undefined || baseUrlRaw === "" ? "BASE_URL" : undefined,
    apiKey === undefined || apiKey === "" ? "API_KEY" : undefined,
    recipient === undefined || recipient === "" ? "RECIPIENT" : undefined,
  ].filter((name) => name !== undefined);

  if (missing.length > 0 || baseUrlRaw === undefined || apiKey === undefined || recipient === undefined) {
    console.error(`\nNot set: ${missing.join(", ")}.\n\n${MISSING_ENV_HELP}\n`);
    process.exit(1);
  }

  // `docs/api-walkthrough.sh` takes the bare origin and `double-tap.ts` takes the
  // origin plus `/api/v1`. Accepting both means nobody has to remember which.
  const trimmed = baseUrlRaw.replace(/\/+$/, "");
  const baseUrl = trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;

  const parallel = Number(process.env.N ?? "10");
  const appUrl = process.env.APP_URL === "" ? undefined : process.env.APP_URL;

  return { baseUrl, apiKey, recipient, appUrl, parallel: parallel };
}

const config = readConfig();
const failures: string[] = [];

/** Run one named check. A throw is a failure, not a crash — the rest still run. */
async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(`  PASS  ${name} — ${await run()}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`  FAIL  ${name} — ${detail}`);
    failures.push(name);
  }
}

console.log(`\nVerifying ${config.baseUrl}${config.appUrl === undefined ? "" : ` and ${config.appUrl}`}\n`);

await check("authenticated GET /connections", async () => {
  const response = await fetch(`${config.baseUrl}/connections`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`expected 200, got ${response.status}: ${text.slice(0, 200)}`);
  const body: unknown = JSON.parse(text);
  const connections =
    typeof body === "object" && body !== null && "connections" in body ? body.connections : undefined;
  if (!Array.isArray(connections)) throw new Error("200, but the body has no `connections` array");
  return `200, ${connections.length} connection(s)`;
});

await check("unauthenticated GET /connections", async () => {
  const response = await fetch(`${config.baseUrl}/connections`);
  if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
  return "401, as it should be";
});

await check("GET /connections with a junk key", async () => {
  // A well-formed key that was never issued. Separate from the header-less case
  // because they fail in different places, and only this one proves the digest
  // lookup actually happened.
  const response = await fetch(`${config.baseUrl}/connections`, {
    headers: { authorization: "Bearer uik_000000000000000000000000000000000000" },
  });
  if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`);
  return "401, as it should be";
});

if (config.appUrl === undefined) {
  console.log("  SKIP  documentation/llms.txt — APP_URL is not set");
} else {
  const appUrl = config.appUrl.replace(/\/+$/, "");
  await check("GET /documentation/llms.txt", async () => {
    const response = await fetch(`${appUrl}/documentation/llms.txt`);
    const text = await response.text();
    if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
    // Rendered from the docs pages, so an empty-ish body means the route came up
    // but the content behind it did not.
    if (text.trim().length < 200) throw new Error(`200, but only ${text.trim().length} characters came back`);
    return `200, ${text.trim().length} characters`;
  });
}

await check("double-tap: parallel sends, one delivery", async () => {
  const result = await doubleTap({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    recipient: config.recipient,
    parallel: config.parallel,
  });
  return (
    `${result.parallel} identical responses, one sends row, provider message ${result.providerMessageId}` +
    `\n        MANUAL CHECK: open ${config.recipient} and verify exactly one message containing ${result.idempotencyKey}.`
  );
});

if (failures.length > 0) {
  console.error(`\nVERIFICATION FAILED: ${failures.join("; ")}.\n`);
  process.exit(1);
}

console.log("\nPASS — the deployed API answers, refuses an unknown key, and sends exactly once.\n");
