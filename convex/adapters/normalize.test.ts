/**
 * Normalisation unit tests.
 *
 * These cover the pure half of the adapter layer — the part where a provider's
 * shape becomes the common `Result` — because that is where the mistakes are
 * silent. A Slack timestamp off by a factor of a thousand does not throw; it
 * just sorts every Slack message to 1970 and nobody notices until a demo.
 *
 * The provider-call half (auth, error classification, retries) is covered by the
 * convex-test suites that drive whole functions against a fake fetch.
 */

import { describe, expect, it } from "vitest";
import { stripMrkdwn, tsToIso } from "./slack";
import { webAdapter, webProvider, webSourceLabel } from "./web";
import { scoreResult } from "../core/rank";

const ctx = {
  limit: 20,
  signal: new AbortController().signal,
};

describe("Slack ts", () => {
  it("reads seconds.micros, not milliseconds", () => {
    // 1712345678 is April 2024. Treated as milliseconds it would be 1970-01-20,
    // which is the bug this test exists to catch.
    const iso = tsToIso("1712345678.000200");
    expect(iso).toBe("2024-04-05T19:34:38.000Z");
    expect(new Date(iso as string).getUTCFullYear()).toBe(2024);
  });

  it("ignores a ts it cannot read rather than inventing one", () => {
    expect(tsToIso(undefined)).toBeUndefined();
    expect(tsToIso("not-a-ts")).toBeUndefined();
    expect(tsToIso("0")).toBeUndefined();
  });
});

describe("Slack mrkdwn", () => {
  it("renders mentions, channels and links as text", () => {
    expect(
      stripMrkdwn(
        "hey <@U04AB|ada> see <#C01|deals> and <https://example.test/x|the deck>",
      ),
    ).toBe("hey @ada see #deals and the deck");
  });

  it("falls back to the id when a mention carries no name", () => {
    expect(stripMrkdwn("ping <@U04AB>")).toBe("ping @U04AB");
  });

  it("keeps a bare link as its url", () => {
    expect(stripMrkdwn("<https://example.test/x>")).toBe("https://example.test/x");
  });

  it("unescapes the three entities Slack escapes, and only those", () => {
    expect(stripMrkdwn("a &lt;b&gt; &amp; c &quot;d&quot;")).toBe(
      'a <b> & c &quot;d&quot;',
    );
  });
});

describe("web adapter", () => {
  it("falls back to the labelled mock when no key is configured", async () => {
    // vitest.setup.ts leaves WEB_SEARCH_API_KEY unset on purpose: a fresh clone
    // must be able to search all three sources with no signups.
    expect(webProvider()).toBe("mock");
    expect(webSourceLabel()).toContain("mock");
  });

  it("is deterministic and labels every result as mock", async () => {
    const first = await webAdapter.search("quarterly pricing", ctx);
    const second = await webAdapter.search("quarterly pricing", ctx);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(3);
    for (const result of first) {
      expect(result.title.startsWith("[mock] ")).toBe(true);
      expect(result.url.startsWith("https://")).toBe(true);
      // Web results carry no trustworthy date, so they carry none at all.
      expect(result.timestamp).toBeUndefined();
    }
  });

  it("varies with the query", async () => {
    const a = await webAdapter.search("alpha", ctx);
    const b = await webAdapter.search("beta gamma delta", ctx);
    expect(a[0]?.url).not.toBe(b[0]?.url);
  });
});

describe("scoreResult", () => {
  const now = Date.parse("2026-01-10T00:00:00.000Z");
  const base = {
    title: "Q3 pricing deck",
    snippet: "the numbers we discussed",
    source: "gmail" as const,
  };

  it("rewards a title hit above a snippet hit", () => {
    const inTitle = scoreResult({ ...base, title: "pricing" }, "pricing", now);
    const inSnippet = scoreResult(
      { ...base, title: "unrelated", snippet: "pricing" },
      "pricing",
      now,
    );
    expect(inTitle).toBeGreaterThan(inSnippet);
  });

  it("rewards recency, capped", () => {
    const fresh = scoreResult(
      { ...base, timestamp: "2026-01-09T23:30:00.000Z" },
      "pricing",
      now,
    );
    const old = scoreResult(
      { ...base, timestamp: "2025-01-01T00:00:00.000Z" },
      "pricing",
      now,
    );
    const undated = scoreResult(base, "pricing", now);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBe(undated);
  });

  it("does not score stopwords, so query padding cannot inflate a result", () => {
    // A title the query never appears in verbatim, so the phrase bonus is out of
    // the picture and only the per-term scoring is under test.
    const scrambled = { ...base, title: "Q3 deck pricing" };
    expect(scoreResult(scrambled, "the pricing of the deck", now)).toBe(
      scoreResult(scrambled, "pricing deck", now),
    );
  });

  it("rewards the whole query appearing verbatim", () => {
    expect(scoreResult(base, "pricing deck", now)).toBeGreaterThan(
      scoreResult({ ...base, title: "Q3 deck pricing" }, "pricing deck", now),
    );
  });

  it("breaks ties by source", () => {
    expect(scoreResult(base, "pricing", now)).toBeGreaterThan(
      scoreResult({ ...base, source: "web" }, "pricing", now),
    );
  });
});
