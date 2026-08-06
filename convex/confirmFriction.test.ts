/// <reference types="vite/client" />
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { fakeProviders } from "./test/fakeProviders";
import { createDraft } from "./drafts";
import { insertConnection, insertDraft, insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.unstubAllGlobals());

it("refuses an unconfirmed draft before any provider call", async () => {
  const providers = fakeProviders().install();
  const t = convexTest(schema, modules);
  const userId = await insertUser(t);
  const connectionId = await insertConnection(t, userId);
  const draftId = await insertDraft(t, { userId, connectionId, status: "draft" });

  await expect(t.mutation(internal.sends.claim, { userId, draftId })).rejects.toThrow(
    "CONFIRMATION_REQUIRED",
  );
  expect(providers.calls).toHaveLength(0);
});

it("re-derives the digest and refuses a payload changed after confirmation", async () => {
  const providers = fakeProviders().install();
  const t = convexTest(schema, modules);
  const userId = await insertUser(t);
  const connectionId = await insertConnection(t, userId);
  const draftId = await insertDraft(t, { userId, connectionId });
  // Simulate a stale/hostile writer that bypassed updateDraft's confirmation clearing.
  await t.run(async (ctx) => {
    await ctx.db.patch("drafts", draftId, { body: "changed after review" });
  });

  await expect(t.mutation(internal.sends.claim, { userId, draftId })).rejects.toThrow(
    "PAYLOAD_CHANGED_SINCE_CONFIRM",
  );
  expect(providers.calls).toHaveLength(0);
});

it("exposes delivery publicly only as sends.send(draftId)", () => {
  type SendArgs = FunctionArgs<typeof api.sends.send>;
  type RetryArgs = FunctionArgs<typeof api.sends.retry>;
  // The read-only views may grow; what this pins is that the only ways to *move*
  // a message are `send(draftId)` and `retry(sendId)`, both of which name a row
  // that already exists rather than taking a payload.
  expectTypeOf<keyof typeof api.sends>().toEqualTypeOf<
    "send" | "retry" | "watch" | "list" | "listDetailed"
  >();
  expectTypeOf<SendArgs>().toEqualTypeOf<{ draftId: Id<"drafts"> }>();
  expectTypeOf<RetryArgs>().toEqualTypeOf<{ sendId: Id<"sends"> }>();
  expect(getFunctionName(api.sends.send)).toBe("sends:send");
  expect(Object.keys({ draftId: "only" } satisfies Record<keyof SendArgs, string>)).toEqual([
    "draftId",
  ]);
});

describe("recipient header integrity (review finding)", () => {
  it("refuses a recipient carrying CR/LF header injection", async () => {
    fakeProviders().install();
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId);

    // The gate every creation path funnels through (UI mutation and REST shell
    // alike), exercised below the auth/rate-limit shells on purpose: the
    // property belongs to the core, not to one entry point.
    await expect(
      t.run(async (ctx) =>
        createDraft(ctx, {
          userId,
          channel: "gmail",
          connectionId,
          to: "victim@example.test\r\nBcc: harvest@evil.test",
          body: "hello",
        }),
      ),
    ).rejects.toThrow(/control characters/);
  });
});
