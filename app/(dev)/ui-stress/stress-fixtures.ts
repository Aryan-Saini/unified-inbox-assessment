/**
 * The awkward strings, copied from `convex/seed.ts`.
 *
 * Duplicated rather than imported because the harness must run with no Convex
 * client at all — but the values are the same ones the seeded deployment shows,
 * so a screenshot taken here is a screenshot of the demo data.
 */

import type { Connection, SourceRun, UiResult } from "../../(inbox)/types";

export const LONG = {
  workspace: "Northwind-Trading-International-Logistics-and-Freight-Forwarding",
  member: "Alexandra Constantinopoulos-Featherstonehaugh",
  /** 254 characters: the longest address that is actually deliverable. */
  address: `${"a".repeat(64)}@${"very-long-subdomain.".repeat(8)}${"x".repeat(17)}.example.com`,
  channel: "#q3-planning-logistics-and-freight-forwarding-escalations",
  subject:
    `Re: ${"Escalation on the Q3 logistics review and the freight-forwarding contract renewal, including the outstanding invoice reconciliation. ".repeat(7)}`.slice(
      0,
      988,
    ),
  body: `${"This paragraph exists to be long. ".repeat(40)}\n\n${"It has a second one, after a hard break, so the pre-wrap rendering is exercised as well as the clamping. ".repeat(20)}`,
  query:
    `${"invoice reconciliation freight forwarding escalation ".repeat(12)}`.slice(
      0,
      512,
    ),
  unbreakable:
    "Reconciliation—Q3—Logistics—Freight—Forwarding—Escalation—Thread—2041—Final",
} as const;

export const GMAIL_CONNECTION: Connection = {
  id: "conn_gmail",
  provider: "gmail",
  label: "demo.inbox@example.com",
  detail: "Gmail",
  status: "active",
  scopes: ["gmail.readonly", "gmail.send"],
  lastUsed: "12m",
  enabled: true,
  isSeed: true,
};

export const LONG_GMAIL_CONNECTION: Connection = {
  id: "conn_gmail_long",
  provider: "gmail",
  label: LONG.address,
  detail: "Gmail",
  status: "errored",
  statusReason:
    '[seed] gmail returned 403 Forbidden — {"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED"}}.',
  scopes: ["gmail.readonly"],
  lastUsed: "3h",
  enabled: false,
  isSeed: true,
};

export const SLACK_CONNECTION: Connection = {
  id: "conn_slack",
  provider: "slack",
  label: LONG.workspace,
  accountName: LONG.member,
  detail: "Slack",
  status: "active",
  scopes: ["search:read", "chat:write"],
  lastUsed: "3m",
  enabled: true,
  isSeed: true,
};

/** The row from screenshots 2 and 3: every string at its cap at once. */
export const LONG_EMAIL: UiResult = {
  source: "gmail",
  id: "long-email",
  resultId: "res_long_email",
  connectionId: GMAIL_CONNECTION.id,
  title: LONG.subject,
  snippet: LONG.body,
  author: LONG.address,
  age: "2h",
  timestamp: "2026-01-01T00:00:00.000Z",
  url: "https://mail.google.com/mail/u/0/#inbox/seed-long-everything",
  score: 91,
  replyTo: LONG.address,
  context: LONG.unbreakable,
  unread: true,
  threadId: "seed-thread-long",
};

export const LONG_SENT: UiResult = {
  source: "gmail",
  id: "long-sent",
  connectionId: GMAIL_CONNECTION.id,
  title: "Re: Freight forwarding escalation — my reply",
  snippet:
    "Confirming the numbers below are the ones payments will work from. Anything not on this list is out of scope for Q3.",
  author: "demo.inbox@example.com",
  age: "70m",
  timestamp: "2026-01-01T00:00:00.000Z",
  url: "https://mail.google.com/mail/u/0/#sent/seed-outgoing",
  score: 80,
  outgoing: true,
  recipient: LONG.address,
  recipientName: LONG.member,
  replyTo: "demo.inbox@example.com",
};

export const LONG_SLACK: UiResult = {
  source: "slack",
  id: "long-slack",
  connectionId: SLACK_CONNECTION.id,
  title: `${LONG.channel} — escalation`,
  snippet: LONG.body,
  author: LONG.member,
  age: "25m",
  timestamp: "2026-01-01T00:00:00.000Z",
  url: "https://northwind.slack.com/archives/C0LONGCHANNEL/p1700000000000900",
  score: 88,
  replyTo: "C0LONGCHANNEL",
  context: `${LONG.channel} · 1284 replies`,
  replyCount: 1284,
  lastReplyAge: "8m",
  threadId: "1700000000.000900",
};

export const RESULTS: UiResult[] = [LONG_EMAIL, LONG_SENT, LONG_SLACK];

export const RUNS: SourceRun[] = [
  {
    source: "gmail",
    label: "demo.inbox@example.com",
    status: "succeeded",
    resultCount: 2,
    durationMs: 1_240,
  },
  {
    source: "slack",
    label: LONG.workspace,
    status: "succeeded",
    resultCount: 1,
    durationMs: 2_890,
  },
  {
    source: "web",
    label: "Web (mock)",
    status: "failed",
    resultCount: 0,
    errorKind: "permanent",
    errorMessage: "[seed] The web search provider returned 400 Bad Request.",
  },
];

export const CONNECTIONS: Connection[] = [
  GMAIL_CONNECTION,
  LONG_GMAIL_CONNECTION,
  SLACK_CONNECTION,
];
