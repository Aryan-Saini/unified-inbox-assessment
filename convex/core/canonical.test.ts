/**
 * Canonical-payload unit tests.
 *
 * The confirm gate reduces to one claim: *the same payload always produces the
 * same string, and different payloads never do*. Everything below is one of those
 * two halves. They are unit tests rather than convex-test suites on purpose —
 * this is pure string handling, and a failure here should point at ten lines of
 * code rather than at a whole send flow.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_VERSION,
  canonicalContent,
  canonicalPayload,
  normalizeNewlines,
  type CanonicalDraft,
} from "./canonical";

const base: CanonicalDraft = {
  revision: 1,
  channel: "gmail",
  connectionId: "k17abc",
  to: "ada@example.com",
  subject: "Re: quarterly numbers",
  body: "Hi,\n\nConfirming I've seen this.\n\nAda",
};

describe("stability", () => {
  it("is deterministic for the same payload", () => {
    expect(canonicalPayload(base)).toBe(canonicalPayload({ ...base }));
  });

  it("does not depend on property order", () => {
    const reordered: CanonicalDraft = {
      body: base.body,
      to: base.to,
      subject: base.subject,
      connectionId: base.connectionId,
      channel: base.channel,
      revision: base.revision,
    };
    expect(canonicalPayload(reordered)).toBe(canonicalPayload(base));
  });

  it("starts with the schema version, so a stored hash is identifiable", () => {
    expect(canonicalPayload(base).startsWith(`${CANONICAL_VERSION}|`)).toBe(true);
  });

  it("treats \\r\\n and \\n bodies as the same payload", () => {
    const crlf = { ...base, body: base.body.replace(/\n/g, "\r\n") };
    expect(canonicalPayload(crlf)).toBe(canonicalPayload(base));
  });
});

describe("sensitivity", () => {
  const variants: Array<[string, CanonicalDraft]> = [
    ["one character of body", { ...base, body: `${base.body}.` }],
    ["a changed recipient", { ...base, to: "eve@example.com" }],
    ["a changed subject", { ...base, subject: `${base.subject} (revised)` }],
    ["a different channel", { ...base, channel: "slack" }],
    ["a different connection", { ...base, connectionId: "k17xyz" }],
    ["a bumped revision", { ...base, revision: 2 }],
  ];

  for (const [label, variant] of variants) {
    it(`changes for ${label}`, () => {
      expect(canonicalPayload(variant)).not.toBe(canonicalPayload(base));
    });
  }

  it("distinguishes an absent subject from an empty one", () => {
    const absent = canonicalPayload({ ...base, subject: undefined });
    const empty = canonicalPayload({ ...base, subject: "" });
    expect(absent).not.toBe(empty);
  });

  /**
   * The reason fields are length-prefixed rather than joined by a separator.
   * These two drafts differ, and a naive `[to, subject].join("|")` would render
   * both as `a|b|c` — a confirmed-payload bypass.
   */
  it("cannot be spoofed by moving a separator between fields", () => {
    const left = canonicalPayload({ ...base, to: "a|b", subject: "c" });
    const right = canonicalPayload({ ...base, to: "a", subject: "b|c" });
    expect(left).not.toBe(right);
  });

  it("frames multibyte fields by byte length", () => {
    // "é" is two UTF-8 bytes; a UTF-16-length prefix would say 1.
    expect(canonicalPayload({ ...base, subject: "é" })).toContain("|2:é|");
  });
});

describe("canonicalContent", () => {
  it("ignores the revision, so an edited draft still matches its frozen send", () => {
    const edited: CanonicalDraft = { ...base, revision: 9 };
    expect(canonicalContent(edited)).toBe(canonicalContent(base));
  });

  it("still separates two genuinely different payloads", () => {
    expect(canonicalContent({ ...base, body: "different" })).not.toBe(
      canonicalContent(base),
    );
  });
});

describe("normalizeNewlines", () => {
  it("collapses every line-ending flavour to \\n", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});
