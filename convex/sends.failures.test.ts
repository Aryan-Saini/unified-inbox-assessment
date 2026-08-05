/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { MAX_SEND_ATTEMPTS, retrySend, STALE_IN_FLIGHT_MS } from "./sends";
import { fakeProviders } from "./test/fakeProviders";
import { insertConnection, insertDraft, insertUser } from "./test/fixtures";

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
  return { t, userId, connectionId, draftId };
}

describe("send failure policy", () => {
  it("retries 503 with backoff through maxAttempts", async () => {
    const providers = fakeProviders().install();
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      providers.on(...gmailSend).reply(503, { error: { message: "unavailable" } });
    }
    const { t, userId, draftId } = await setup();
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      send: await ctx.db.get("sends", claim.sendId),
      attempts: await ctx.db.query("sendAttempts").withIndex("by_send", (q) => q.eq("sendId", claim.sendId)).collect(),
    }));

    expect(providers.matching(...gmailSend)).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(state.attempts).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(state.send).toMatchObject({ status: "failed_transient", attemptCount: MAX_SEND_ATTEMPTS });
    expect(state.send?.nextRetryAt).toBeUndefined();
  });

  it("treats a 400 invalid recipient as one permanent attempt", async () => {
    const providers = fakeProviders().install();
    providers.on(...gmailSend).reply(400, { error: { message: "Invalid recipient" } });
    const { t, userId, draftId } = await setup();
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      send: await ctx.db.get("sends", claim.sendId),
      attempts: await ctx.db.query("sendAttempts").withIndex("by_send", (q) => q.eq("sendId", claim.sendId)).collect(),
    }));
    expect(providers.matching(...gmailSend)).toHaveLength(1);
    expect(state.attempts).toHaveLength(1);
    expect(state.send).toMatchObject({ status: "failed_permanent", attemptCount: 1 });
    expect(state.send?.nextRetryAt).toBeUndefined();
  });

  it("marks an abort after dispatch unknown and refuses retry", async () => {
    const providers = fakeProviders().install();
    const pending = providers.on(...gmailSend).deferred();
    const { t, userId, draftId } = await setup();
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });
    for (let i = 0; i < 20 && providers.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    const timeout = new Error("timed out after dispatch");
    timeout.name = "AbortError";
    pending.reject(timeout);
    await t.finishInProgressScheduledFunctions();
    const send = await t.run(async (ctx) => await ctx.db.get("sends", claim.sendId));
    expect(send).toMatchObject({ status: "unknown", lastErrorKind: "unknown" });
    await expect(
      t.run(async (ctx) => await retrySend(ctx, { userId, sendId: claim.sendId })),
    ).rejects.toThrow("INDETERMINATE");
    expect(providers.matching(...gmailSend)).toHaveLength(1);
  });

  it("sweeps a stale in-flight lease to unknown", async () => {
    fakeProviders().install();
    const { t, userId, connectionId, draftId } = await setup();
    const old = Date.now() - STALE_IN_FLIGHT_MS - 1;
    const sendId = await t.run(async (ctx) => {
      const sendId = await ctx.db.insert("sends", {
        userId,
        draftId,
        idempotencyKey: "idem_stale_worker",
        channel: "gmail",
        connectionId,
        to: "recipient@example.test",
        subject: "stale",
        body: "maybe delivered",
        status: "in_flight",
        attemptCount: 1,
        maxAttempts: MAX_SEND_ATTEMPTS,
        isSeed: false,
        createdAt: old,
        updatedAt: old,
      });
      await ctx.db.insert("sendAttempts", {
        sendId,
        userId,
        attemptNumber: 1,
        trigger: "initial",
        startedAt: old,
      });
      return sendId;
    });

    expect(await t.mutation(internal.sends.sweepStaleInFlight, {})).toEqual({ swept: 1 });
    const state = await t.run(async (ctx) => ({
      send: await ctx.db.get("sends", sendId),
      attempt: (await ctx.db.query("sendAttempts").withIndex("by_send", (q) => q.eq("sendId", sendId)).unique()),
    }));
    expect(state.send?.status).toBe("unknown");
    expect(state.attempt).toMatchObject({ outcome: "unknown", errorKind: "unknown" });
  });
});

describe("post-dispatch failures without a provider answer (review findings)", () => {
  it("treats a network error after dispatch as unknown, never retried", async () => {
    const providers = fakeProviders().install();
    // A TypeError from fetch is what a socket reset or a connection dropped
    // mid-response-body looks like. Pre-fix this classified as the read path's
    // "network errors are transient" and auto-retried — the double-send hole.
    providers.on(...gmailSend).deferred().reject(new TypeError("fetch failed"));
    const { t, userId, draftId } = await setup();
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      send: await ctx.db.get("sends", claim.sendId),
      attempts: await ctx.db
        .query("sendAttempts")
        .withIndex("by_send", (q) => q.eq("sendId", claim.sendId))
        .collect(),
    }));

    expect(providers.matching(...gmailSend)).toHaveLength(1);
    expect(state.attempts).toHaveLength(1);
    expect(state.send?.status).toBe("unknown");
    expect(state.send?.nextRetryAt).toBeUndefined();
  });

  it("failAttempt cannot move a swept unknown send back into a retryable state", async () => {
    fakeProviders().install();
    const { t, userId, connectionId, draftId } = await setup();
    const now = Date.now();

    const { sendId, attemptId } = await t.run(async (ctx) => {
      const sendId = await ctx.db.insert("sends", {
        userId,
        draftId,
        idempotencyKey: "idem_swept_unknown",
        channel: "gmail" as const,
        connectionId,
        to: "recipient@example.test",
        body: "swept",
        status: "unknown" as const,
        attemptCount: 1,
        maxAttempts: 4,
        lastErrorKind: "unknown" as const,
        isSeed: false,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });
      const attemptId = await ctx.db.insert("sendAttempts", {
        sendId,
        userId,
        attemptNumber: 1,
        trigger: "initial" as const,
        startedAt: now,
      });
      return { sendId, attemptId };
    });

    // A late-reporting worker files its transient outcome after the sweeper
    // already declared the send unknown. The verdict must not move.
    await t.mutation(internal.sends.failAttempt, {
      sendId,
      attemptId,
      kind: "transient",
      message: "late 503",
      httpStatus: 503,
    });

    const send = await t.run(async (ctx) => ctx.db.get("sends", sendId));
    expect(send?.status).toBe("unknown");
    expect(send?.nextRetryAt).toBeUndefined();
  });
});
