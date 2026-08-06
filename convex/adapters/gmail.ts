/**
 * Gmail provider: a `SearchAdapter` and a `MessageSender`.
 *
 * Talks to the REST API over plain `fetch` rather than `googleapis`. The SDK
 * pulls in a large Node-only dependency tree, and all we need is four
 * endpoints — staying on `fetch` keeps this file runnable in the default Convex
 * runtime alongside every other adapter.
 *
 * Scopes used (deliberately narrow, no `https://mail.google.com/`):
 *   gmail.readonly    — search and read message metadata
 *   gmail.send        — send, and nothing else. Cannot delete or modify mail.
 *   contacts.readonly — sender profile photos, read once per search. Optional in
 *                       the strict sense: a grant without it still searches.
 */

import { toBase64Url } from "../core/crypto";
import { maybeDelay, maybeInjectFailure } from "../core/faults";
import { fetchJson, withTimeout } from "../core/http";
import type { EnrichedAdapter, EnrichedResult } from "../core/registry";
import type { MessageSender, SendContext, SendPayload, SendReceipt } from "../core/sender";
import { AdapterError, type AdapterContext } from "../core/types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PEOPLE_API = "https://people.googleapis.com/v1/people/me/connections";
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
const REQUEST_TIMEOUT_MS = 15_000;

/** How many contacts are read for photos. One page, no pagination: this is a
 *  decoration on a search, and a second round trip for the 501st contact is not
 *  worth holding the fan-out for. */
const CONTACTS_PAGE_SIZE = 500;

interface MessageRef {
  id: string;
  threadId: string;
}

interface MessageListResponse {
  messages?: MessageRef[];
}

interface MessageResponse {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }> };
}

/**
 * Google signals rate limiting with a 403 rather than a 429, so status alone
 * misclassifies it as permanent. Re-read the error body to recover the real
 * reason before letting the error escape the adapter.
 */
function refineGoogleError(err: AdapterError): AdapterError {
  if (err.httpStatus !== 403 || err.detail === undefined) return err;

  let reason = "";
  try {
    const parsed = JSON.parse(err.detail) as {
      error?: { errors?: Array<{ reason?: string }>; status?: string };
    };
    reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status ?? "";
  } catch {
    return err;
  }

  if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
    return AdapterError.transient(`Gmail rate limit exceeded (${reason})`, {
      httpStatus: 403,
      detail: err.detail,
    });
  }

  // The grant no longer covers what we are asking for — reconnecting with the
  // current scope list fixes it, so route to reconnect rather than "failed".
  if (reason === "insufficientPermissions" || reason === "forbidden") {
    return AdapterError.needsReconnect(
      `Gmail rejected the grant's scopes (${reason}). Reconnect to re-grant.`,
      { httpStatus: 403, detail: err.detail },
    );
  }

  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
    return AdapterError.permanent(`Gmail quota exhausted (${reason})`, {
      httpStatus: 403,
      detail: err.detail,
    });
  }

  return err;
}

