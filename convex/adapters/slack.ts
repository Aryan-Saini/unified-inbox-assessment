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

export const slackAdapter: EnrichedAdapter = {
  source: "slack",

  async search(query: string, ctx: AdapterContext): Promise<EnrichedResult[]> {
    await maybeDelay(ctx.artificialDelayMs, ctx.signal);

    if (ctx.accessToken === undefined) {
      throw AdapterError.needsReconnect("No access token for this Slack connection.");
    }

    const body = await slackFetch<SearchMessagesResponse>(
      "search.messages",
      { accessToken: ctx.accessToken, signal: ctx.signal },
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

    return matches.flatMap((match): EnrichedResult[] => {
      const ts = str(match.ts);
      // `search.messages` has been observed returning matches with no `ts` for
      // messages in channels the token lost access to mid-page. Without a `ts`
      // there is no identity and no permalink, so the row is dropped rather
      // than invented.
      if (ts === undefined) return [];

      const channelName = str(match.channel?.name);
      const channelId = str(match.channel?.id);
      const channel = channelName !== undefined ? `#${channelName}` : (channelId ?? "Slack");

      return [
        {
          source: "slack",
          id: ts,
          // Slack messages have no subject, so the channel *is* the title —
          // it is what a reader scans by, and it is what makes a Slack row
          // legible next to an email row.
          title: channel,
          snippet: stripMrkdwn(str(match.text) ?? ""),
          author: str(match.username) ?? str(match.user),
          timestamp: tsToIso(ts),
          url: str(match.permalink) ?? `https://slack.com/archives/${channelId ?? ""}/p${ts.replace(".", "")}`,

          /* Enriched extras. Stored as columns, stripped by the REST projection. */
          externalId: ts,
          // A reply belongs in the thread if there is one, and starts one if
          // there is not — `thread_ts ?? ts` is exactly that rule.
          threadId: str(match.thread_ts) ?? ts,
          // Slack sends to a *channel*, not to a person, so the channel id is
          // where a reply goes.
          replyTo: channelId,
          context: channel,
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
