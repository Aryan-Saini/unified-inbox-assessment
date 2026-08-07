#!/usr/bin/env node
/**
 * Report horizontal overflow on the stress harness.
 *
 *   node scripts/screenshots/overflow.mjs [--port 3210]
 *
 * A capture only shows a bleed once something has already been pushed past the
 * right edge; this says *which element* is wider than the viewport, which is the
 * fact a fix needs. Prints one line per scene per viewport and exits non-zero
 * when anything overflows, so it can be used as a check rather than a read.
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";

const SCENES = ["results", "compose", "remove-confirm"];
const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 900 },
};

const args = process.argv.slice(2);
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

/**
 * Runs in the page: every element whose content is cut off on the right.
 *
 * "Cut off" rather than "past the viewport", because this shell is
 * `overflow-hidden` from the body down — a bleed here does not lengthen the
 * document, it just silently loses the end of a string at the screen edge, which
 * is exactly what a 254-character address did to the confirm dialog's title.
 *
 * The one thing that must *not* be reported is a deliberate ellipsis: `truncate`
 * is an overflowing string behind `overflow: hidden` by design. That is the only
 * exemption, and it is recognised by `text-overflow: ellipsis` on the box doing
 * the clipping — everything else that runs past its clipper is a defect.
 */
const PROBE = () => {
  const limit = document.documentElement.clientWidth;
  const out = [];

  /** The nearest ancestor that actually cuts this element off, if any. */
  const clipperOf = (el) => {
    for (let p = el.parentElement; p !== null; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        return { el: p, ellipsis: style.textOverflow === "ellipsis" };
      }
    }
    // Nothing clips it, so the viewport does.
    return null;
  };

  for (const el of document.querySelectorAll("body *")) {
    const box = el.getBoundingClientRect();
    if (box.width === 0) continue;

    const clipper = clipperOf(el);
    const edge =
      clipper === null
        ? limit
        : clipper.el.getBoundingClientRect().left + clipper.el.clientWidth;
    if (box.right <= edge + 1) continue;
    if (clipper?.ellipsis === true) continue;
    if (getComputedStyle(el).textOverflow === "ellipsis") continue;

    // Only the outermost offender: a child of an overflowing box is not news.
    const parent = el.parentElement;
    if (parent !== null && parent.getBoundingClientRect().right > edge + 1) {
      continue;
    }

    out.push({
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === "string" ? el.className.slice(0, 90) : "",
      cutBy: Math.round(box.right - edge),
      width: Math.round(box.width),
    });
  }
  return { limit, scrollWidth: document.documentElement.scrollWidth, out };
};

async function main() {
  const server = spawn("node_modules/.bin/next", ["dev", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
        "pk_test_aGFybmVzcy5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY ?? "sk_test_harness",
      NEXT_PUBLIC_CONVEX_URL:
        process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://harness.convex.cloud",
    },
  });

  let bad = 0;
  try {
    await waitForServer();
    const browser = await chromium.launch();
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport, colorScheme: "dark" });
      await context.route("https://www.google.com/**", (r) => r.abort());
      const page = await context.newPage();
      for (const scene of SCENES) {
        await page.goto(`${origin}/ui-stress?scene=${scene}`, {
          waitUntil: "networkidle",
        });
        await page.waitForTimeout(700);
        const report = await page.evaluate(PROBE);
        const overflow = report.scrollWidth - report.limit;
        if (report.out.length === 0 && overflow <= 0) {
          console.log(`ok   ${scene} @ ${name}`);
          continue;
        }
        bad += 1;
        console.log(
          `BLEED ${scene} @ ${name} — scrollWidth ${report.scrollWidth} vs ${report.limit}`,
        );
        for (const el of report.out) {
          console.log(`      <${el.tag}> w=${el.width} cut by ${el.cutBy}px .${el.className}`);
        }
      }
      await context.close();
    }
    await browser.close();
  } finally {
    server.kill("SIGTERM");
  }

  process.exitCode = bad === 0 ? 0 : 1;
}

await main();
