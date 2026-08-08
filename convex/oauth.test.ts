/// <reference types="vite/client" />
/**
 * The two reducers that stand between a caller-supplied value and an actual
 * redirect, plus the flow that carries their output.
 *
 * Both reducers are pure, so most of this tests them directly — and they are
 * tested at all because the failure is silent. An origin that slips through does
 * not throw; it just means the OAuth callback sends a browser wherever the caller
 * asked, and nothing in the app looks wrong until someone reads the redirect in a
 * proxy log. The final block drives `begin` and `consumeState` for real, because a
 * value that is validated and then dropped on the floor is the other way this
 * breaks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resolveAppOrigin, sanitizeReturnTo } from "./oauth";
import { insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");

const ENV_KEYS = [
  "APP_BASE_URL",
  "APP_ORIGIN_ALLOWLIST",
  "ALLOW_PRIVATE_NETWORK_ORIGINS",
  "ALLOW_CODESPACES_ORIGINS",
] as const;

/** Restore whatever the runner had, so these tests cannot leak into others. */
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveAppOrigin — loopback", () => {
  beforeEach(() => {
    // Deliberately a port the dev server is not on, to prove the allowlist is
    // not what lets localhost through.
    process.env.APP_BASE_URL = "http://localhost:3000";
    delete process.env.APP_ORIGIN_ALLOWLIST;
  });

  it("allows any port, which is the whole point", () => {
    expect(resolveAppOrigin("http://localhost:3001")).toBe("http://localhost:3001");
    expect(resolveAppOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(resolveAppOrigin("http://127.0.0.1:3002")).toBe("http://127.0.0.1:3002");
    expect(resolveAppOrigin("http://[::1]:3003")).toBe("http://[::1]:3003");
  });

  it("returns an origin, dropping any path, query or fragment", () => {
    expect(resolveAppOrigin("http://localhost:3001/dashboard?a=1#x")).toBe(
      "http://localhost:3001",
    );
  });

  it("does not treat a lookalike host as loopback", () => {
    // The bug this catches: matching by substring instead of by hostname.
    expect(resolveAppOrigin("http://localhost.evil.test")).toBeUndefined();
    expect(resolveAppOrigin("http://notlocalhost")).toBeUndefined();
    expect(resolveAppOrigin("http://127.0.0.1.evil.test")).toBeUndefined();
  });
});

describe("resolveAppOrigin — private network", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    delete process.env.APP_ORIGIN_ALLOWLIST;
  });

  it("is off unless the flag is exactly \"true\"", () => {
    // The regression that motivated all of this: a phone on the LAN was sent to
    // APP_BASE_URL, i.e. its own localhost.
    delete process.env.ALLOW_PRIVATE_NETWORK_ORIGINS;
    expect(resolveAppOrigin("https://10.0.0.124:3000")).toBeUndefined();

    for (const value of ["", "false", "1", "yes", "TRUE"]) {
      process.env.ALLOW_PRIVATE_NETWORK_ORIGINS = value;
      expect(resolveAppOrigin("https://10.0.0.124:3000")).toBeUndefined();
    }
  });

  describe("with the flag on", () => {
    beforeEach(() => {
      process.env.ALLOW_PRIVATE_NETWORK_ORIGINS = "true";
    });

    it("allows every private IPv4 range, on any port", () => {
      expect(resolveAppOrigin("https://10.0.0.124:3000")).toBe("https://10.0.0.124:3000");
      expect(resolveAppOrigin("http://192.168.1.5:5173")).toBe("http://192.168.1.5:5173");
      expect(resolveAppOrigin("http://172.16.0.1:3000")).toBe("http://172.16.0.1:3000");
      expect(resolveAppOrigin("http://172.31.255.254:3000")).toBe(
        "http://172.31.255.254:3000",
      );
      expect(resolveAppOrigin("http://169.254.10.1:3000")).toBe("http://169.254.10.1:3000");
    });

    it("allows link-local and unique-local IPv6, and mDNS names", () => {
      expect(resolveAppOrigin("http://[fe80::1]:3000")).toBe("http://[fe80::1]:3000");
      expect(resolveAppOrigin("http://[fd12:3456::1]:3000")).toBe(
        "http://[fd12:3456::1]:3000",
      );
      expect(resolveAppOrigin("https://aryans-mac.local:3000")).toBe(
        "https://aryans-mac.local:3000",
      );
    });

    it("still refuses public addresses", () => {
      // The neighbours of each private range, which an off-by-one lets through.
      expect(resolveAppOrigin("https://11.0.0.1:3000")).toBeUndefined();
      expect(resolveAppOrigin("https://9.255.255.255:3000")).toBeUndefined();
      expect(resolveAppOrigin("https://172.15.0.1:3000")).toBeUndefined();
      expect(resolveAppOrigin("https://172.32.0.1:3000")).toBeUndefined();
      expect(resolveAppOrigin("https://192.169.1.1:3000")).toBeUndefined();
      expect(resolveAppOrigin("https://8.8.8.8")).toBeUndefined();
      expect(resolveAppOrigin("https://evil.test")).toBeUndefined();
      expect(resolveAppOrigin("https://[2606:4700::1111]")).toBeUndefined();
    });

    it("does not treat a lookalike host as private", () => {
      // A name that merely starts like an address is a name, and DNS will happily
      // point it at anything. This is the substring bug again, one range over.
      expect(resolveAppOrigin("https://10.0.0.124.evil.test")).toBeUndefined();
      expect(resolveAppOrigin("https://192.168.1.1.evil.test")).toBeUndefined();
      expect(resolveAppOrigin("https://evil.test/10.0.0.1")).toBeUndefined();
      expect(resolveAppOrigin("https://10.0.0.1.local.evil.test")).toBeUndefined();
      // Octets that are not octets.
      expect(resolveAppOrigin("https://10.0.0.999")).toBeUndefined();
      expect(resolveAppOrigin("https://010.0.0.1x")).toBeUndefined();
    });

    it("judges the address URL parsed, not the string that was typed", () => {
      // `URL` expands IPv4 shorthand before we ever see it, so `10.0.0` really is
      // 10.0.0.0 and belongs in the range. Asserting the parsed form keeps this
      // honest rather than looking like an accident.
      expect(resolveAppOrigin("https://10.0.0")).toBe("https://10.0.0.0");
      expect(resolveAppOrigin("https://192.168.257")).toBe("https://192.168.1.1");
    });
  });
});

