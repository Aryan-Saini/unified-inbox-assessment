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

const GMAIL = "gmail.googleapis.com";
const PEOPLE = "people.googleapis.com";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One Gmail hit from `ada@example.test`, scripted end to end. */
function scriptOneMessage(providers: ReturnType<typeof fakeProviders>) {
  providers.on(GMAIL, "/gmail/v1/users/me/messages").reply(200, {
    messages: [{ id: "m1" }],
  });
  providers.on(GMAIL, "/gmail/v1/users/me/messages/m1").reply(200, {
    id: "m1",
    threadId: "t1",
    snippet: "the renewal quote",
    internalDate: "1712345678000",
    payload: {
      headers: [
        { name: "Subject", value: "Renewal" },
        { name: "From", value: "Ada Lovelace <Ada@Example.test>" },
      ],
    },
  });
}

async function runGmailSearch(t: InboxTest, userId: Id<"users">) {
  const searchId = await t.run(async (ctx) =>
    await dispatchSearch(ctx, { userId, query: "renewal", sources: ["gmail"], origin: "api" }),
  );
  await vi.advanceTimersByTimeAsync(0);
  await t.finishInProgressScheduledFunctions();
  return await t.run(async (ctx) => ({
    source: await ctx.db
      .query("searchSources")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .unique(),
    result: await ctx.db
      .query("searchResults")
      .withIndex("by_search", (q) => q.eq("searchId", searchId))
      .unique(),
  }));
}

describe("your own sent mail in results", () => {
  it("records the recipient, not the alias it went out as", async () => {
    const providers = fakeProviders().install();
    providers.on(GMAIL, "/gmail/v1/users/me/messages").reply(200, {
      messages: [{ id: "sent1" }],
    });
    providers.on(GMAIL, "/gmail/v1/users/me/messages/sent1").reply(200, {
      id: "sent1",
      threadId: "t9",
      snippet: "following up on the details",
      internalDate: "1712345678000",
      labelIds: ["SENT"],
      payload: {
        headers: [
          { name: "Subject", value: "Following up" },
          { name: "From", value: "Aryan Saini <alias@privatecarfinder.test>" },
          { name: "To", value: "Sam Buyer <sam@buyer.test>" },
        ],
      },
    });
    providers.on(PEOPLE, "/v1/people/me/connections").reply(200, {
      connections: [
        {
          emailAddresses: [{ value: "sam@buyer.test" }],
          photos: [{ url: "https://lh3.googleusercontent.test/sam" }],
        },
      ],
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    await insertConnection(t, userId, "gmail");

    const state = await runGmailSearch(t, userId);
    expect(state.result).toMatchObject({
      outgoing: true,
      recipient: "sam@buyer.test",
      recipientName: "Sam Buyer",
      // The sender is still recorded honestly — the row just does not lead with it.
      replyTo: "alias@privatecarfinder.test",
      // The face is the recipient's: you know what you look like.
      avatarUrl: "https://lh3.googleusercontent.test/sam",
    });
  });

  it("leaves a received message untouched", async () => {
    const providers = fakeProviders().install();
    scriptOneMessage(providers);
    providers.on(PEOPLE, "/v1/people/me/connections").reply(200, { connections: [] });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    await insertConnection(t, userId, "gmail");

    const state = await runGmailSearch(t, userId);
    expect(state.result?.outgoing).toBeUndefined();
    expect(state.result?.recipient).toBeUndefined();
    expect(state.result?.replyTo).toBe("Ada@Example.test");
  });
});

describe("Gmail sender avatars", () => {
  it("attaches the contact photo, matching the address case-insensitively", async () => {
    const providers = fakeProviders().install();
    scriptOneMessage(providers);
    providers.on(PEOPLE, "/v1/people/me/connections").reply(200, {
      connections: [
        {
          emailAddresses: [{ value: "ada@example.test" }],
          photos: [{ url: "https://lh3.googleusercontent.test/ada" }],
        },
      ],
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    await insertConnection(t, userId, "gmail");

    const state = await runGmailSearch(t, userId);
    expect(state.source?.status).toBe("succeeded");
    expect(state.result?.avatarUrl).toBe("https://lh3.googleusercontent.test/ada");
  });

  it("skips Google's default silhouette rather than showing it", async () => {
    const providers = fakeProviders().install();
    scriptOneMessage(providers);
    providers.on(PEOPLE, "/v1/people/me/connections").reply(200, {
      connections: [
        {
          emailAddresses: [{ value: "ada@example.test" }],
          photos: [{ url: "https://lh3.googleusercontent.test/silhouette", default: true }],
        },
      ],
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    await insertConnection(t, userId, "gmail");

    const state = await runGmailSearch(t, userId);
    expect(state.result?.avatarUrl).toBeUndefined();
  });

  it("does not call People API when the recorded grant lacks the scope", async () => {
    const providers = fakeProviders().install();
    scriptOneMessage(providers);
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId, "gmail");
    await t.run(async (ctx) => {
      await ctx.db.patch("connections", connectionId, {
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      });
    });

    // No People route is scripted: the fake throws on any unexpected fetch, so
    // this asserts the request is never made rather than merely tolerated.
    const state = await runGmailSearch(t, userId);
    expect(state.source?.status).toBe("succeeded");
    expect(providers.matching(PEOPLE, "/v1/people/me/connections")).toHaveLength(0);
  });

  it("still searches when the grant does not cover contacts", async () => {
    const providers = fakeProviders().install();
    scriptOneMessage(providers);
    providers.on(PEOPLE, "/v1/people/me/connections").reply(403, {
      error: { status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] },
    });
    const t = convexTest(schema, modules);
    const userId = await insertUser(t);
    const connectionId = await insertConnection(t, userId, "gmail");

    const state = await runGmailSearch(t, userId);
    // The photo is decoration: a scope it never had must not cost the search, and
    // must not be mistaken for the revoked grant that a real 403 here would look
    // like to the retry classifier.
    expect(state.source?.status).toBe("succeeded");
    expect(state.result?.title).toBe("Renewal");
    expect(state.result?.avatarUrl).toBeUndefined();
    const connection = await t.run(async (ctx) => await ctx.db.get("connections", connectionId));
    expect(connection?.status).toBe("active");
  });
});
