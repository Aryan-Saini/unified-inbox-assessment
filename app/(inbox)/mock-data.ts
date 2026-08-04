/**
 * MOCK DATA — every value in this file is fabricated.
 *
 * Nothing here calls a provider or a backend. It exists so the search, history,
 * connection and confirm-before-send surfaces can be driven end to end as UI.
 * All timestamps are pre-formatted strings rather than derived from `Date.now()`
 * so the server and client render identical markup (no hydration flicker) and
 * so screenshots are reproducible.
 */

import type { Connection, SearchRecord, Source, UiResult } from "./types";

export const SOURCES: Source[] = ["gmail", "slack", "web"];

export const SOURCE_META: Record<
  Source,
  { name: string; color: string; dot: string; tint: string }
> = {
  gmail: {
    name: "Gmail",
    color: "text-[#f0655a]",
    dot: "bg-[#f0655a]",
    tint: "bg-[#f0655a]/10 border-[#f0655a]/25 text-[#f7a39b]",
  },
  slack: {
    name: "Slack",
    color: "text-[#a78bfa]",
    dot: "bg-[#a78bfa]",
    tint: "bg-[#a78bfa]/10 border-[#a78bfa]/25 text-[#c4b2fd]",
  },
  web: {
    name: "Web",
    color: "text-[#38bdf8]",
    dot: "bg-[#38bdf8]",
    tint: "bg-[#38bdf8]/10 border-[#38bdf8]/25 text-[#8bd6fb]",
  },
};

/** The connection label each adapter run reports, per source. */
export const SOURCE_LABEL: Record<Source, string> = {
  gmail: "ada@northwind.test",
  slack: "Northwind HQ",
  web: "Web search (mock provider)",
};

export const MOCK_CONNECTIONS: Connection[] = [
  {
    id: "conn_gmail_ada",
    provider: "gmail",
    label: "ada@northwind.test",
    detail: "Primary inbox",
    status: "active",
    statusReason: undefined,
    scopes: ["gmail.readonly", "gmail.send"],
    lastUsed: "2m ago",
  },
  {
    id: "conn_gmail_ops",
    provider: "gmail",
    label: "ops@northwind.test",
    detail: "Shared operations inbox",
    status: "expired",
    statusReason: "Refresh token rejected — invalid_grant (access revoked)",
    scopes: ["gmail.readonly", "gmail.send"],
    lastUsed: "6h ago",
  },
  {
    id: "conn_slack_hq",
    provider: "slack",
    label: "Northwind HQ",
    detail: "ada@northwind.test · 41 channels",
    status: "active",
    scopes: ["search:read", "chat:write"],
    lastUsed: "4m ago",
  },
  {
    id: "conn_slack_partners",
    provider: "slack",
    label: "Partners (external)",
    detail: "ada@northwind.test · 6 channels",
    status: "errored",
    statusReason: "ratelimited — Slack returned 429 on the last 3 attempts",
    scopes: ["search:read"],
    lastUsed: "1d ago",
  },
];

export const MOCK_HISTORY: SearchRecord[] = [
  {
    id: "s_01",
    query: "invoice from Ledgerly",
    age: "12m",
    resultCount: 14,
    sources: ["gmail", "slack", "web"],
    archived: false,
    isSeed: true,
  },
  {
    id: "s_02",
    query: "Q3 pricing deck feedback",
    age: "48m",
    resultCount: 22,
    sources: ["gmail", "slack"],
    archived: false,
    isSeed: true,
  },
  {
    id: "s_03",
    query: "staging deploy rollback",
    age: "2h",
    resultCount: 9,
    sources: ["slack", "web"],
    archived: false,
    isSeed: true,
    degraded: true,
  },
  {
    id: "s_04",
    query: "onboarding checklist for Priya",
    age: "5h",
    resultCount: 17,
    sources: ["gmail", "slack", "web"],
    archived: false,
    isSeed: true,
  },
  {
    id: "s_05",
    query: "SOC 2 evidence request",
    age: "1d",
    resultCount: 31,
    sources: ["gmail", "web"],
    archived: false,
    isSeed: true,
  },
  {
    id: "s_06",
    query: "who owns the billing webhook",
    age: "1d",
    resultCount: 6,
    sources: ["slack"],
    archived: false,
    isSeed: true,
  },
  {
    id: "s_07",
    query: "renewal date Ledgerly contract",
    age: "2d",
    resultCount: 11,
    sources: ["gmail", "web"],
    archived: true,
    isSeed: true,
  },
  {
    id: "s_08",
    query: "offsite flight receipts",
    age: "3d",
    resultCount: 26,
    sources: ["gmail"],
    archived: true,
    isSeed: true,
  },
  {
    id: "s_09",
    query: "postgres connection pool limit",
    age: "5d",
    resultCount: 19,
    sources: ["slack", "web"],
    archived: true,
    isSeed: true,
  },
];