describe("resolveAppOrigin — GitHub Codespaces", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    delete process.env.APP_ORIGIN_ALLOWLIST;
    process.env.ALLOW_CODESPACES_ORIGINS = "true";
  });

  afterEach(() => {
    delete process.env.ALLOW_CODESPACES_ORIGINS;
  });

  it("is off unless the flag is exactly \"true\"", () => {
    // Every Codespaces tenant shares `app.github.dev`, so a deployment that has
    // not opted in must not return to one.
    delete process.env.ALLOW_CODESPACES_ORIGINS;
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
      ),
    ).toBeUndefined();

    process.env.ALLOW_CODESPACES_ORIGINS = "TRUE";
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
      ),
    ).toBeUndefined();
  });

  it("allows an HTTPS forwarded-port origin when the flag is set", () => {
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
      ),
    ).toBe(
      "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
    );
  });

  it("returns only the origin", () => {
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev/dashboard?a=1#x",
      ),
    ).toBe(
      "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
    );
  });

  it("refuses insecure, malformed and lookalike Codespaces origins", () => {
    expect(
      resolveAppOrigin(
        "http://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
      ),
    ).toBeUndefined();
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-preview.app.github.dev",
      ),
    ).toBeUndefined();
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev.evil.test",
      ),
    ).toBeUndefined();
    expect(
      resolveAppOrigin(
        "https://evil.automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev",
      ),
    ).toBeUndefined();
    expect(
      resolveAppOrigin(
        "https://automatic-fortnight-4jq59jwqx9gx3jp9-3000.app.github.dev:8443",
      ),
    ).toBeUndefined();
  });
});

