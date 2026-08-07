/**
 * The tests that keep the documentation honest.
 *
 * Documentation rots in one of two ways, and both are covered here. It drifts
 * from the code — a route added, a field renamed, and the page keeps describing
 * the old shape. Or it drifts from *itself* — the HTML says one thing, the
 * markdown another, and the OpenAPI a third.
 *
 * The second is structurally impossible: all three renderings come out of
 * `spec.ts` and `guide.ts`. This file covers the first, by comparing the
 * documented endpoint list against the real routing table in
 * `convex/api/routes.ts` and the documented `Result` against the validator the
 * backend enforces at runtime.
 */

import { describe, expect, it } from "vitest";
import { ROUTES } from "../../../convex/api/routes";
import { publicResult } from "../../../convex/api/views";
import { MAX_SEND_ATTEMPTS } from "../../../convex/sends";
import { renderAgentsMd, renderFull, renderIndex } from "./markdown";
import { openApiDocument } from "./openapi";
import {
  BASE_URL_PLACEHOLDER,
  ENDPOINTS,
  ERROR_CODES,
  SCHEMAS,
  SECTIONS,
  resolveBaseUrl,
} from "./spec";

const ORIGIN = "https://docs.test";

/** `/searches/{id}/results` (OpenAPI) -> `/searches/:id/results` (the router). */
function toRouterPattern(path: string): string {
  return path.replace(/\{(\w+)\}/g, ":$1");
}

describe("the documented surface matches the real one", () => {
  const documented = new Set(ENDPOINTS.map((e) => `${e.method} ${toRouterPattern(e.path)}`));
  const actual = new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`));

  it("documents every route the API serves", () => {
    expect([...actual].filter((route) => !documented.has(route))).toEqual([]);
  });

  it("documents no route the API does not serve", () => {
    expect([...documented].filter((route) => !actual.has(route))).toEqual([]);
  });

  it("gives every endpoint a unique id, since ids are page anchors", () => {
    const ids = ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the base URL survives a deployment that only sets the cloud URL", () => {
  // The failure this guards is silent and lands on the one reader the page is
  // for: nothing sets `NEXT_PUBLIC_CONVEX_SITE_URL` on a deployed frontend, and
  // without the fallback every example would read `<deployment>.convex.site`.
  it("derives the site origin from the cloud origin", () => {
    expect(resolveBaseUrl(undefined, "https://scintillating-moose-307.convex.cloud")).toBe(
      "https://scintillating-moose-307.convex.site",
    );
  });

  it("prefers an explicit site URL, without a trailing slash", () => {
    expect(
      resolveBaseUrl("https://explicit.convex.site/", "https://other.convex.cloud"),
    ).toBe("https://explicit.convex.site");
  });

  it("falls back to the placeholder when neither is set", () => {
    expect(resolveBaseUrl(undefined, undefined)).toBe(BASE_URL_PLACEHOLDER);
    expect(resolveBaseUrl("", "http://127.0.0.1:3210")).toBe(BASE_URL_PLACEHOLDER);
  });
});

describe("Result stays exactly the specified seven fields", () => {
  it("documents the same field names the response validator enforces", () => {
    // The validator is the runtime contract — Convex checks every response
    // against it — so this is the documentation being held to the code, not the
    // other way round.
    const enforced = Object.keys(publicResult.fields).sort();
    const documented = SCHEMAS.Result.fields.map((f) => f.name).sort();

    expect(documented).toEqual(enforced);
    expect(documented).toHaveLength(7);
  });
});

describe("examples are real", () => {
  it("parses every example body as JSON", () => {
    for (const endpoint of ENDPOINTS) {
      expect(() => JSON.parse(endpoint.example), endpoint.id).not.toThrow();
    }
  });

  it("quotes the real retry ceiling in every send example", () => {
    // This one shipped wrong: four examples said `"max_attempts": 5` while the
    // constant was 4. A reader sizing their own retry budget off the docs would
    // have waited for a fifth attempt that never comes. Constants that appear
    // inside worked examples are exactly where docs rot invisibly, so the
    // example is now checked against the constant rather than against a memory
    // of it.
    for (const endpoint of ENDPOINTS) {
      const body = JSON.parse(endpoint.example) as Record<string, unknown> & {
        sends?: Record<string, unknown>[];
      };
      const rows = [body, ...(body.sends ?? [])];
      for (const row of rows) {
        if (!("max_attempts" in row)) continue;
        expect(row.max_attempts, endpoint.id).toBe(MAX_SEND_ATTEMPTS);
      }
    }
  });

  it("uses a review_hash that is genuinely the digest of its canonical_payload", async () => {
    // The worked example is what a reader copies to check their own client
    // against, so a made-up hash beside a real payload would be actively
    // misleading. Verified with the same SHA-256 the API uses.
    const draft = JSON.parse(
      ENDPOINTS.find((e) => e.id === "getDraft")!.example,
    ) as { canonical_payload: string; review_hash: string };

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(draft.canonical_payload),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    expect(hex).toBe(draft.review_hash);
  });
});

describe("the OpenAPI document", () => {
  const doc = openApiDocument(ORIGIN) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, unknown> };
  };

  it("gives every success response a schema", () => {
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) >= 300) continue;
          const schema = (response as { content: Record<string, { schema?: unknown }> })
            .content["application/json"].schema;
          expect(schema, `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
        }
      }
    }
  });

  it("resolves every $ref", () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map(
      (match) => match[1],
    );

    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
  });

  it("enumerates the same error codes the reference table lists", () => {
    const error = doc.components.schemas.Error as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };
    expect(error.properties.error.properties.code.enum).toEqual(
      ERROR_CODES.map((e) => e.code),
    );
  });
});

describe("the machine-readable copies carry the rules that matter", () => {
  const documents = {
    "llms.txt": renderIndex(ORIGIN),
    "llms-full.txt": renderFull(ORIGIN),
    "AGENTS.md": renderAgentsMd(ORIGIN),
  };

  // An agent may read only one of these. Each has to be able to stop a bad send
  // on its own, so the two non-negotiable rules appear in all three rather than
  // only in the longest.
  for (const [name, body] of Object.entries(documents)) {
    it(`${name} states the acknowledgement rule`, () => {
      expect(body).toContain("acknowledged_destination");
    });

    it(`${name} forbids retrying an unknown send`, () => {
      expect(body.toLowerCase()).toContain("never retry");
      expect(body).toContain("INDETERMINATE");
    });

    it(`${name} names every route`, () => {
      for (const endpoint of ENDPOINTS) {
        expect(body, `${name} is missing ${endpoint.id}`).toContain(endpoint.path);
      }
    });

    it(`${name} points only at the origin it was rendered for`, () => {
      expect(body).not.toContain("<this-app-origin>");
      expect(body).not.toContain("undefined/documentation");
    });
  }

  it("renders the full document with every reference section", () => {
    const full = documents["llms-full.txt"];
    for (const section of SECTIONS) expect(full).toContain(`## ${section.title}`);
    for (const name of Object.keys(SCHEMAS)) expect(full).toContain(`### \`${name}\``);
  });
});
