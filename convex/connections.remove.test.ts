/// <reference types="vite/client" />
/**
 * Removing a connection, and the invariant it has to not break.
 *
 * `drafts.connectionId` and `sends.connectionId` are required references, so a
 * plain delete would orphan them and the outbox would lose the ability to say
 * what a past delivery went through. `remove` therefore has two outcomes, and the
 * whole value of it is that the user cannot tell them apart while the history
 * stays answerable — which is exactly the kind of thing that rots silently
 * without a test.
 */

import { expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { insertConnection, insertDraft, insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");

function ownerOf(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: "owner", tokenIdentifier: "test|owner" });
}

it("deletes the row outright when nothing points at it", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const connectionId = await insertConnection(t, userId, "slack");

  const result = await ownerOf(t).mutation(api.connections.remove, { connectionId });

  expect(result.deleted).toBe(true);
  expect(await t.run(async (ctx) => await ctx.db.get("connections", connectionId))).toBeNull();
  expect(await ownerOf(t).query(api.connections.list, {})).toEqual([]);
});

it("keeps a referenced row for the outbox, but hides it and strips its tokens", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const connectionId = await insertConnection(t, userId, "gmail");
  await insertDraft(t, { userId, connectionId });

  const result = await ownerOf(t).mutation(api.connections.remove, { connectionId });

  expect(result.deleted).toBe(false);

  const row = await t.run(async (ctx) => await ctx.db.get("connections", connectionId));
  // Still there — the draft pointing at it is still valid.
  expect(row).not.toBeNull();
  expect(row?.hiddenAt).toBeTypeOf("number");
  // And holds nothing worth stealing.
  expect(row?.accessTokenCipher).toBe("");
  expect(row?.refreshTokenCipher).toBeUndefined();
  expect(row?.enabled).toBe(false);
  expect(row?.status).toBe("revoked");

  // Indistinguishable from deleted, as far as the UI can see.
  expect(await ownerOf(t).query(api.connections.list, {})).toEqual([]);
});

it("will not remove someone else's connection", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await insertUser(t, "owner");
  await insertUser(t, "stranger");
  const connectionId = await insertConnection(t, ownerId, "slack");

  const stranger = t.withIdentity({
    subject: "stranger",
    tokenIdentifier: "test|stranger",
  });
  // Not-found and not-yours are the same answer on purpose, so assert the row
  // survived rather than the wording.
  await expect(
    stranger.mutation(api.connections.remove, { connectionId }),
  ).rejects.toThrow();
  expect(
    await t.run(async (ctx) => await ctx.db.get("connections", connectionId)),
  ).not.toBeNull();
});

it("refuses a signed-out caller", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, "owner");
  const connectionId = await insertConnection(t, userId, "slack");

  await expect(t.mutation(api.connections.remove, { connectionId })).rejects.toThrow();
});
