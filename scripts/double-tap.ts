/** Empirical OCC/idempotency check against a deployed Convex REST API. */

export {};

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

const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
const apiKey = process.env.API_KEY;
const recipient = process.env.RECIPIENT;
const parallel = Number(process.env.N ?? "10");

if (baseUrl === undefined || apiKey === undefined || recipient === undefined) {
  throw new Error("Usage: BASE_URL=https://…/api/v1 API_KEY=uik_… RECIPIENT=… [N=10] pnpm exec tsx scripts/double-tap.ts");
}
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
if (matching[0]?.provider_message_id === undefined) throw new Error("The one send has no provider message id.");

console.log(`PASS: ${parallel} identical responses, one sends row, provider message ${matching[0].provider_message_id}.`);
console.log(`MANUAL CHECK REQUIRED: open ${recipient} and verify exactly one message containing ${idempotencyKey}.`);
