/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { insertConnection, insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");

/**
 * A source run stores the grant's state at the moment it ran. `watch` has to read
 * that back against the accounts as they stand *now*, or a connector the user has
 * already fixed keeps claiming it needs reconnecting — and worst-status-wins lets
 * the dead row speak for a healthy sibling account.
 */
async function seedSearch(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  rows: Array<{
    source: "gmail" | "slack" | "web";
    label: string;
    status: "succeeded" | "needs_reconnect";
    connectionId?: Id<"connections">;
  }>,
) {
  return await t.run(async (ctx) => {
    const searchId = await ctx.db.insert("searches", {
      userId,
      query: "renewal",
      status: "complete",
      origin: "ui",
      resultCount: 0,
      isSeed: false,
      createdAt: Date.now(),
      completedAt: Date.now(),
    });
    for (const row of rows) {
      await ctx.db.insert("searchSources", {
        searchId,
        userId,
        source: row.source,
        connectionId: row.connectionId,
        label: row.label,
        status: row.status,
        attemptCount: 1,
        resultCount: row.status === "succeeded" ? 1 : 0,
        errorKind: row.status === "needs_reconnect" ? "needs_reconnect" : undefined,
        errorMessage: row.status === "needs_reconnect" ? "Disconnected by you." : undefined,
      });
    }
    return searchId;
  });
}

describe("stale needs_reconnect rows", () => {
  it("drops the row when the account has since been removed", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const live = await insertConnection(t, userId, "slack", { externalAccountId: "T1:U1" });
    const removed = await insertConnection(t, userId, "slack", { externalAccountId: "T1:U2" });
    const searchId = await seedSearch(t, userId, [
      { source: "slack", label: "aryan-test", status: "succeeded", connectionId: live },
      { source: "slack", label: "aryan-test", status: "needs_reconnect", connectionId: removed },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.delete("connections", removed);
    });

    const data = await t
      .withIdentity({ subject: "user_test" })
      .query(api.searches.watch, { searchId });
    expect(data?.sources.map((s) => s.status)).toEqual(["succeeded"]);
  });

  it("drops the row when the account is hidden rather than deleted", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const hidden = await insertConnection(t, userId, "gmail");
    const searchId = await seedSearch(t, userId, [
      { source: "gmail", label: "sender@example.test", status: "needs_reconnect", connectionId: hidden },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch("connections", hidden, { hiddenAt: Date.now(), enabled: false });
    });

    const data = await t
      .withIdentity({ subject: "user_test" })
      .query(api.searches.watch, { searchId });
    expect(data?.sources).toEqual([]);
  });

  it("degrades to a retryable failure once the account is active again", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const reconnected = await insertConnection(t, userId, "gmail", { status: "active" });
    const searchId = await seedSearch(t, userId, [
      {
        source: "gmail",
        label: "sender@example.test",
        status: "needs_reconnect",
        connectionId: reconnected,
      },
    ]);

    const data = await t
      .withIdentity({ subject: "user_test" })
      .query(api.searches.watch, { searchId });
    expect(data?.sources[0]).toMatchObject({ status: "failed", errorKind: "unknown" });
  });

  it("keeps the row while the account really is revoked", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const revoked = await insertConnection(t, userId, "gmail", { status: "revoked" });
    const searchId = await seedSearch(t, userId, [
      { source: "gmail", label: "sender@example.test", status: "needs_reconnect", connectionId: revoked },
    ]);

    const data = await t
      .withIdentity({ subject: "user_test" })
      .query(api.searches.watch, { searchId });
    expect(data?.sources[0]).toMatchObject({ status: "needs_reconnect" });
  });
});
