/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { fakeProviders } from "./test/fakeProviders";
import { insertConnection, insertDraft, insertUser, sendRows } from "./test/fixtures";
import { retrySend } from "./sends";

const modules = import.meta.glob("./**/*.ts");
const gmailSend = ["gmail.googleapis.com", "/gmail/v1/users/me/messages/send"] as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t);
  const connectionId = await insertConnection(t, userId);
  const draftId = await insertDraft(t, { userId, connectionId });
  return { t, userId, draftId };
}

describe("send idempotency", () => {
  it("double-send returns one provider receipt and one send row", async () => {
    const providers = fakeProviders().install();
    providers.on(...gmailSend).reply(200, { id: "gmail-message-1", threadId: "thread-1" });
    const { t, userId, draftId } = await setup();

    const first = await t.mutation(internal.sends.claim, { userId, draftId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const replay = await t.mutation(internal.sends.claim, { userId, draftId });

    expect(first.claimed).toBe(true);
    expect(replay.claimed).toBe(false);
    expect(replay.sendId).toBe(first.sendId);
    expect(replay.send.providerMessageId).toBe("gmail-message-1");
    const receipt = await t.mutation(internal.sends.claim, { userId, draftId });
    expect(receipt.sendId).toBe(replay.sendId);
    expect(receipt.send.providerMessageId).toBe(replay.send.providerMessageId);
    expect(providers.matching(...gmailSend)).toHaveLength(1);
    expect(await sendRows(t)).toHaveLength(1);
  });

  it("serializes concurrent claims so exactly one wins", async () => {
    const providers = fakeProviders().install();
    providers.on(...gmailSend).reply(200, { id: "gmail-message-2", threadId: "thread-2" });
    const { t, userId, draftId } = await setup();

    const claims = await Promise.all([
      t.mutation(internal.sends.claim, { userId, draftId }),
      t.mutation(internal.sends.claim, { userId, draftId }),
    ]);

    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.sendId)).size).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(providers.matching(...gmailSend)).toHaveLength(1);
    expect(await sendRows(t)).toHaveLength(1);
  });

  it("retry after success is free and returns the same receipt", async () => {
    const providers = fakeProviders().install();
    providers.on(...gmailSend).reply(200, { id: "gmail-message-3", threadId: "thread-3" });
    const { t, userId, draftId } = await setup();
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const before = providers.calls.length;
    const retry = await t.run(async (ctx) => await retrySend(ctx, { userId, sendId: claim.sendId }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(retry).toMatchObject({ retried: false, reason: "already_delivered" });
    expect(retry.send.providerMessageId).toBe("gmail-message-3");
    expect(providers.calls).toHaveLength(before);
  });

  it("rejects reuse of a key with a different frozen payload", async () => {
    const providers = fakeProviders().install();
    const { t, userId, draftId } = await setup();
    await t.mutation(internal.sends.claim, { userId, draftId });
    const other = await insertDraft(t, {
      userId,
      connectionId: (await t.run(async (ctx) => (await ctx.db.get("drafts", draftId))?.connectionId))!,
      key: "idem_adversarial_001",
      body: "A different message",
    });

    const callsBeforeReuse = providers.calls.length;
    await expect(t.mutation(internal.sends.claim, { userId, draftId: other })).rejects.toThrow(
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(providers.calls).toHaveLength(callsBeforeReuse);
  });

  it("beginAttempt skips in-flight and unknown sends without provider calls", async () => {
    const providers = fakeProviders().install();
    const { t, userId, draftId } = await setup();
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });
    const first = await t.mutation(internal.sends.beginAttempt, {
      sendId: claim.sendId,
      trigger: "initial",
    });
    const duplicate = await t.mutation(internal.sends.beginAttempt, {
      sendId: claim.sendId,
      trigger: "manual",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch("sends", claim.sendId, { status: "unknown" });
    });
    const indeterminate = await t.mutation(internal.sends.beginAttempt, {
      sendId: claim.sendId,
      trigger: "manual",
    });
    expect(first.proceed).toBe(true);
    expect(duplicate).toEqual({ proceed: false, reason: "attempt_in_progress" });
    expect(indeterminate).toEqual({ proceed: false, reason: "indeterminate" });
    expect(providers.calls).toHaveLength(0);
  });
});
