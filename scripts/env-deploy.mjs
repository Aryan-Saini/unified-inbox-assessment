/**
 * Reads `.env.deploy` — the one git-ignored file the deploy pipeline needs.
 *
 * It holds two unrelated things that happen to share an owner: the Convex
 * production deploy key, and the credentials the post-deploy verification uses.
 *
 *   CONVEX_DEPLOY_KEY   Convex dashboard → deployed environment → Settings →
 *                       Deploy Keys → Generate Production Deploy Key
 *   SMOKE_BASE_URL      https://scintillating-moose-307.convex.site
 *   SMOKE_API_KEY       a uik_… key, from the app's Settings → API keys
 *   SMOKE_RECIPIENT     an inbox or channel you can open afterwards
 *   SMOKE_APP_URL       optional, the deployed Vercel URL
 *   SMOKE_N             optional, parallel sends in the double-tap
 *
 * Not on Vercel, deliberately. The build happens on this machine, and a
 * *sensitive* Vercel variable is never handed back by `vercel pull` — it comes
 * back as an empty string — so a deploy key stored there would never arrive. The
 * alternative, storing it `plain`, puts a production credential in a dashboard
 * for the convenience of a builder that does not exist here. Vercel never needs
 * it: nothing at runtime deploys Convex.
 *
 * The shell wins over the file, so a one-off `CONVEX_DEPLOY_KEY=… pnpm deploy`
 * does what it looks like.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEPLOY_ENV_FILE = join(process.cwd(), ".env.deploy");

/** A KEY=VALUE file, not a shell script: no expansion, no `export`, no arrays. */
function parse(contents) {
  const values = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    const unquoted = /^(".*"|'.*')$/s.test(raw) ? raw.slice(1, -1) : raw;
    if (key !== "") values[key] = unquoted;
  }
  return values;
}

/**
 * Everything in `.env.deploy`, overlaid by anything already in the environment.
 * Never mutates `process.env` — callers pass what they need into the child they
 * are spawning, so a value cannot leak into a command that had no business
 * seeing it.
 */
export function deployEnv() {
  const fromFile = existsSync(DEPLOY_ENV_FILE) ? parse(readFileSync(DEPLOY_ENV_FILE, "utf8")) : {};
  const merged = { ...fromFile };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}
