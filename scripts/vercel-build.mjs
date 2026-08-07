#!/usr/bin/env node
/**
 * The build step, as `convex deploy --cmd` runs it. Not meant to be run by hand.
 *
 * Convex's documented Vercel integration is `npx convex deploy --cmd 'npm run
 * build'`: Convex pushes the backend, then runs the build with the deployment's
 * URL in the environment, so the bundle cannot be built against one backend and
 * shipped next to another. This repo's build is `vercel build --prod` rather
 * than `next build`, because the deploy that follows is `--prebuilt` and needs
 * Vercel's own output directory — otherwise the pattern is theirs unchanged.
 *
 * The one addition is the check below. `vercel build` supplies the build with
 * the *pulled* environment, so the value Convex just injected and the value the
 * Vercel project holds are two answers to the same question, and Vercel's is the
 * one that ends up in the bundle. Agreeing is the normal case; disagreeing means
 * the deploy key and the Vercel project point at different Convex deployments,
 * which produces a perfectly healthy app talking to the wrong backend. That is
 * the exact failure `deploy-vercel.mjs` already refuses to ship, so refuse here.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const injected = process.env.NEXT_PUBLIC_CONVEX_URL;
if (injected === undefined || injected === "") {
  console.error(
    "\nNEXT_PUBLIC_CONVEX_URL is not set. This script is the `--cmd` of " +
      "`convex deploy`, which sets it; run `pnpm deploy:vercel` instead.\n",
  );
  process.exit(1);
}

const pulled = readFileSync(join(process.cwd(), ".vercel", ".env.production.local"), "utf8");

/** One value out of the pulled env file, quotes off. */
function pulledValue(key) {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(pulled);
  const raw = match?.[1]?.trim() ?? "";
  return /^(".*"|'.*')$/s.test(raw) ? raw.slice(1, -1) : raw;
}

// The site URL is the same deployment with a different suffix, so checking it
// costs nothing and catches a project that was half-repointed.
const expected = {
  NEXT_PUBLIC_CONVEX_URL: injected,
  NEXT_PUBLIC_CONVEX_SITE_URL: injected.replace(".convex.cloud", ".convex.site"),
};

const disagreements = Object.entries(expected)
  .filter(([key, value]) => pulledValue(key) !== value)
  .map(([key, value]) => `  ${key}: Vercel says ${pulledValue(key) || "(empty)"}, Convex just deployed ${value}`);

if (disagreements.length > 0) {
  console.error(
    `\nThe Convex deploy key and the Vercel project disagree about which ` +
      `deployment this is:\n\n${disagreements.join("\n")}\n\n` +
      `Vercel's values are the ones that get inlined into the bundle, so this ` +
      `would ship a frontend pointed at a backend that was not just deployed. ` +
      `Fix whichever is wrong — the deploy key in .env.deploy, or the project's ` +
      `environment on Vercel — and run it again.\n`,
  );
  process.exit(1);
}

execFileSync("vercel", ["build", "--prod", "--global-config", join(homedir(), ".vercel-accounts", "personal")], {
  stdio: "inherit",
});
