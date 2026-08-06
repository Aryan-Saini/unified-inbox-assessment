/**
 * Slack provider: a `SearchAdapter` and a `MessageSender`.
 *
 * Mirrors `gmail.ts` in shape, and differs from it in exactly the three ways
 * Slack differs from everyone else:
 *
 *  1. **Errors arrive as HTTP 200.** `{ok: false, error: "token_revoked"}` is a
 *     successful HTTP response, so status-code classification is worthless here.
 *     `slackFetch` unwraps the envelope and classifies on the `error` string
 *     (`classifySlackError`, shared with the OAuth module so the two cannot
 *     drift).
 *
 *  2. **`search.messages` needs a user token.** A bot token cannot call it at
 *     all. The OAuth module therefore stores `authed_user.access_token`, and this
 *     adapter is only ever handed that.
 *
 *  3. **`ts` is `seconds.microseconds`, not milliseconds.** `1712345678.000200`
 *     is a 2024 timestamp; feeding it to `new Date()` unmultiplied lands in
 *     1970. It is multiplied by 1000 exactly once, here, and there is a
 *     regression test pinning the year.
 */

import { maybeDelay, maybeInjectFailure } from "../core/faults";
import { fetchJson, withTimeout } from "../core/http";
import { classifySlackError } from "../oauth/slack";
import type { EnrichedAdapter, EnrichedResult } from "../core/registry";
import type { MessageSender, SendContext, SendPayload, SendReceipt } from "../core/sender";
import { AdapterError, type AdapterContext } from "../core/types";

const API = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 15_000;

interface SlackEnvelope {
  ok?: unknown;
  error?: unknown;
  warning?: unknown;
}

interface SlackMatch {
  ts?: unknown;
  text?: unknown;
  user?: unknown;
  username?: unknown;
  permalink?: unknown;
  thread_ts?: unknown;
  channel?: { id?: unknown; name?: unknown };
}

interface SearchMessagesResponse extends SlackEnvelope {
  messages?: { matches?: SlackMatch[] };
}

interface UserInfoResponse extends SlackEnvelope {
  user?: {
    real_name?: unknown;
    profile?: {
      display_name?: unknown;
      real_name?: unknown;
      image_72?: unknown;
      image_48?: unknown;
    };
  };
}

interface RepliesResponse extends SlackEnvelope {
  messages?: Array<{ reply_count?: unknown; latest_reply?: unknown }>;
}

interface PostMessageResponse extends SlackEnvelope {
  ts?: unknown;
  channel?: unknown;
  message?: { thread_ts?: unknown };
}

/**
 * One call to a Web API method, with Slack's envelope turned into either a value
 * or a classified `AdapterError`.
 *
 * Both verbs go through here so the `ok: false` unwrapping cannot be forgotten
 * on one of them — which is the actual failure mode this function exists to
 * prevent.
 */
async function slackFetch<T extends SlackEnvelope>(
  method: string,
  ctx: { accessToken: string; signal: AbortSignal },
  init: { query?: Record<string, string>; json?: Record<string, unknown> } = {},
): Promise<T> {
  const url = new URL(`${API}/${method}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
  };
  if (init.json !== undefined) {
    // Slack requires the charset on JSON posts, or it silently reads the body
    // as latin-1 and mangles anything non-ASCII in a message.
    headers["Content-Type"] = "application/json; charset=utf-8";
  }

  const body = await fetchJson<T>(url.toString(), {
    label: `Slack ${method}`,
    method: init.json === undefined ? "GET" : "POST",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    signal: withTimeout(ctx.signal, REQUEST_TIMEOUT_MS),
  });

  if (body?.ok !== true) {
    const error = typeof body?.error === "string" ? body.error : "unknown_error";
    throw new AdapterError(
      classifySlackError(error),
      `Slack ${method} failed: ${error}`,
      { httpStatus: 200, detail: JSON.stringify(body).slice(0, 4000) },
    );
  }

  return body;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `ts` → ISO 8601.
 *
 * `1712345678.000200` is *seconds* with a microsecond suffix. The suffix is
 * significant to Slack (it is part of a message's identity) but not to a
 * timestamp, so it survives in `id` and is simply carried through the
 * multiplication here.
 */
export function tsToIso(ts: string | undefined): string | undefined {
  if (ts === undefined) return undefined;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Slack `mrkdwn` → plain text.
 *
 * A raw Slack message body is full of `<@U04AB|ada>` and `<https://x|label>`
 * spans. Left alone they are unreadable in a list that also holds email
 * snippets, and the whole point of the normalisation layer is that a consumer
 * cannot tell which provider a row came from.
 */
export function stripMrkdwn(text: string): string {
  return (
    text
      // `<@U123|ada>` / `<@U123>` — a user mention.
      .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) =>
        name !== undefined && name !== "" ? `@${name}` : `@${id}`,
      )
      // `<#C123|general>` / `<#C123>` — a channel reference.
      .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) =>
        name !== undefined && name !== "" ? `#${name}` : `#${id}`,
      )
      // `<!here>`, `<!channel>`, `<!subteam^S123|@team>`.
      .replace(/<!(?:subteam\^)?([^>|]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) =>
        label !== undefined && label !== "" ? label : `@${id}`,
      )
      // `<https://example.test|label>` / `<https://example.test>`.
      .replace(/<((?:https?|mailto):[^>|]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) =>
        label !== undefined && label !== "" ? label : url,
      )
      // Slack escapes these three on the way out, and only these three.
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Enrichment is best-effort by construction.
 *
 * A profile lookup or a thread count is a nicety; a search that returns results
 * is the product. So every enrichment call is swallowed on failure — a missing
 * scope, a channel the token cannot read, a rate limit — and the row is
 * returned without the extra rather than the whole search failing for it. This
 * is also what lets a connection authorised before `channels:history` was
 * requested keep working: it simply shows no reply counts until it reconnects.
 */