describe("resolveAppOrigin — registered origins", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "https://inbox.example";
    process.env.APP_ORIGIN_ALLOWLIST =
      " https://preview.example , https://alt.example/ ,, ";
  });

  it("allows APP_BASE_URL", () => {
    expect(resolveAppOrigin("https://inbox.example")).toBe("https://inbox.example");
  });

  it("allows allowlist entries, ignoring whitespace and empty slots", () => {
    expect(resolveAppOrigin("https://preview.example")).toBe("https://preview.example");
    expect(resolveAppOrigin("https://alt.example")).toBe("https://alt.example");
  });

  it("compares by origin, so a trailing slash is not a different site", () => {
    // `alt.example` is written with a trailing slash in the env var above.
    expect(resolveAppOrigin("https://alt.example/")).toBe("https://alt.example");
  });

  it("refuses anything unregistered", () => {
    expect(resolveAppOrigin("https://evil.test")).toBeUndefined();
    // A registered origin is not a licence for its subdomains or its siblings.
    expect(resolveAppOrigin("https://evil.inbox.example")).toBeUndefined();
    expect(resolveAppOrigin("https://inbox.example.evil.test")).toBeUndefined();
    // Same host, different scheme and port are different origins.
    expect(resolveAppOrigin("http://inbox.example")).toBeUndefined();
    expect(resolveAppOrigin("https://inbox.example:8443")).toBeUndefined();
  });

  it("drops an unparseable allowlist entry without widening the rest", () => {
    process.env.APP_ORIGIN_ALLOWLIST = "not a url, https://ok.example";
    expect(resolveAppOrigin("https://ok.example")).toBe("https://ok.example");
    expect(resolveAppOrigin("https://evil.test")).toBeUndefined();
  });
});

describe("resolveAppOrigin — malformed input", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "https://inbox.example";
    delete process.env.APP_ORIGIN_ALLOWLIST;
  });

  it("refuses a non-http scheme", () => {
    expect(resolveAppOrigin("javascript:alert(1)")).toBeUndefined();
    expect(resolveAppOrigin("data:text/html,<h1>hi")).toBeUndefined();
    expect(resolveAppOrigin("file:///etc/passwd")).toBeUndefined();
  });

  it("refuses anything that is not a URL at all", () => {
    expect(resolveAppOrigin("//evil.test")).toBeUndefined();
    expect(resolveAppOrigin("/dashboard")).toBeUndefined();
    expect(resolveAppOrigin("evil.test")).toBeUndefined();
    expect(resolveAppOrigin("")).toBeUndefined();
    expect(resolveAppOrigin(undefined)).toBeUndefined();
  });

  it("refuses an absurdly long value rather than parsing it", () => {
    expect(resolveAppOrigin(`https://a${"a".repeat(300)}.test`)).toBeUndefined();
  });

  it("falls back cleanly when no origin is configured at all", () => {
    delete process.env.APP_BASE_URL;
    expect(resolveAppOrigin("https://inbox.example")).toBeUndefined();
    // Loopback does not depend on configuration, so it still resolves.
    expect(resolveAppOrigin("http://localhost:3001")).toBe("http://localhost:3001");
  });
});

describe("the origin survives the flow", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.SLACK_CLIENT_ID = "test.client";
    process.env.CONVEX_SITE_URL = "https://example.convex.site";
    delete process.env.APP_ORIGIN_ALLOWLIST;
  });

  /** Start a Slack flow (no PKCE to stub) and hand back its `state`. */
  async function beginSlack(origin?: string) {
    const t = convexTest(schema, modules);
    await insertUser(t, "owner");
    const owner = t.withIdentity({ subject: "owner", tokenIdentifier: "test|owner" });
    const { url } = await owner.mutation(api.oauth.begin, {
      provider: "slack",
      returnTo: "/dashboard",
      origin,
    });
    const state = new URL(url).searchParams.get("state") as string;
    return { t, state };
  }

  /**
   * Consume and narrow. Asserting on the union directly is a trap: Convex omits
   * absent optional fields entirely, so `toMatchObject({ appOrigin: undefined })`
   * fails against a row that correctly has no origin at all.
   */
  async function consume(t: Awaited<ReturnType<typeof beginSlack>>["t"], state: string) {
    const consumed = await t.mutation(internal.oauth.consumeState, {
      state,
      provider: "slack",
    });
    if (!consumed.ok) throw new Error(`state was not consumed: ${consumed.error}`);
    return consumed;
  }

  it("hands an allowed origin back to the callback", async () => {
    // 3001, while APP_BASE_URL says 3000 — the exact mismatch this exists for.
    const { t, state } = await beginSlack("http://localhost:3001");
    const consumed = await consume(t, state);
    expect(consumed.returnTo).toBe("/dashboard");
    expect(consumed.appOrigin).toBe("http://localhost:3001");
  });

  it("stores nothing for a hostile origin, so the callback falls back", async () => {
    const { t, state } = await beginSlack("https://evil.test");
    const row = await t.run(async (ctx) =>
      await ctx.db.query("oauthStates").withIndex("by_state", (q) => q.eq("state", state)).unique(),
    );
    expect(row?.appOrigin).toBeUndefined();
    expect((await consume(t, state)).appOrigin).toBeUndefined();
  });

  it("omitting the origin keeps the old behaviour", async () => {
    const { t, state } = await beginSlack(undefined);
    expect((await consume(t, state)).appOrigin).toBeUndefined();
  });

  it("re-checks on the way out, so a row written under looser rules is still caught", async () => {
    const { t, state } = await beginSlack("http://localhost:3001");
    // Simulate a row from a deploy whose allowlist included an origin this one
    // does not: the value is in the database, and must still be refused.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (q) => q.eq("state", state))
        .unique();
      await ctx.db.patch("oauthStates", row!._id, { appOrigin: "https://evil.test" });
    });

    expect((await consume(t, state)).appOrigin).toBeUndefined();
  });
});

