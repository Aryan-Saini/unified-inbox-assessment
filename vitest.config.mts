import { defineConfig } from "vitest/config";

/**
 * Convex functions are tested in `edge-runtime` rather than jsdom or node:
 * `convex-test` runs the real function bodies, and the Convex default runtime is
 * an edge-style V8 isolate. Testing them under Node would let a test pass on a
 * Node-only global that does not exist in production.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    // `convex-test` ships ESM that has to be transformed alongside our code.
    server: { deps: { inline: ["convex-test"] } },
    setupFiles: ["./vitest.setup.ts"],
    // The documentation tests live beside the documentation they describe, and
    // hold it against the real routing table — so they belong in the same run
    // as the backend tests rather than in a suite nobody remembers to invoke.
    include: ["convex/**/*.test.ts", "app/**/*.test.ts"],
  },
});