async function optional<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch {
    return undefined;
  }
}

interface SlackProfile {
  name?: string;
  avatarUrl?: string;
}

/**
 * Resolve user ids to names and avatars, one call per *distinct* id.
 *
 * `search.messages` gives a handle (`username`) at best, and often only a `U…`
 * id. Neither is what a person is called in the workspace, and neither has a
 * face — so a Slack row read nothing like Slack. Deduplicating first matters:
 * a search that returns ten messages from one person is one lookup, not ten.
 */
async function fetchProfiles(
  userIds: string[],
  auth: { accessToken: string; signal: AbortSignal },
): Promise<Map<string, SlackProfile>> {
  const entries = await Promise.all(
    userIds.map(async (id): Promise<[string, SlackProfile] | undefined> => {
      const body = await optional(
        slackFetch<UserInfoResponse>("users.info", auth, { query: { user: id } }),
      );
      if (body === undefined) return undefined;
      const profile = body.user?.profile;
      return [
        id,
        {
          name:
            str(profile?.display_name) ??
            str(profile?.real_name) ??
            str(body.user?.real_name),
          avatarUrl: str(profile?.image_72) ?? str(profile?.image_48),
        },
      ];
    }),
  );

  return new Map(entries.filter((e): e is [string, SlackProfile] => e !== undefined));
}

/**
 * The thread hanging off a message: how many replies, and when the last one
 * landed. Undefined when the message is not a thread parent.
 *
 * `limit: 1` because the replies themselves are never read — Slack puts both
 * facts on the *parent*, so one page of one message answers the whole question
 * and the thread body never leaves the workspace.
 */
async function fetchThread(
  channelId: string,
  ts: string,
  auth: { accessToken: string; signal: AbortSignal },
): Promise<{ replyCount: number; lastReplyAt?: string } | undefined> {
  const body = await optional(
    slackFetch<RepliesResponse>("conversations.replies", auth, {
      query: { channel: channelId, ts, limit: "1" },
    }),
  );
  const parent = body?.messages?.[0];
  const count = parent?.reply_count;
  if (typeof count !== "number" || count <= 0) return undefined;
  return { replyCount: count, lastReplyAt: tsToIso(str(parent?.latest_reply)) };
}

