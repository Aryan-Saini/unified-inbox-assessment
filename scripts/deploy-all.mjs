#!/usr/bin/env node
/**
 * The whole deploy, in one command. `pnpm deploy`.
 *
 *   0. preflight   check that the verification can run — before anything ships
 *   1. convex      push `convex/` to the hand-in deployment
 *   2. frontend    build here, upload the build
 *   3. verify      use the deployed system and prove it works
 *
 * Stage 0 exists because the alternative is discovering that the smoke
 * credentials are missing *after* a deployment is already live and unverified.
 * Everything the pipeline needs is known before it starts, so it is checked
 * before it starts.
 *
 * Stage 1 disappears into stage 2 when a `CONVEX_DEPLOY_KEY` is available: with
 * one, `deploy-vercel.mjs` uses Convex's documented `convex deploy --cmd`
 * integration, which pushes the backend and then builds the frontend against
 * that exact deployment. Running `deploy:handin` first as well would just deploy
 * `convex/` twice.
 *
 * The first stage to fail stops the run and says which one it was. There is no
 * rollback — Convex keeps the previous functions until a push succeeds, and a
 * failed Vercel build never becomes a deployment, so a failure part-way leaves
 * the last good deployment serving.
 *
 * Configuration lives in `.env.deploy` (git-ignored) or the shell.
 * `pnpm deploy -- --dry-run` prints the plan and touches nothing — the `--` is
 * needed because pnpm keeps a bare `--dry-run` for itself.
 */

import { execFileSync } from "node:child_process";

import { DEPLOY_ENV_FILE, deployEnv } from "./env-deploy.mjs";

const dryRun = process.argv.includes("--dry-run");
const env = deployEnv();

/** The deployment this pipeline exists to ship. Not configurable by accident. */
const HANDIN_BASE_URL = "https://scintillating-moose-307.convex.site";

/* ------------------------------------------------------------- 0. preflight */

const smoke = {
  BASE_URL: env.SMOKE_BASE_URL ?? HANDIN_BASE_URL,
  API_KEY: env.SMOKE_API_KEY,
  RECIPIENT: env.SMOKE_RECIPIENT,
  APP_URL: env.SMOKE_APP_URL,
  N: env.SMOKE_N,
};

const missing = ["API_KEY", "RECIPIENT"].filter((name) => (smoke[name] ?? "") === "");

if (missing.length > 0) {
  console.error(
    `\nSTAGE 0 (preflight) FAILED — nothing was deployed.\n\n` +
      `Missing: ${missing.map((name) => `SMOKE_${name}`).join(", ")}.\n\n` +
      `The pipeline verifies what it ships, so it will not ship without the\n` +
      `credentials to do that. Put these in ${DEPLOY_ENV_FILE} (git-ignored) or\n` +
      `export them:\n\n` +
      `  SMOKE_API_KEY     a uik_… key for the account to verify. Create it in\n` +
      `                    the deployed app under Settings → API keys — it is\n` +
      `                    shown once.\n` +
      `  SMOKE_RECIPIENT   where the double-tap sends its one real message: an\n` +
      `                    email address for Gmail, a channel for Slack. Use one\n` +
      `                    you can open, because the last check is you looking.\n` +
      `  SMOKE_APP_URL     optional, the deployed Vercel URL. With it, the docs\n` +
      `                    surface is checked too.\n` +
      `  SMOKE_BASE_URL    optional, defaults to ${HANDIN_BASE_URL}.\n` +
      `  SMOKE_N           optional, parallel sends in the double-tap (default 10).\n\n` +
      `To deploy without verifying, run the stages by hand:\n` +
      `  pnpm deploy:handin && pnpm deploy:vercel\n`,
  );
  process.exit(1);
}

/**
 * Stage 3 is TypeScript run by `node` directly, which needs the type-stripping
 * that landed unflagged in 22.18. Checked here rather than in stage 3, where it
 * would surface as a syntax error after everything was already deployed.
 */
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18)) {
  console.error(
    `\nSTAGE 0 (preflight) FAILED — nothing was deployed.\n\n` +
      `Node ${process.versions.node} cannot run scripts/verify-deploy.ts directly; ` +
      `22.18 or newer strips types without a flag. Upgrade Node, or deploy by hand ` +
      `and verify with \`pnpm exec tsx scripts/verify-deploy.ts\`.\n`,
  );
  process.exit(1);
}

const convexInBuild = (env.CONVEX_DEPLOY_KEY ?? "") !== "";

console.log(
  `\nPlan\n` +
    `  1. convex    ${convexInBuild ? "folded into the build (CONVEX_DEPLOY_KEY is set)" : "pnpm deploy:handin"}\n` +
    `  2. frontend  pnpm deploy:vercel${convexInBuild ? "  → convex deploy --cmd 'node scripts/vercel-build.mjs'" : ""}\n` +
    `  3. verify    ${smoke.BASE_URL}${smoke.APP_URL === undefined ? "" : ` and ${smoke.APP_URL}`}\n`,
);

if (dryRun) {
  console.log("--dry-run: stopping here. Nothing was deployed.\n");
  process.exit(0);
}

/* ------------------------------------------------------------ 1..3. the run */

/** Run one stage. Anything it exits non-zero on ends the pipeline, loudly. */
function stage(number, name, command, args, extraEnv = {}) {
  console.log(`\n\u001b[1m== stage ${number}: ${name}\u001b[0m\n`);
  try {
    execFileSync(command, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  } catch {
    console.error(
      `\n\u001b[1mSTAGE ${number} (${name}) FAILED.\u001b[0m Stopping here — later stages did not run.\n` +
        (number === 3
          ? `The deployment is live but unverified. Fix it and re-run \`pnpm verify:deploy\`, ` +
            `or deploy the previous commit again.\n`
          : `Nothing after this point shipped.\n`),
    );
    process.exit(1);
  }
}

if (convexInBuild) {
  console.log("\nstage 1: skipped — convex/ is pushed by the build in stage 2.");
} else {
  stage(1, "convex → hand-in", "pnpm", ["deploy:handin"]);
}

stage(2, "frontend build + upload", "pnpm", ["deploy:vercel"]);

// The flag only silences Node's "this .ts file has no `type` in package.json"
// notice, which is true, expected, and not something a deploy log should shout.
const verifyArgs = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/verify-deploy.ts"];

stage(3, "post-deploy verification", process.execPath, verifyArgs, {
  BASE_URL: smoke.BASE_URL,
  API_KEY: smoke.API_KEY,
  RECIPIENT: smoke.RECIPIENT,
  ...(smoke.APP_URL === undefined ? {} : { APP_URL: smoke.APP_URL }),
  ...(smoke.N === undefined ? {} : { N: smoke.N }),
});

console.log("\n\u001b[1mDeployed and verified.\u001b[0m\n");
