/**
 * The registry is meant to be the *only* place that knows which sources exist.
 *
 * That claim used to be untrue in a way nothing caught: the fan-out default,
 * the REST `sources` allow-list and the API's default were three separate
 * `["gmail", "slack", "web"]` literals. A `Record<Source, …>` fails to compile
 * when a source is added, but a `Source[]` literal does not — so a registered
 * adapter could silently never run, and no test would notice.
 *
 * These tests are the guard rail for the derived list. They are deliberately
 * about *agreement between declarations* rather than about behaviour: if the
 * schema, the type and the registry ever disagree about what a source is, the
 * failure shows up here rather than as a missing source in a search.
 */

import { describe, expect, it } from "vitest";
import { source as sourceValidator } from "../schema";
import { ADAPTERS, ALL_SOURCES, SENDERS, requiresGrant } from "./registry";

/** The literals inside `v.union(v.literal(…), …)`. */
const schemaSources = sourceValidator.members
  .map((member) => member.value)
  .sort();

describe("the source registry", () => {
  it("derives the searchable list from the adapters themselves", () => {
    expect([...ALL_SOURCES].sort()).toEqual(Object.keys(ADAPTERS).sort());
  });

  it("agrees with the schema about which sources exist", () => {
    // A source in the schema with no adapter would be storable but unsearchable;
    // an adapter missing from the schema would fail to write its own results.
    expect([...ALL_SOURCES].sort()).toEqual(schemaSources);
  });

  it("gives every adapter a `source` matching the key it is filed under", () => {
    for (const [key, adapter] of Object.entries(ADAPTERS)) {
      expect(adapter.source).toBe(key);
    }
  });

  it("only offers a sender for a source that can be searched", () => {
    for (const channel of Object.keys(SENDERS)) {
      expect(ALL_SOURCES).toContain(channel);
    }
  });

  it("treats exactly the non-web sources as needing a grant", () => {
    // `requiresGrant` is the single expression of "web is the odd one out".
    // Pinning it here means adding a fourth source forces a deliberate answer
    // rather than inheriting web's exemption by accident.
    expect(ALL_SOURCES.filter(requiresGrant).sort()).toEqual(
      Object.keys(SENDERS).sort(),
    );
  });
});
