#!/usr/bin/env node
/**
 * Build here, upload the build. `pnpm deploy:vercel`.
 *
 * `vercel.json` turns off git-triggered deployments, so this is the only way the
 * frontend ships. Three steps, in this order, and the first one is the one worth
 * understanding.
 *
 *   pull    fetch the project's production environment into `.vercel/`
 *   build   `next build`, which *inlines* every `NEXT_PUBLIC_*` value into the bundle
 *   deploy  upload the finished output, no remote build
 *
 * With a `CONVEX_DEPLOY_KEY` available the middle step grows a first half —
 * `convex deploy --cmd`, Convex's documented Vercel integration — so `convex/`
 * ships immediately before the build that talks to it. See the bottom of the
 * file. Everything below about the pull is true either way.
 *
 * The pull is not a formality. `NEXT_PUBLIC_*` values are baked into the
 * JavaScript at build time — by the time a browser has the file they are already
 * literals in it — so whichever machine builds has to hold them. That used to be
 * a Vercel builder with the project's own environment; now it is this laptop.
 * Skip the pull and the build silently falls back to `.env.local`, which points
 * at the *dev* Convex deployment, and the deployed app talks to the wrong
 * backend while looking completely fine.
 *
 * Which is why those three variables are stored `plain` rather than `sensitive`
 * on the Vercel project: a sensitive variable is never handed back, so it pulls
 * as an empty string and the build inlines nothing. They are public by
 * construction — two deployment URLs and a Clerk *publishable* key, all three
 * shipped inside the bundle to every visitor — so there is nothing to protect.
 * `CLERK_SECRET_KEY` and the rest stay sensitive: the server reads those at
 * runtime, from Vercel, and they never touch this machine.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { deployEnv } from "./env-deploy.mjs";

/** Pinned: this project belongs to the personal account and nothing else. */
const GLOBAL_CONFIG = ["--global-config", join(homedir(), ".vercel-accounts", "personal")];

function vercel(...args) {
  execFileSync("vercel", [...args, ...GLOBAL_CONFIG], { stdio: "inherit" });
}

vercel("pull", "--yes", "--environment=production");

/**
 * A pulled-but-empty public variable is the failure this guards, and it is
 * quiet: the build succeeds, the deployment goes live, and the app points at
 * whatever `.env.local` happened to say. Cheaper to fail here.
 */
const pulled = readFileSync(join(process.cwd(), ".vercel", ".env.production.local"), "utf8");
const empty = ["NEXT_PUBLIC_CONVEX_URL", "NEXT_PUBLIC_CONVEX_SITE_URL", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]
  .filter((key) => new RegExp(`^${key}=(""|''|)$`, "m").test(pulled));

if (empty.length > 0) {
  console.error(
    `\nThese pulled empty from the Vercel project: ${empty.join(", ")}.\n` +
      `They are almost certainly stored as "sensitive", which is never handed back, ` +
      `so the build would inline nothing. Recreate them with type "plain" — they are ` +
      `public values that ship in the bundle anyway.\n`,
  );
  process.exit(1);
}

/**
 * With a Convex production deploy key, the build is Convex's documented Vercel
 * integration: `convex deploy --cmd '<build>'` pushes `convex/` first, then runs
 * the build with the deployment's URL in the environment. Backend and frontend
 * go out together, in that order, and a backend that fails to deploy never
 * produces a build to upload — which is the whole point, because the two halves
 * shipping separately is how a frontend ends up calling a function that is not
 * there yet.
 *
 * The key comes from the shell or `.env.deploy`, never from Vercel: the build
 * runs here, and a sensitive Vercel variable pulls back empty (see
 * `scripts/env-deploy.mjs`). Without one this is exactly the script it was
 * before, and `convex/` has to be pushed separately.
 */
const deployKey = deployEnv().CONVEX_DEPLOY_KEY;

if (deployKey === undefined || deployKey === "") {
  console.log(
    "\nNote: no CONVEX_DEPLOY_KEY in the shell or .env.deploy, so this builds " +
      "the frontend only — run `pnpm deploy:deployed` to push convex/ as well.\n",
  );
  vercel("build", "--prod");
} else {
  execFileSync(
    "pnpm",
    [
      "exec",
      "convex",
      "deploy",
      "--cmd-url-env-var-name",
      "NEXT_PUBLIC_CONVEX_URL",
      "--cmd",
      "node scripts/vercel-build.mjs",
    ],
    // Spread rather than mutate, and never print it: the key is a credential
    // that can deploy code to the deployed environment.
    { stdio: "inherit", env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey } },
  );
}

vercel("deploy", "--prebuilt", "--prod");