async function googleFetch<T>(
  url: string,
  ctx: { accessToken: string; signal: AbortSignal },
  init: { method?: string; json?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
  };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";

  try {
    return await fetchJson<T>(url, {
      label: "Gmail",
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      signal: withTimeout(ctx.signal, REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw err instanceof AdapterError ? refineGoogleError(err) : err;
  }
}

function header(message: MessageResponse, name: string): string | undefined {
  return message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

/** `"Ada Lovelace <ada@example.com>"` -> `"Ada Lovelace"`. */
function displayName(from: string | undefined): string | undefined {
  if (from === undefined) return undefined;
  const match = /^\s*"?([^"<]*?)"?\s*<.+>\s*$/.exec(from);
  const name = match?.[1]?.trim();
  return name !== undefined && name !== "" ? name : from.trim();
}

/**
 * The Cc line, reduced to bare addresses — `"Ada <ada@x.com>, bob@y.com"` ->
 * `"cc ada@x.com, bob@y.com"`. Display names are dropped because this sits on
 * one truncating line next to the sender's address, where the address is the
 * part that identifies who else saw the message. To is left out: on a message
 * found in the user's own mailbox it is the user, on every row.
 */
function ccLine(cc: string | undefined): string | undefined {
  if (cc === undefined) return undefined;
  const addresses = cc
    .split(",")
    .map((part) => emailAddress(part))
    .filter((part): part is string => part !== undefined && part !== "");
  return addresses.length > 0 ? `cc ${addresses.join(", ")}` : undefined;
}

/** `"Ada Lovelace <ada@example.com>"` -> `"ada@example.com"`. */
export function emailAddress(from: string | undefined): string | undefined {
  if (from === undefined) return undefined;
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim();
}

interface ConnectionsResponse {
  connections?: Array<{
    emailAddresses?: Array<{ value?: string }>;
    photos?: Array<{ url?: string; default?: boolean }>;
  }>;
}

/**
 * Sender photos, keyed by lowercased address.
 *
 * Gmail's search returns a `From` header and nothing else — no avatar anywhere in
 * the message resource — so the face has to come from People API. One request per
 * search covers every row: reading the contact list once and matching locally is
 * cheaper than a per-sender lookup, and it cannot fan out into N extra calls on a
 * page of results.
 *
 * **Never throws.** A missing `contacts.readonly` (a grant issued before the scope
 * was added), a rate limit, a timeout — all of them mean "no photos this time",
 * not "the search failed". The real 401 on a dead grant is still raised by the
 * message calls, which is where it belongs.
 *
 * `photo.default` is Google's generic silhouette. It is skipped rather than shown,
 * because the UI's own initials fallback says more than a grey outline does.
 */
async function contactPhotos(ctx: {
  accessToken: string;
  signal: AbortSignal;
  scopes?: string[];
}): Promise<Map<string, string>> {
  const photos = new Map<string, string>();

  // A grant issued before this scope existed would 403 on every single search.
  // Reading what it actually holds turns that into no request at all. An empty
  // list means "not recorded", so the call is still attempted.
  if (
    ctx.scopes !== undefined &&
    ctx.scopes.length > 0 &&
    !ctx.scopes.includes(CONTACTS_SCOPE)
  ) {
    return photos;
  }

  try {
    const page = await googleFetch<ConnectionsResponse>(
      `${PEOPLE_API}?personFields=emailAddresses,photos&pageSize=${CONTACTS_PAGE_SIZE}`,
      ctx,
    );

    for (const person of page.connections ?? []) {
      const url = person.photos?.find((p) => p.default !== true)?.url;
      if (url === undefined) continue;
      for (const address of person.emailAddresses ?? []) {
        if (address.value === undefined) continue;
        // First photo wins: the contact list is returned newest-first, and one
        // address on two contact cards is a duplicate, not a choice.
        const key = address.value.trim().toLowerCase();
        if (!photos.has(key)) photos.set(key, url);
      }
    }
  } catch {
    return new Map();
  }

  return photos;
}

export const gmailAdapter: EnrichedAdapter = {
  source: "gmail",

  async search(query: string, ctx: AdapterContext): Promise<EnrichedResult[]> {
    await maybeDelay(ctx.artificialDelayMs, ctx.signal);

    if (ctx.accessToken === undefined) {
      throw AdapterError.needsReconnect("No access token for this Gmail connection.");
    }
    const auth = { accessToken: ctx.accessToken, signal: ctx.signal };

    const list = await googleFetch<MessageListResponse>(
      `${API}/messages?q=${encodeURIComponent(query)}&maxResults=${ctx.limit}`,
      auth,
    );

    const refs = list.messages ?? [];
    if (refs.length === 0) return [];

    // Gmail's list endpoint returns ids only, so each result costs a second
    // call. Fetched concurrently — the fan-out deadline covers the whole batch,
    // and `ctx.limit` keeps the batch small enough not to trip a rate limit.
    // The photo lookup rides alongside the metadata batch rather than after it:
    // it is independent of every message, and it must not add a serial round trip
    // to a source that is racing the other adapters.
    const [messages, photos] = await Promise.all([
      Promise.all(
        refs.map((ref) =>
          googleFetch<MessageResponse>(
            `${API}/messages/${ref.id}?format=metadata` +
              "&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date" +
              "&metadataHeaders=Message-Id&metadataHeaders=Cc&metadataHeaders=To",
            auth,
          ),
        ),
      ),
      contactPhotos({ ...auth, scopes: ctx.scopes }),
    ]);

    return messages.map((message) => {
      const from = header(message, "From");
      const internalDate = message.internalDate;
      const address = emailAddress(from);

      // A search covers the whole mailbox, so a hit can be one of your own sent
      // messages. It has to be told apart: the interesting party is the recipient,
      // and a reply belongs to them rather than to the alias it went out as.
      const outgoing = message.labelIds?.includes("SENT") ?? false;
      const to = outgoing ? header(message, "To") : undefined;
      const recipient = emailAddress(to);
      // Whose face to show. Outgoing, that is the recipient — you already know
      // what you look like.
      const facing = (outgoing ? recipient : address)?.toLowerCase();

      return {
        source: "gmail",
        id: message.id,
        title: header(message, "Subject") ?? "(no subject)",
        snippet: decodeEntities(message.snippet ?? ""),
        author: displayName(from),
        timestamp:
          internalDate !== undefined
            ? new Date(Number(internalDate)).toISOString()
            : undefined,
        // `#all/<id>` addresses the message regardless of which label it sits
        // under; `authuser` picks the right account in a multi-login browser.
        url:
          `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(ctx.externalAccountId ?? "")}` +
          `#all/${message.id}`,

        /* Enriched extras: stored as columns, stripped by the REST projection.
           They exist so a reply can be threaded and addressed without the
           compose path having to call Gmail again. */
        externalId: message.id,
        threadId: message.threadId,
        replyTo: address,
        context: ccLine(header(message, "Cc")),
        avatarUrl: facing === undefined ? undefined : photos.get(facing),
        outgoing: outgoing ? true : undefined,
        recipient,
        recipientName: displayName(to),
        unread: message.labelIds?.includes("UNREAD") ?? false,
      } satisfies EnrichedResult;
    });
  },
};

/** Gmail snippets arrive HTML-escaped; undo the handful that actually show up. */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Everything after the `@` in the sending address, for the Message-ID domain.
 * A Message-ID whose domain matches the sender is the well-behaved form, and some
 * filters treat a mismatched one as a spam signal.
 */
function messageIdDomain(from: string): string {
  const at = from.lastIndexOf("@");
  const domain = at === -1 ? "" : from.slice(at + 1).trim().toLowerCase();
  // `.invalid` is reserved by RFC 2606, so the fallback can never collide with a
  // real domain.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : "unified-inbox.invalid";
}

/**
 * A Message-ID derived from the idempotency key, and only from it.
 *
 * This is what makes an `unknown` send *reconcilable by reading*: Gmail indexes
 * the header, so `rfc822msgid:` answers "did this exact claim already go out?"
 * without sending anything. Random per attempt, it would answer nothing.
 */
function deterministicMessageId(key: string, from: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 96);
  return `<uik.${safe}@${messageIdDomain(from)}>`;
}

/**
 * RFC 2822 message. Non-ASCII subjects are RFC 2047 encoded and the body is
 * declared UTF-8, so an em dash in a reply does not arrive as mojibake.
 */
/**
 * Header values are interpolated into an RFC 2822 header block, where a CR/LF
 * is not data but structure: `to = "a@x\r\nBcc: b@y"` would smuggle a hidden
 * recipient past the confirm screen, and `\r\n\r\n` would terminate the header
 * block entirely. The draft layer already refuses control characters in `to`;
 * this strips them from *every* interpolated value so the property does not
 * depend on every caller remembering to validate.
 */
function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function buildRawMessage(payload: SendPayload, from: string): string {
  const lines = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(payload.to)}`,
    `Subject: ${encodeHeaderValue(payload.subject ?? "")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];

  // The idempotency key, twice: once in a header Gmail's search indexes
  // (`rfc822msgid:`) and once in a header a human reading raw source can see.
  if (payload.idempotencyKey !== undefined) {
    lines.push(
      `Message-ID: ${deterministicMessageId(payload.idempotencyKey, from)}`,
      `X-Unified-Inbox-Key: ${payload.idempotencyKey}`,
    );
  }

  // Threading headers make the reply land in the original conversation rather
  // than starting a new one. Only emitted for a real RFC Message-ID (which always
  // contains an `@`): a Gmail *message id* here would be a malformed header, and
  // `threadId` on the API call is what actually threads the reply anyway.
  if (payload.inReplyTo !== undefined && payload.inReplyTo.includes("@")) {
    lines.push(`In-Reply-To: ${payload.inReplyTo}`, `References: ${payload.inReplyTo}`);
  }

  return `${lines.join("\r\n")}\r\n\r\n${payload.body}`;
}

function encodeHeaderValue(value: string): string {
  // Anything outside printable ASCII forces RFC 2047 encoding: an 8-bit header
  // value is not legal, and a raw CR/LF in a header is injection. Base64-encoding
  // the whole value defuses both.
  if (!/[^\x20-\x7E]/.test(value)) return value;
  const encoded = toBase64Url(new TextEncoder().encode(value))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return `=?UTF-8?B?${encoded}=?=`;
}

export const gmailSender: MessageSender = {
  channel: "gmail",

  async send(payload: SendPayload, ctx: SendContext): Promise<SendReceipt> {
    maybeInjectFailure(ctx.injectFailure);

    const raw = toBase64Url(
      new TextEncoder().encode(buildRawMessage(payload, ctx.externalAccountId)),
    );

    const body: Record<string, string> = { raw };
    if (payload.threadId !== undefined) body.threadId = payload.threadId;

    const sent = await googleFetch<{ id: string; threadId: string }>(
      `${API}/messages/send`,
      { accessToken: ctx.accessToken, signal: ctx.signal },
      { method: "POST", json: body },
    );

    return { providerMessageId: sent.id, providerThreadId: sent.threadId };
  },
};
