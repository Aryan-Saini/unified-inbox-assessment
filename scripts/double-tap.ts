/**
 * Empirical OCC/idempotency check against a deployed Convex REST API.
 *
 * Two ways in, one implementation:
 *
 *   node scripts/double-tap.ts        the CLI at the bottom, reading env
 *   import { doubleTap } from …       the same run, from verify-deploy.ts
 *
 * The CLI is unchanged — same variables, same usage error, same two lines of
 * output — because the README points at it and a deployed check that only works
 * from inside another script is a worse check.
 */

interface Connection {
  id: string;
  provider: "gmail" | "slack";
  status: string;
  enabled: boolean;
}

interface Draft {
  id: string;
  idempotency_key: string;
  review_hash: string;
}

interface Send {
  id: string;
  idempotency_key: string;
  provider_message_id?: string;
}

export interface DoubleTapOptions {
  /** The API base, including `/api/v1`. */
  baseUrl: string;
  apiKey: string;
  recipient: string;
  /** How many genuinely parallel sends to fire. 2–100. */
  parallel: number;
}

export interface DoubleTapResult {
  parallel: number;
  idempotencyKey: string;
  providerMessageId: string;
}

/**
 * Compose one draft, confirm it, then fire N parallel sends at it with a single
 * idempotency key. Throws on the first thing that is not exactly-once.
 */
export async function doubleTap(options: DoubleTapOptions): Promise<DoubleTapResult> {
  const { apiKey, recipient, parallel } = options;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  if (!Number.isSafeInteger(parallel) || parallel < 2 || parallel > 100) {
    throw new Error("N must be an integer from 2 through 100.");
  }

  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  const available = await json<{ connections: Connection[] }>("/connections");
  const connection = available.connections.find(
    (candidate) => candidate.status === "active" && candidate.enabled,
  );
  if (connection === undefined) throw new Error("No enabled active connection is available.");

  const idempotencyKey = `double_tap_${crypto.randomUUID().replaceAll("-", "")}`;
  const draft = await json<Draft>("/drafts", {
    method: "POST",
    body: JSON.stringify({
      channel: connection.provider,
      connection_id: connection.id,
      to: recipient,
      subject: connection.provider === "gmail" ? "Unified Inbox double-tap verification" : undefined,
      body: `Idempotency verification ${idempotencyKey}. Expect exactly one copy.`,
      idempotency_key: idempotencyKey,
    }),
  });
  await json(`/drafts/${draft.id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ reviewed_hash: draft.review_hash }),
  });

  const responses = await Promise.all(
    Array.from({ length: parallel }, async () => {
      const response = await fetch(`${baseUrl}/drafts/${draft.id}/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ acknowledged_destination: recipient }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`send -> ${response.status}: ${text}`);
      return text;
    }),
  );
  if (new Set(responses).size !== 1) throw new Error("Parallel send response bodies differed.");

  const outbox = await json<{ sends: Send[] }>("/sends");
  const matching = outbox.sends.filter((send) => send.idempotency_key === idempotencyKey);
  if (matching.length !== 1) throw new Error(`Expected one sends row for the key; found ${matching.length}.`);
  const providerMessageId = matching[0]?.provider_message_id;
  if (providerMessageId === undefined) throw new Error("The one send has no provider message id.");

  return { parallel, idempotencyKey, providerMessageId };
}

/* ------------------------------------------------------------------------ CLI */

/**
 * `import.meta.filename` is this file; `process.argv[1]` is whatever was run.
 * They match only when this file *is* the entry point, which is what keeps an
 * `import` of `doubleTap` from firing a real send as a side effect.
 */
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const baseUrl = process.env.BASE_URL;
  const apiKey = process.env.API_KEY;
  const recipient = process.env.RECIPIENT;
  const parallel = Number(process.env.N ?? "10");

  if (baseUrl === undefined || apiKey === undefined || recipient === undefined) {
    throw new Error("Usage: BASE_URL=https://…/api/v1 API_KEY=uik_… RECIPIENT=… [N=10] pnpm exec tsx scripts/double-tap.ts");
  }

  const result = await doubleTap({ baseUrl, apiKey, recipient, parallel });

  console.log(
    `PASS: ${result.parallel} identical responses, one sends row, provider message ${result.providerMessageId}.`,
  );
  console.log(
    `MANUAL CHECK REQUIRED: open ${recipient} and verify exactly one message containing ${result.idempotencyKey}.`,
  );
}
