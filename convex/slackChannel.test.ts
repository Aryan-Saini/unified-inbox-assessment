/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { dispatchSearch } from "./searches";
import { fakeProviders } from "./test/fakeProviders";
import { insertConnection, insertUser } from "./test/fixtures";
import type { InboxTest } from "./test/fixtures";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const SLACK = "slack.com";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One Slack hit, with the channel object under the test's control. */
function scriptMatch(
  providers: ReturnType<typeof fakeProviders>,
  channel: { id?: string; name?: string },
) {
  providers.on(SLACK, "/api/search.messages").reply(200, {
    ok: true,
    messages: {
      matches: [
        {
          ts: "1712345678.000100",
          text: "the renewal quote is attached",
          channel,
          permalink: "https://aryan-test.slack.com/archives/C1/p1712345678000100",
        },
      ],
    },
  });
}

async function contextOf(t: InboxTest, userId: Id<"users">) {
  const searchId = await t.run(async (ctx) =>
    await dispatchSearch(ctx, { userId, query: "renewal", sources: ["slack"], origin: "api" }),
  );
  await vi.advanceTimersByTimeAsync(0);
  await t.finishInProgressScheduledFunctions();
  return await t.run(async (ctx) =>
    await ctx.db
      .query("searchResults")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .unique(),
  );
}

describe("Slack channel context", () => {
  it("names the channel when Slack returns a name", async () => {
    const providers = fakeProviders().install();
    scriptMatch(providers, { id: "C0BN94H19L2", name: "new-channel" });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    await insertConnection(t, userId, "slack");

    expect(await contextOf(t, userId)).toMatchObject({ context: "#new-channel" });
  });

  it("omits the channel rather than printing its id", async () => {
    const providers = fakeProviders().install();
    scriptMatch(providers, { id: "C0BN94H19L2" });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    await insertConnection(t, userId, "slack");

    const result = await contextOf(t, userId);
    // The id is still what a reply posts to, so it is kept — just never shown.
    expect(result?.context).toBeUndefined();
    expect(result?.replyTo).toBe("C0BN94H19L2");
    expect(result?.title).toBe("the renewal quote is attached");
  });
});
