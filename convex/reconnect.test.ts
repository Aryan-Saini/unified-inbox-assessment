/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { dispatchSearch } from "./searches";
import { retrySend } from "./sends";
import { fakeProviders } from "./test/fakeProviders";
import { insertConnection, insertDraft, insertUser } from "./test/fixtures";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("revoked grants and reconnect", () => {
  it("invalid_grant marks the Gmail source needs_reconnect without searching", async () => {
    const providers = fakeProviders().install();
    providers.on("oauth2.googleapis.com", "/token").reply(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked",
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId, "gmail", { expired: true });
    const searchId = await t.run(async (ctx) =>
      await dispatchSearch(ctx, { userId, query: "renewal", sources: ["gmail"], origin: "api" }),
    );

    await vi.advanceTimersByTimeAsync(0);
    await t.finishInProgressScheduledFunctions();
    const state = await t.run(async (ctx) => ({
      source: await ctx.db.query("searchSources").withIndex("by_search", (q) => q.eq("searchId", searchId)).unique(),
      connection: await ctx.db.get("connections", connectionId),
    }));
    expect(state.source).toMatchObject({ status: "needs_reconnect", errorKind: "needs_reconnect" });
    expect(state.connection?.status).toBe("revoked");
    expect(providers.matching("gmail.googleapis.com", "/gmail/v1/users/me/messages")).toHaveLength(0);
  });

  it("Slack's HTTP-200 token_revoked envelope revokes the grant", async () => {
    const providers = fakeProviders().install();
    providers.on("slack.com", "/api/search.messages").reply(200, {
      ok: false,
      error: "token_revoked",
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId, "slack");
    const searchId = await t.run(async (ctx) =>
      await dispatchSearch(ctx, { userId, query: "renewal", sources: ["slack"], origin: "api" }),
    );

    await vi.advanceTimersByTimeAsync(0);
    await t.finishInProgressScheduledFunctions();
    const state = await t.run(async (ctx) => ({
      source: await ctx.db.query("searchSources").withIndex("by_search", (q) => q.eq("searchId", searchId)).unique(),
      connection: await ctx.db.get("connections", connectionId),
    }));
    expect(state.source).toMatchObject({ status: "needs_reconnect", errorKind: "needs_reconnect" });
    expect(state.connection?.status).toBe("revoked");
    expect(providers.matching("slack.com", "/api/search.messages")).toHaveLength(1);
  });

  it("keeps a sendable draft confirmed when its grant is revoked", async () => {
    const providers = fakeProviders().install();
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId, "gmail", { status: "revoked" });
    const draftId = await insertDraft(t, { userId, connectionId });
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      draft: await ctx.db.get("drafts", draftId),
      send: await ctx.db.get("sends", claim.sendId),
    }));
    expect(state.send?.status).toBe("needs_reconnect");
    expect(state.draft?.status).toBe("confirmed");
    expect(providers.calls).toHaveLength(0);
  });

  it("upserts a repeated grant without changing the connection id", async () => {
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId);
    const result = await t.mutation(internal.connections.upsertFromGrant, {
      userId,
      provider: "gmail",
      externalAccountId: "sender@example.test",
      label: "Renamed account",
      accountEmail: "sender@example.test",
      scopes: ["gmail.send"],
    });
    expect(result).toEqual({ ok: true, connectionId, created: false });
  });

  it("delivers once with the same key after reconnect", async () => {
    const providers = fakeProviders().install();
    providers.on("gmail.googleapis.com", "/gmail/v1/users/me/messages/send").reply(200, {
      id: "after-reconnect",
      threadId: "thread-reconnected",
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId, "gmail", { status: "revoked" });
    const draftId = await insertDraft(t, { userId, connectionId, key: "idem_reconnect_same_key" });
    const claim = await t.mutation(internal.sends.claim, { userId, draftId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      await ctx.db.patch("connections", connectionId, { status: "active", statusReason: undefined });
    });
    const retry = await t.run(async (ctx) => await retrySend(ctx, { userId, sendId: claim.sendId }));
    expect(retry.retried).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const replay = await t.mutation(internal.sends.claim, { userId, draftId });

    expect(replay.sendId).toBe(claim.sendId);
    expect(replay.send.providerMessageId).toBe("after-reconnect");
    expect(providers.matching("gmail.googleapis.com", "/gmail/v1/users/me/messages/send")).toHaveLength(1);
  });
});