/**
 * The pool each mock adapter draws from. `terms` decides which results a query
 * matches; a query that matches nothing falls back to the whole pool so the
 * demo never dead-ends on an empty list.
 */
type PoolItem = Omit<UiResult, "id"> & { terms: string[] };

const GMAIL_POOL: PoolItem[] = [
  {
    source: "gmail",
    title: "Invoice #4821 is ready — Ledgerly",
    snippet:
      "Your invoice for the July billing period is attached. Total due $4,120.00, net 30. Reply to this thread if the PO number needs to change.",
    author: "billing@ledgerly.test",
    context: "Inbox · Invoices",
    timestamp: "2026-07-30T09:14:00Z",
    age: "12m",
    url: "https://mail.google.com/mail/u/0/#inbox/mock-4821",
    replyTo: "billing@ledgerly.test",
    unread: true,
    terms: ["invoice", "ledgerly", "billing", "payment", "renewal", "contract"],
  },
  {
    source: "gmail",
    title: "Re: Q3 pricing deck — a few notes before Thursday",
    snippet:
      "Slide 12 still shows the old enterprise tier. I'd cut the comparison table entirely and let the ROI slide carry it. Happy to jump on a call.",
    author: "marcus@northwind.test",
    context: "Inbox · 6 messages",
    timestamp: "2026-07-30T08:02:00Z",
    age: "1h",
    url: "https://mail.google.com/mail/u/0/#inbox/mock-pricing",
    replyTo: "marcus@northwind.test",
    unread: true,
    terms: ["pricing", "deck", "q3", "feedback", "slides", "enterprise"],
  },
  {
    source: "gmail",
    title: "Action required: SOC 2 evidence upload window closes Friday",
    snippet:
      "We still need the access-review export and the incident-response tabletop notes. Everything else on the checklist has been accepted by the auditor.",
    author: "compliance@vantapoint.test",
    context: "Inbox · Compliance",
    timestamp: "2026-07-29T16:40:00Z",
    age: "18h",
    url: "https://mail.google.com/mail/u/0/#inbox/mock-soc2",
    replyTo: "compliance@vantapoint.test",
    terms: ["soc", "soc2", "evidence", "audit", "compliance", "security"],
  },
  {
    source: "gmail",
    title: "Priya's first week — laptop, badge, and the onboarding doc",
    snippet:
      "IT has the laptop imaged and ready for Monday. Can you take her through the deploy runbook on day two? I've put the checklist in the shared drive.",
    author: "people@northwind.test",
    context: "Inbox · Hiring",
    timestamp: "2026-07-29T11:20:00Z",
    age: "1d",
    url: "https://mail.google.com/mail/u/0/#inbox/mock-onboarding",
    replyTo: "people@northwind.test",
    terms: ["onboarding", "priya", "checklist", "hiring", "laptop"],
  },
  {
    source: "gmail",
    title: "Your staging deploy failed (build #2291)",
    snippet:
      "The migration step exited 1: relation \"send_attempts\" already exists. Rolling back to build #2288. Logs are attached for the last three attempts.",
    author: "ci@northwind.test",
    context: "Inbox · CI",
    timestamp: "2026-07-29T07:55:00Z",
    age: "1d",
    url: "https://mail.google.com/mail/u/0/#inbox/mock-deploy",
    terms: ["deploy", "staging", "rollback", "build", "migration", "failed"],
  },
  {
    source: "gmail",
    title: "Ledgerly renewal — quote valid through August 15",
    snippet:
      "Locking this year's rate needs a signature before the 15th. After that the list price applies. I've attached the redlined MSA for your legal team.",
    author: "sales@ledgerly.test",
    context: "Inbox · Vendors",
    timestamp: "2026-07-28T14:05:00Z",
    age: "2d",
    url: "https://mail.google.com/mail/u/0/#inbox/mock-renewal",
    replyTo: "sales@ledgerly.test",
    terms: ["renewal", "contract", "ledgerly", "quote", "msa", "legal"],
  },
];