export const slackAdapter: EnrichedAdapter = {
  source: "slack",

  async search(query: string, ctx: AdapterContext): Promise<EnrichedResult[]> {
    await maybeDelay(ctx.artificialDelayMs, ctx.signal);

    if (ctx.accessToken === undefined) {
      throw AdapterError.needsReconnect("No access token for this Slack connection.");
    }
    const auth = { accessToken: ctx.accessToken, signal: ctx.signal };

    const body = await slackFetch<SearchMessagesResponse>(
      "search.messages",
      auth,
      {
        query: {
          query,
          count: String(ctx.limit),
          // Newest first: `score` sorting duplicates what `core/rank.ts` does at
          // write time, and recency is the axis Slack itself is best at.
          sort: "timestamp",
          sort_dir: "desc",
        },
      },
    );

    const matches = body.messages?.matches ?? [];
    if (matches.length === 0) return [];

    // Both enrichments run concurrently with each other, and each is a fan-out
    // of its own — the whole batch sits inside the orchestrator's per-source
    // deadline, so serialising them would be the thing that made Slack the slow
    // source in a partial-results demo.
    const [profiles, threads] = await Promise.all([
      fetchProfiles(
        [...new Set(matches.map((m) => str(m.user)).filter((id): id is string => id !== undefined))],
        auth,
      ),
      Promise.all(
        matches.map(async (m) => {
          const channelId = str(m.channel?.id);
          const ts = str(m.ts);
          if (channelId === undefined || ts === undefined) return undefined;
          return await fetchThread(channelId, ts, auth);
        }),
      ),
    ]);

    return matches.flatMap((match, index): EnrichedResult[] => {
      const ts = str(match.ts);
      // `search.messages` has been observed returning matches with no `ts` for
      // messages in channels the token lost access to mid-page. Without a `ts`
      // there is no identity and no permalink, so the row is dropped rather
      // than invented.
      if (ts === undefined) return [];

      const channelName = str(match.channel?.name);
      const channelId = str(match.channel?.id);
      /**
       * Where it was posted, for a reader.
       *
       * Only ever a name. `search.messages` sometimes returns a match with no
       * `channel.name`, and the id it does return — `C0BN94H19L2` — is not the
       * answer to "where was this posted": it is an internal handle that means
       * nothing to the person reading the row and cannot be looked up without a
       * scope this grant does not hold. Absent beats meaningless, so the row
       * simply omits the channel and still names the workspace it came from.
       */
      const channel = channelName === undefined ? undefined : `#${channelName}`;
      const permalink = str(match.permalink);
      const text = stripMrkdwn(str(match.text) ?? "");
      const userId = str(match.user);
      const profile = userId !== undefined ? profiles.get(userId) : undefined;

      return [
        {
          source: "slack",
          id: ts,
          // A Slack message has no subject, and the channel was already said on
          // the line above, so the *message* is the headline — the same thing
          // an email subject is: the bit you scan to decide whether to open it.
          // Only a message with no text at all (a bare file share) falls back,
          // so the row is never headed by an empty string.
          title: text !== "" ? text : (channel ?? "Slack message"),
          // Never left empty: the spec's normalization check wants `title` and
          // `snippet` populated on every result whatever the source, and a bare
          // file share has no text of its own to put here.
          snippet: text !== "" ? text : (channel ?? "Slack message"),
          // The workspace display name first, the handle only as a fallback:
          // "Aryan Saini" is who a reader is looking for, "aryansaini1005" is
          // what is left when the profile lookup could not run.
          author: profile?.name ?? str(match.username) ?? userId,
          timestamp: tsToIso(ts),
          url: permalink ?? `https://slack.com/archives/${channelId ?? ""}/p${ts.replace(".", "")}`,

          /* Enriched extras. Stored as columns, stripped by the REST projection. */
          externalId: ts,
          // A reply belongs in the thread if there is one, and starts one if
          // there is not — `thread_ts ?? ts` is exactly that rule.
          threadId: str(match.thread_ts) ?? ts,
          // Slack sends to a *channel*, not to a person, so the channel id is
          // where a reply goes.
          replyTo: channelId,
          // Where it was posted. The workspace is not repeated here — the UI
          // already names the connected account a result arrived at, and for
          // Slack that account *is* the workspace.
          context: channel,
          avatarUrl: profile?.avatarUrl,
          replyCount: threads[index]?.replyCount,
          lastReplyAt: threads[index]?.lastReplyAt,
        },
      ];
    });
  },
};

export const slackSender: MessageSender = {
  channel: "slack",

  async send(payload: SendPayload, ctx: SendContext): Promise<SendReceipt> {
    maybeInjectFailure(ctx.injectFailure);

    const json: Record<string, unknown> = {
      channel: payload.to,
      text: payload.body,
    };
    if (payload.threadId !== undefined) json.thread_ts = payload.threadId;

    const body = await slackFetch<PostMessageResponse>(
      "chat.postMessage",
      { accessToken: ctx.accessToken, signal: ctx.signal },
      { json },
    );

    const ts = str(body.ts);
    if (ts === undefined) {
      // `ok: true` with no `ts` should be impossible. Treated as `unknown`
      // rather than a failure: the message may well have been posted, and
      // "posted but unacknowledged" must never be auto-retried.
      throw AdapterError.unknown(
        "Slack accepted chat.postMessage but returned no message timestamp.",
      );
    }

    return {
      providerMessageId: ts,
      providerThreadId: str(body.message?.thread_ts) ?? payload.threadId,
    };
  },
};