describe("the callback redirects to the resolved origin", () => {
  beforeEach(() => {
    // The mismatch this whole mechanism exists for: the deployment is configured
    // for :3000 while the browser is actually on :3001.
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.SLACK_CLIENT_ID = "test.client";
    process.env.SLACK_CLIENT_SECRET = "test.secret";
    process.env.CONVEX_SITE_URL = "https://example.convex.site";
    delete process.env.APP_ORIGIN_ALLOWLIST;
  });

  /**
   * Cancel the consent screen and read the `Location` header.
   *
   * `access_denied` is the cheapest path through the callback that still uses the
   * stored origin — no token exchange to fake, no grant to store, and it is
   * exactly what a user pressing Cancel produces.
   */
  async function cancelledFlowLocation(origin?: string): Promise<string> {
    const t = convexTest(schema, modules);
    await insertUser(t, "owner");
    const owner = t.withIdentity({ subject: "owner", tokenIdentifier: "test|owner" });
    const { url } = await owner.mutation(api.oauth.begin, {
      provider: "slack",
      returnTo: "/dashboard",
      origin,
    });
    const state = new URL(url).searchParams.get("state") as string;

    const response = await t.fetch(
      `/oauth/slack/callback?state=${state}&error=access_denied`,
      { method: "GET" },
    );
    expect(response.status).toBe(302);
    return response.headers.get("location") as string;
  }

  it("returns to the browser's port, not the configured one", async () => {
    expect(await cancelledFlowLocation("http://localhost:3001")).toBe(
      "http://localhost:3001/dashboard?oauth_error=access_denied",
    );
  });

  it("falls back to APP_BASE_URL when the origin was refused", async () => {
    expect(await cancelledFlowLocation("https://evil.test")).toBe(
      "http://localhost:3000/dashboard?oauth_error=access_denied",
    );
  });

  it("falls back to APP_BASE_URL when no origin was proposed", async () => {
    expect(await cancelledFlowLocation(undefined)).toBe(
      "http://localhost:3000/dashboard?oauth_error=access_denied",
    );
  });

  it("has no origin to use before the state is read", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/oauth/slack/callback?error=access_denied", {
      method: "GET",
    });
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/?oauth_error=missing_state",
    );
  });
});

describe("sanitizeReturnTo", () => {
  it("keeps a plain path", () => {
    expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
    expect(sanitizeReturnTo("/dashboard?connected=gmail")).toBe(
      "/dashboard?connected=gmail",
    );
  });

  it("reduces anything that could leave the origin to the root", () => {
    expect(sanitizeReturnTo("//evil.test")).toBe("/");
    expect(sanitizeReturnTo("https://evil.test")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.test")).toBe("/");
    expect(sanitizeReturnTo("dashboard")).toBe("/");
    expect(sanitizeReturnTo(`/${"a".repeat(600)}`)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
    expect(sanitizeReturnTo(undefined)).toBe("/");
  });

  /**
   * Regression: the WHATWG URL parser strips tab, CR and LF *before* parsing, so
   * `"/\t/evil.test"` is not the path it appears to be — it resolved to
   * `https://evil.test/`, an open redirect off our own OAuth domain, while
   * passing every other check. The assertion is written against `new URL` rather
   * than against the return value alone, because the parser's behaviour is the
   * thing that made this exploitable.
   */
  it("refuses control characters that the URL parser would strip", () => {
    // tab, LF, CR, NUL — written as escapes so the bytes survive any editor.
    for (const raw of ["\u0009", "\u000a", "\u000d", "\u0000"]) {
      const attack = `/${raw}/evil.test/x`;
      expect(sanitizeReturnTo(attack)).toBe("/");
      expect(new URL(sanitizeReturnTo(attack), "https://app.example").origin).toBe(
        "https://app.example",
      );
    }
  });
});