const SLACK_POOL: PoolItem[] = [
  {
    source: "slack",
    title: "#finance-ops — \"Ledgerly invoice is in, who approves?\"",
    snippet:
      "@ada the Ledgerly invoice landed this morning. It's over the $2k auto-approve threshold so it needs a manual sign-off before Thursday's run.",
    author: "Dana Whitfield",
    context: "#finance-ops · 4 replies",
    timestamp: "2026-07-30T09:31:00Z",
    age: "8m",
    url: "https://northwind.slack.test/archives/C01FINOPS/p1753861860",
    replyTo: "#finance-ops",
    unread: true,
    terms: ["invoice", "ledgerly", "approve", "billing", "finance", "payment"],
  },
  {
    source: "slack",
    title: "#deploys — \"rolling staging back to 2288\"",
    snippet:
      "Migration blew up on send_attempts. I've pinned the rollback command in the channel. Don't re-run the deploy until the migration is made idempotent.",
    author: "Sam Okonkwo",
    context: "#deploys · 11 replies",
    timestamp: "2026-07-29T08:12:00Z",
    age: "1d",
    url: "https://northwind.slack.test/archives/C01DEPLOY/p1753776720",
    replyTo: "#deploys",
    terms: ["deploy", "staging", "rollback", "migration", "build", "failed"],
  },
  {
    source: "slack",
    title: "#design-review — \"pricing deck v7 is up\"",
    snippet:
      "v7 drops the comparison table Marcus flagged and reworks slide 12. Comments open until Thursday 10:00, then I'm freezing it for the board packet.",
    author: "Iris Chen",
    context: "#design-review · 7 replies",
    timestamp: "2026-07-30T07:44:00Z",
    age: "2h",
    url: "https://northwind.slack.test/archives/C01DESIGN/p1753854240",
    replyTo: "#design-review",
    unread: true,
    terms: ["pricing", "deck", "q3", "feedback", "slides", "design"],
  },
  {
    source: "slack",
    title: "#eng-platform — \"who owns the billing webhook?\"",
    snippet:
      "Nobody's in the CODEOWNERS for services/billing-webhook. It's been paging on 429s from the provider for two days and the retries have no backoff.",
    author: "Tomás Rivera",
    context: "#eng-platform · 9 replies",
    timestamp: "2026-07-29T13:02:00Z",
    age: "20h",
    url: "https://northwind.slack.test/archives/C01PLAT/p1753794120",
    replyTo: "#eng-platform",
    terms: ["billing", "webhook", "owns", "owner", "retry", "429", "ratelimit"],
  },
  {
    source: "slack",
    title: "#general — \"Priya starts Monday 🎉\"",
    snippet:
      "Joining the platform team. Ada is running her through the deploy runbook on day two — if you own a service she'll touch, drop your docs in the thread.",
    author: "Dana Whitfield",
    context: "#general · 23 replies",
    timestamp: "2026-07-28T15:30:00Z",
    age: "2d",
    url: "https://northwind.slack.test/archives/C01GEN/p1753716600",
    replyTo: "#general",
    terms: ["onboarding", "priya", "checklist", "hiring", "general"],
  },
];

