/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { dispatchSearch } from "./searches";
import { fakeProviders } from "./test/fakeProviders";
import { insertConnection, insertUser } from "./test/fixtures";
import type { InboxTest } from "./test/fixtures";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  process.env.WEB_SEARCH_PROVIDER = "tavily";
  process.env.WEB_SEARCH_API_KEY = "test-tavily-key";
});
afterEach(() => {
  process.env.WEB_SEARCH_PROVIDER = "mock";
  delete process.env.WEB_SEARCH_API_KEY;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("publishes Gmail results while web is still running and preserves arrival seq", async () => {
  const providers = fakeProviders().install();
  providers.on("gmail.googleapis.com", "/gmail/v1/users/me/messages").reply(200, {
    messages: [{ id: "gmail-fast" }],
  });
  providers.on("gmail.googleapis.com", "/gmail/v1/users/me/messages/gmail-fast").reply(200, {
    id: "gmail-fast",
    threadId: "thread-fast",
    snippet: "fast result",
    internalDate: "1712345678000",
    payload: { headers: [{ name: "Subject", value: "Fast Gmail" }] },
  });
  const web = providers.on("api.tavily.com", "/search").deferred();
  const t = convexTest(schema, modules);
  const userId = await insertUser(t);
  await insertConnection(t, userId);
  const searchId = await t.run(async (ctx) =>
    await dispatchSearch(ctx, {
      userId,
      query: "pricing",
      sources: ["gmail", "web"],
      origin: "api",
    }),
  );

  let partial: Awaited<ReturnType<typeof readSearch>> | undefined;
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(0);
    partial = await readSearch(t, searchId);
    if (partial.sources.find((source) => source.source === "gmail")?.status === "succeeded") break;
  }

  expect(partial?.search?.status).toBe("running");
  expect(partial?.sources.find((source) => source.source === "gmail")?.status).toBe("succeeded");
  expect(partial?.sources.find((source) => source.source === "web")?.status).toBe("running");
  expect(partial?.results.map((result) => [result.source, result.seq])).toEqual([["gmail", 0]]);

  web.resolve(200, {
    results: [{ title: "Slow web", url: "https://example.test/slow", content: "eventually" }],
  });
  await t.finishInProgressScheduledFunctions();
  const complete = await readSearch(t, searchId);

  expect(complete.search?.status).toBe("complete");
  expect(complete.results.map((result) => [result.source, result.seq])).toEqual([
    ["gmail", 0],
    ["web", 1],
  ]);
});

async function readSearch(t: InboxTest, searchId: Id<"searches">) {
  return await t.run(async (ctx) => ({
    search: await ctx.db.get("searches", searchId),
    sources: await ctx.db
      .query("searchSources")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .collect(),
    results: (
      await ctx.db
        .query("searchResults")
        .withIndex("by_search", (q) => q.eq("searchId", searchId))
        .collect()
    ).sort((a, b) => a.seq - b.seq),
  }));
}
