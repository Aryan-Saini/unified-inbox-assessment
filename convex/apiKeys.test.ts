/// <reference types="vite/client" />
import { expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { sha256Hex } from "./core/crypto";
import { insertConnection, insertDraft, insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");

it("returns null for bad and revoked API-key digests", async () => {
  const t = convexTest(schema, modules);
  await insertUser(t, "owner");
  const owner = t.withIdentity({ subject: "owner", tokenIdentifier: "test|owner" });
  const created = await owner.mutation(api.apiKeys.create, { name: "automation" });

  expect(await t.mutation(internal.apiKeys.authenticate, { hash: await sha256Hex("bad-key") })).toBeNull();
  await owner.mutation(api.apiKeys.revoke, { apiKeyId: created.apiKey.id });
  expect(
    await t.mutation(internal.apiKeys.authenticate, { hash: await sha256Hex(created.key) }),
  ).toBeNull();
});

it("stores only the digest, never the plaintext API key", async () => {
  const t = convexTest(schema, modules);
  await insertUser(t, "owner");
  const owner = t.withIdentity({ subject: "owner", tokenIdentifier: "test|owner" });
  const created = await owner.mutation(api.apiKeys.create, { name: "automation" });
  const row = await t.run(async (ctx) => await ctx.db.get("apiKeys", created.apiKey.id));

  expect(row?.hash).toBe(await sha256Hex(created.key));
  expect(row?.hash).not.toBe(created.key);
  expect(JSON.stringify(row)).not.toContain(created.key);
});

it("denies cross-user draft access", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await insertUser(t, "owner");
  await insertUser(t, "stranger");
  const connectionId = await insertConnection(t, ownerId);
  const draftId = await insertDraft(t, { userId: ownerId, connectionId });
  const stranger = t.withIdentity({ subject: "stranger", tokenIdentifier: "test|stranger" });

  expect(await stranger.query(api.drafts.get, { draftId })).toBeNull();
  await expect(stranger.query(api.drafts.reviewPayload, { draftId })).rejects.toThrow("NOT_FOUND");
});
