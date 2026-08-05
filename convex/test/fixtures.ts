import type { TestConvex } from "convex-test";
import type schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { encryptToken } from "../core/crypto";
import { draftDigest } from "../drafts";

export type InboxTest = TestConvex<typeof schema>;

export async function insertUser(t: InboxTest, clerkUserId = "user_test") {
  return await t.run(async (ctx) =>
    await ctx.db.insert("users", { clerkUserId, email: `${clerkUserId}@example.test` }),
  );
}

export async function insertConnection(
  t: InboxTest,
  userId: Id<"users">,
  provider: "gmail" | "slack" = "gmail",
  options: { expired?: boolean; externalAccountId?: string; status?: "active" | "revoked" } = {},
) {
  const now = Date.now();
  const externalAccountId =
    options.externalAccountId ?? (provider === "gmail" ? "sender@example.test" : "T1:U1");
  const connectionId = await t.run(async (ctx) =>
    await ctx.db.insert("connections", {
      userId,
      provider,
      externalAccountId,
      label: externalAccountId,
      status: options.status ?? "active",
      enabled: true,
      scopes: [],
      accessTokenCipher: "pending",
      tokenExpiresAt: options.expired ? now - 1 : provider === "gmail" ? now + 3_600_000 : undefined,
      isSeed: false,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const accessTokenCipher = await encryptToken("access-token", {
    provider,
    connectionId,
    tokenType: "access",
  });
  const refreshTokenCipher = await encryptToken("refresh-token", {
    provider,
    connectionId,
    tokenType: "refresh",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch("connections", connectionId, { accessTokenCipher, refreshTokenCipher });
  });
  return connectionId;
}

export async function insertDraft(
  t: InboxTest,
  args: {
    userId: Id<"users">;
    connectionId: Id<"connections">;
    channel?: "gmail" | "slack";
    key?: string;
    body?: string;
    status?: "draft" | "confirmed";
  },
) {
  const now = Date.now();
  const draftId = await t.run(async (ctx) =>
    await ctx.db.insert("drafts", {
      userId: args.userId,
      channel: args.channel ?? "gmail",
      connectionId: args.connectionId,
      to: args.channel === "slack" ? "C123" : "recipient@example.test",
      subject: args.channel === "slack" ? undefined : "Adversarial test",
      body: args.body ?? "Only one copy, please.",
      idempotencyKey: args.key ?? "idem_adversarial_001",
      status: args.status ?? "confirmed",
      revision: 1,
      isSeed: false,
      createdAt: now,
      updatedAt: now,
    }),
  );
  if ((args.status ?? "confirmed") === "confirmed") {
    await t.run(async (ctx) => {
      const draft = await ctx.db.get("drafts", draftId);
      if (draft === null) throw new Error("fixture draft vanished");
      const { hash } = await draftDigest(draft);
      await ctx.db.patch("drafts", draftId, { confirmationHash: hash, confirmedAt: now });
    });
  }
  return draftId;
}

export async function sendRows(t: InboxTest) {
  return await t.run(async (ctx) => await ctx.db.query("sends").collect());
}