const WEB_POOL: PoolItem[] = [
  {
    source: "web",
    title: "Idempotency keys: making retries safe — Stripe Docs",
    snippet:
      "An idempotency key lets you retry a request without risk of performing the same operation twice. Keys are scoped to the endpoint and expire after 24 hours.",
    author: "stripe.com",
    timestamp: "2026-06-11T00:00:00Z",
    age: "Jun 2026",
    url: "https://stripe.com/docs/api/idempotent_requests",
    terms: ["idempotency", "retry", "send", "double", "invoice", "billing"],
  },
  {
    source: "web",
    title: "Gmail API: users.messages.send scopes and quotas",
    snippet:
      "Sending requires gmail.send. Per-user rate limits are enforced at 250 quota units per second; a 429 should be retried with exponential backoff and jitter.",
    author: "developers.google.com",
    timestamp: "2026-05-02T00:00:00Z",
    age: "May 2026",
    url: "https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send",
    terms: ["gmail", "send", "scope", "quota", "429", "ratelimit", "retry"],
  },
  {
    source: "web",
    title: "Handling invalid_grant when an OAuth refresh token is revoked",
    snippet:
      "invalid_grant is terminal: the grant is gone and no amount of retrying will recover it. Surface a reconnect prompt and preserve the account identity.",
    author: "oauth.net",
    timestamp: "2026-04-18T00:00:00Z",
    age: "Apr 2026",
    url: "https://oauth.net/2/refresh-tokens/",
    terms: ["oauth", "revoked", "reconnect", "invalid_grant", "expired", "token", "soc"],
  },
  {
    source: "web",
    title: "Slack search.messages — pagination and rate limits",
    snippet:
      "search.messages sits in Tier 2 (20+ requests per minute). Responses include a paging object; treat ok:false with error:ratelimited as transient.",
    author: "api.slack.com",
    timestamp: "2026-03-27T00:00:00Z",
    age: "Mar 2026",
    url: "https://api.slack.com/methods/search.messages",
    terms: ["slack", "search", "ratelimit", "429", "pagination", "webhook"],
  },
  {
    source: "web",
    title: "Postgres: tuning max_connections and pooling with PgBouncer",
    snippet:
      "Each connection costs roughly 5–10 MB of shared memory. Past a few hundred, transaction-mode pooling beats raising max_connections outright.",
    author: "postgresql.org",
    timestamp: "2026-02-09T00:00:00Z",
    age: "Feb 2026",
    url: "https://www.postgresql.org/docs/current/runtime-config-connection.html",
    terms: ["postgres", "connection", "pool", "limit", "database", "deploy"],
  },
];

const POOLS: Record<Source, PoolItem[]> = {
  gmail: GMAIL_POOL,
  slack: SLACK_POOL,
  web: WEB_POOL,
};

/**
 * Pick the mock results a source "returns" for a query.
 *
 * Term-matched items come first so typing "invoice" feels like search rather
 * than a canned list; if nothing matches, the whole pool is returned so the
 * demo always has something to render.
 */
export function resultsFor(source: Source, query: string): UiResult[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

  const pool = POOLS[source];
  const scored = pool.map((item, i) => {
    const hay = `${item.title} ${item.snippet} ${item.terms.join(" ")}`.toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return { item, hits, i };
  });

  const matched = scored.filter((s) => s.hits > 0);
  const chosen = (matched.length > 0 ? matched : scored)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .map(({ item, i }) => {
      const { terms, ...rest } = item;
      void terms; // matching metadata, not part of the public Result shape
      return { ...rest, id: `${source}_${i}` } satisfies UiResult;
    });

  return chosen;
}

/** Suggestions shown under an empty search field. */
export const EXAMPLE_QUERIES = [
  "invoice from Ledgerly",
  "Q3 pricing deck feedback",
  "staging deploy rollback",
  "who owns the billing webhook",
];
