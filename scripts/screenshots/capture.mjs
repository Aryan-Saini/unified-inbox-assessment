#!/usr/bin/env node
/**
 * Capture the stress harness at a phone width and a desktop width.
 *
 *   node scripts/screenshots/capture.mjs <out-dir> [--port 3210]
 *
 * Boots `next dev` on its own port, walks `/ui-stress?scene=…` at each viewport
 * and writes `<scene>-<viewport>.png` into the output directory. Everything on
 * those pages is a pure function of `stress-fixtures.ts`, so two runs across a
 * code change produce a genuine before/after pair.
 *
 * Needs the Chromium build once: `pnpm exec playwright install chromium`.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

/**
 * `act` runs after load and before the shot, for a state a URL cannot express.
 * It is skipped when it finds nothing, so the same list can be run against a
 * revision that predates the thing it reaches for — which is what makes a
 * before/after pair possible at all.
 */
const SCENES = [
  { scene: "results", name: "results" },
  {
    scene: "results",
    name: "results-sheet",
    only: "mobile",
    act: async (page) => {
      const label = page.locator('article span[role="button"]').first();
      if ((await label.count()) === 0) return false;
      await label.tap();
      return true;
    },
  },
  { scene: "compose", name: "compose" },
  { scene: "remove-confirm", name: "remove-confirm" },
];

const VIEWPORTS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
  desktop: { width: 1280, height: 900, deviceScaleFactor: 2, isMobile: false },
};

const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? "docs/screenshots/tmp");
const portFlag = args.indexOf("--port");
const port = portFlag === -1 ? 3210 : Number(args[portFlag + 1]);
const origin = `http://localhost:${port}`;

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/ui-stress?scene=results`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next dev never answered on ${origin}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const server = spawn(
    "node_modules/.bin/next",
    // No `--hostname`: Next 16 fronts the dev server with a proxy that dials
    // `localhost`, and pinning the inner server to 127.0.0.1 leaves the two
    // unable to reach each other on a dual-stack machine.
    ["dev", "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // `proxy.ts` runs `clerkMiddleware` on every request and throws without
        // a key, which takes the dev server down before the harness renders. A
        // syntactically valid test key is enough: `/ui-stress` is outside the
        // route map the proxy guards, so nothing here ever calls Clerk.
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
          process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
          "pk_test_aGFybmVzcy5jbGVyay5hY2NvdW50cy5kZXYk",
        CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY ?? "sk_test_harness",
        NEXT_PUBLIC_CONVEX_URL:
          process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://harness.convex.cloud",
      },
    },
  );
  server.stdout.on("data", (d) => process.stdout.write(`[next] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[next] ${d}`));

  try {
    await waitForServer();

    const browser = await chromium.launch();
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        isMobile: viewport.isMobile,
        hasTouch: viewport.isMobile,
        colorScheme: "dark",
        // Every avatar tier falls through to the monogram, so a capture does not
        // depend on the favicon service answering.
        offline: false,
      });
      // Block the favicon service outright, for the same reason.
      await context.route("https://www.google.com/**", (route) => route.abort());

      const page = await context.newPage();
      for (const shot of SCENES) {
        if (shot.only !== undefined && shot.only !== name) continue;
        await page.goto(`${origin}/ui-stress?scene=${shot.scene}`, {
          waitUntil: "networkidle",
        });
        // The entry animations (`rise-in`, `pop-in`) settle well inside this.
        await page.waitForTimeout(900);
        if (shot.act !== undefined) {
          if (!(await shot.act(page))) {
            console.log(`skip  ${shot.name}-${name} (nothing to act on)`);
            continue;
          }
          await page.waitForTimeout(600);
        }
        const file = path.join(outDir, `${shot.name}-${name}.png`);
        await page.screenshot({ path: file });
        console.log(`wrote ${path.relative(process.cwd(), file)}`);
      }
      await context.close();
    }
    await browser.close();
  } finally {
    server.kill("SIGTERM");
  }
}

await main();
