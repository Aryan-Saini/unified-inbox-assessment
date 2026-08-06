/// <reference types="vite/client" />
/**
 * A newer grant to a workspace replaces an older one.
 *
 * Slack's `externalAccountId` is `T…:U…`, so signing in as a *different* Slack
 * user in the *same* workspace is a genuinely different identity and lands in a
 * genuinely different row. Correct for identity, wrong for searching: both rows
 * then fan out to the same workspace, doubling the provider calls and the
 * results. The newer grant therefore retires the older one.
 *
 * The tests that matter here are the ones about what it must NOT touch — two
 * Gmail inboxes and two different Slack workspaces are the multi-account case
 * the whole product exists for, and a superseding rule that overreached would
 * quietly delete a working connection.
 */

import { expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { insertConnection, insertDraft, insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");

function ownerOf(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: "owner", tokenIdentifier: "test|owner" });
}

async function grant(
  t: ReturnType<typeof convexTest>,
  userId: string,
  externalAccountId: string,
  provider: "gmail" | "slack" = "slack",
) {
  return await t.mutation(internal.connections.upsertFromGrant, {
    userId: userId as never,
    provider,
    externalAccountId,
    label: externalAccountId,
    scopes: ["search:read"],
  });
}

it("retires an older identity in the same Slack workspace", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const older = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:UOLD",
  });

  const result = await grant(t, userId, "T1:UNEW");

  expect(result.ok).toBe(true);
  // Nothing pointed at the old row, so it is gone rather than hidden.
  expect(
    await t.run(async (ctx) => await ctx.db.get("connections", older)),
  ).toBeNull();

  const listed = await ownerOf(t).query(api.connections.list, {});
  expect(listed).toHaveLength(1);
  expect(listed[0].label).toBe("T1:UNEW");
});

it("hides rather than deletes a superseded row the outbox still needs", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const older = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:UOLD",
  });
  await insertDraft(t, { userId, connectionId: older });

  await grant(t, userId, "T1:UNEW");

  const row = await t.run(async (ctx) => await ctx.db.get("connections", older));
  expect(row).not.toBeNull();
  // Kept for history, but inert: no tokens, not searchable, not listed.
  expect(row?.hiddenAt).toBeTypeOf("number");
  expect(row?.enabled).toBe(false);
  expect(row?.accessTokenCipher).toBe("");
  expect(row?.statusReason).toContain("Replaced by a newer connection");
  expect(await ownerOf(t).query(api.connections.list, {})).toHaveLength(1);
});

it("leaves a different Slack workspace alone", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  await insertConnection(t, userId, "slack", { externalAccountId: "T1:U1" });

  await grant(t, userId, "T2:U2");

  const listed = await ownerOf(t).query(api.connections.list, {});
  expect(listed.map((c) => c.label).sort()).toEqual(["T1:U1", "T2:U2"]);
});

it("leaves a second Gmail inbox alone", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  await insertConnection(t, userId, "gmail", {
    externalAccountId: "first@example.test",
  });

  await grant(t, userId, "second@example.test", "gmail");

  const listed = await ownerOf(t).query(api.connections.list, {});
  expect(listed).toHaveLength(2);
});

it("reconnecting the same identity updates in place and retires nothing", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const existing = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:U1",
  });

  const result = await grant(t, userId, "T1:U1");

  expect(result).toMatchObject({ ok: true, connectionId: existing, created: false });
  expect(await ownerOf(t).query(api.connections.list, {})).toHaveLength(1);
});

it("absorbs a same-workspace identity change on reconnect, keeping the row id", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const connectionId = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:UOLD",
    status: "revoked",
  });
  // Something depends on this row, which is the whole reason `_id` must survive.
  await insertDraft(t, { userId, connectionId });

  const result = await t.mutation(internal.connections.upsertFromGrant, {
    userId,
    provider: "slack",
    externalAccountId: "T1:UNEW",
    label: "aryan-test",
    teamName: "aryan-test",
    scopes: ["search:read", "channels:history"],
    reconnectConnectionId: connectionId,
  });

  expect(result).toMatchObject({ ok: true, connectionId, created: false });

  const row = await t.run(async (ctx) => await ctx.db.get("connections", connectionId));
  expect(row?.externalAccountId).toBe("T1:UNEW");
  expect(row?.scopes).toContain("channels:history");
  expect(await ownerOf(t).query(api.connections.list, {})).toHaveLength(1);
});

it("still refuses a reconnect that lands on a different workspace", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const connectionId = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:U1",
  });

  const result = await t.mutation(internal.connections.upsertFromGrant, {
    userId,
    provider: "slack",
    externalAccountId: "T2:U2",
    label: "somewhere-else",
    scopes: [],
    reconnectConnectionId: connectionId,
  });

  expect(result).toMatchObject({ ok: false, error: "identity_mismatch" });
  const row = await t.run(async (ctx) => await ctx.db.get("connections", connectionId));
  expect(row?.externalAccountId).toBe("T1:U1");
});

it("still refuses a reconnect that lands on a different Gmail address", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const connectionId = await insertConnection(t, userId, "gmail", {
    externalAccountId: "first@example.test",
  });

  const result = await t.mutation(internal.connections.upsertFromGrant, {
    userId,
    provider: "gmail",
    externalAccountId: "second@example.test",
    label: "second@example.test",
    scopes: [],
    reconnectConnectionId: connectionId,
  });

  expect(result).toMatchObject({ ok: false, error: "identity_mismatch" });
});

it("retires the reconnected row when the new identity is already connected", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const live = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:UNEW",
  });
  const stale = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:UOLD",
    status: "revoked",
  });

  // Reconnecting the stale row, but signing in as the identity the live row
  // already holds: repointing would put two rows on one identity.
  const result = await t.mutation(internal.connections.upsertFromGrant, {
    userId,
    provider: "slack",
    externalAccountId: "T1:UNEW",
    label: "aryan-test",
    scopes: ["search:read"],
    reconnectConnectionId: stale,
  });

  expect(result).toMatchObject({ ok: true, connectionId: live, created: false });
  expect(await t.run(async (ctx) => await ctx.db.get("connections", stale))).toBeNull();
  expect(await ownerOf(t).query(api.connections.list, {})).toHaveLength(1);
});

it("does not resurrect an already-hidden row as a supersede target", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const hidden = await insertConnection(t, userId, "slack", {
    externalAccountId: "T1:UOLD",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("connections", hidden, { hiddenAt: Date.now() });
  });

  await grant(t, userId, "T1:UNEW");

  // Still hidden, still present — untouched, because it was already retired.
  // `statusReason` is still unset: a second pass would have written one.
  const row = await t.run(async (ctx) => await ctx.db.get("connections", hidden));
  expect(row).not.toBeNull();
  expect(row?.statusReason).toBeUndefined();
});
