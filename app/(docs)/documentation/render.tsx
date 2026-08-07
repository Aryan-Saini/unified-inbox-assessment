import Link from "next/link";
import {
  BlockView,
  CodeBlock,
  DocTable,
  FieldTable,
  NoteBox,
  Prose,
  SubSectionHeading,
} from "./blocks";
import { ArrowUpRightIcon } from "./docs-icons";
import { Inline } from "./inline";
import type { PageBody } from "./pages";
import {
  API_BASE,
  API_PREFIX,
  BASE_URL,
  ERROR_CODES,
  RATE_LIMITS,
  SCHEMAS,
  SEND_STATUSES,
  type Endpoint,
} from "./spec";

/**
 * Every documentation body, rendered.
 *
 * Server components end to end, on purpose. The documentation is text, and text
 * that only exists after hydration is text an agent fetching the HTML, a
 * crawler, or a reader with JavaScript off does not have. The only client
 * components in the whole route are the chrome — the sidebar, the contents
 * rail, the copy controls — and each of them decorates markup that is already
 * in the response.
 */

/* -------------------------------------------------------------- fragments */

function MethodPill({ method }: { method: "GET" | "POST" }) {
  return (
    <span
      className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${
        method === "GET"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
      }`}
    >
      {method}
    </span>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mt-5 mb-1 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
      {children}
    </h4>
  );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const fullPath = `${API_PREFIX}${endpoint.path}`;

  return (
    <article
      id={endpoint.id}
      className="mt-8 scroll-mt-24 overflow-hidden rounded-xl border border-line bg-ink-900/50"
    >
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line bg-ink-850/60 px-4 py-3">
        <MethodPill method={endpoint.method} />
        <code className="min-w-0 flex-1 font-mono text-[13px] wrap-anywhere text-neutral-100">
          {fullPath}
        </code>
      </header>

      <div className="min-w-0 px-4 py-3">
        <p className="text-[16px] font-medium text-neutral-200">{endpoint.summary}</p>

        {endpoint.alias === undefined ? null : (
          <p className="mt-1.5 text-[13.5px] leading-[1.6] text-neutral-500">
            <Inline
              text={`Also mounted at the bare path \`${endpoint.method} ${endpoint.alias}\`, which hits the same handler. The alias cannot drift from the versioned route because there is only one of it.`}
            />
          </p>
        )}

        {/* Paragraph breaks in a description are meaningful (`/send` has two),
            so they are split rather than collapsed into one block of text. */}
        {endpoint.description.split("\n\n").map((paragraph, i) => (
          <Prose key={i} text={paragraph} />
        ))}

        {endpoint.pathParams === undefined ? null : (
          <>
            <SubHeading>Path parameters</SubHeading>
            <FieldTable fields={endpoint.pathParams} nameHead="Name" />
          </>
        )}

        {endpoint.query === undefined ? null : (
          <>
            <SubHeading>Query parameters</SubHeading>
            <FieldTable fields={endpoint.query} nameHead="Name" />
          </>
        )}

        {endpoint.body === undefined ? null : (
          <>
            <SubHeading>Request body</SubHeading>
            <FieldTable fields={endpoint.body} />
          </>
        )}

        <SubHeading>Responses</SubHeading>
        <DocTable
          head={["Status", "Meaning"]}
          rows={endpoint.responses.map((r) => [`\`${r.status}\``, r.description])}
        />

        {endpoint.responseHeaders === undefined ? null : (
          <>
            <SubHeading>Response headers</SubHeading>
            <DocTable
              head={["Header", "Meaning"]}
              rows={endpoint.responseHeaders.map((h) => [`\`${h.name}\``, h.description])}
            />
          </>
        )}

        <SubHeading>Example</SubHeading>
        <CodeBlock code={endpoint.curl} label="Terminal" />
        <CodeBlock code={endpoint.example} lang="json" label="Response" />
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- overview */

function Overview({ origin }: { origin: string }) {
  const files = [
    {
      href: `${origin}/documentation/llms.txt`,
      name: "llms.txt",
      what: "The index. What this API is, every route, and the send protocol in full.",
    },
    {
      href: `${origin}/documentation/llms-full.txt`,
      name: "llms-full.txt",
      what: "Every page of this reference as markdown. Every field, error and example, in one fetch.",
    },
    {
      href: `${origin}/documentation/openapi.json`,
      name: "openapi.json",
      what: "OpenAPI 3.1, for client generation or any tool that already speaks it.",
    },
    {
      href: `${origin}/documentation/AGENTS.md`,
      name: "AGENTS.md",
      what: "Drop-in instructions to commit into a repository as AGENTS.md or CLAUDE.md.",
    },
  ];

  return (
    <>
      <SubSectionHeading id="what-this-is">What this is</SubSectionHeading>
      <Prose text="A REST API over three search adapters and one send gate. One bearer token, JSON in and out, and no endpoint anywhere that takes a recipient and a body and just sends it." />
      <Prose text="Start with the [Quickstart](/documentation/quickstart) if you want a working `curl` in the next two minutes, or [The send protocol](/documentation/send-protocol) if you are wiring up an agent and need to know what will stop it." />

      <SubSectionHeading id="base-url">Base URL</SubSectionHeading>
      <Prose text="Every route lives under `/api/v1` on the Convex deployment. Ids are opaque strings, so do not parse them." />
      <CodeBlock code={API_BASE} lang="http" label="Base URL" />

      <SubSectionHeading id="the-one-rule">The one rule that matters</SubSectionHeading>
      <Prose text="Sending is four requests, and the API enforces three of them: create a draft, read it back, confirm the hash, then send while repeating the recipient exactly. A confirm whose hash no longer matches the draft is refused, and so is a send that does not name the recipient itself." />
      <NoteBox tone="warn" title="`unknown` is the one status you must not loop on">
        <Inline text="It means an attempt came back with no verdict, so the message may or may not have gone out. `POST /sends/{id}/retry` refuses it with **409 `INDETERMINATE`** rather than guessing. Reconcile at the provider, or clone the draft under a new idempotency key — see [Failures](/documentation/failures)." />
      </NoteBox>

      <SubSectionHeading id="for-agents">For agents</SubSectionHeading>
      <Prose text="All of this is also plain text at a stable URL — same source, no HTML to parse, and one fetch gets you the whole reference." />
      <CodeBlock code={`curl -sS ${origin}/documentation/llms-full.txt`} label="Terminal" />
      <ul className="my-4 space-y-2">
        {files.map((file) => (
          <li key={file.name} className="flex flex-wrap items-baseline gap-x-2">
            <a
              href={file.href}
              className="inline-flex items-center gap-1 font-mono text-[13.5px] text-indigo-300 transition-colors hover:text-indigo-200"
            >
              {file.name}
              <ArrowUpRightIcon className="h-3 w-3" />
            </a>
            <span className="text-[15px] text-neutral-500">{file.what}</span>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[13.5px] leading-[1.6] text-neutral-600">
        The API itself runs on the Convex deployment at{" "}
        <code className="rounded border border-line bg-ink-850 px-1 py-0.5 font-mono text-[0.9em] text-indigo-200">
          {BASE_URL}
        </code>
        . These files come from this app. Both are public.
        <span className="mx-2">·</span>
        <Link href="/dashboard" className="text-indigo-300 transition-colors hover:text-indigo-200">
          Back to the app
        </Link>
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- body */

export function PageBodyView({ body, origin }: { body: PageBody; origin: string }) {
  switch (body.kind) {
    case "overview":
      return <Overview origin={origin} />;

    case "guide":
      return (
        <>
          {body.guide.blocks.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </>
      );

    case "reference":
      return (
        <>
          {body.section.endpoints.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} />
          ))}
        </>
      );

    case "shapes":
      return (
        <>
          <Prose text="These mirror the response validators the backend enforces at runtime, so a field that is not listed here is a field the API cannot return." />
          {Object.entries(SCHEMAS).map(([name, schema]) => (
            <section key={name}>
              <SubSectionHeading id={`shape-${name}`}>
                <span className="font-mono text-[15px]">{schema.title}</span>
              </SubSectionHeading>
              {schema.note === undefined ? null : <Prose text={schema.note} />}
              <FieldTable fields={schema.fields} />
            </section>
          ))}
        </>
      );

    case "send-statuses":
      return (
        <>
          <SubSectionHeading id="the-statuses">The statuses</SubSectionHeading>
          <Prose text="A send is not done until it stops moving on its own. A `failed_transient` with `next_retry_at` set is still going, and a manual retry on top of a scheduled one is wasted work. A retry schedules the next attempt rather than running it inline, so the `status` you get straight back is the pre-retry one." />
          <DocTable
            head={["Status", "Means", "What to do"]}
            rows={SEND_STATUSES.map((s) => [`\`${s.status}\``, s.meaning, s.retryable])}
          />

          <SubSectionHeading id="handling-unknown">Handling `unknown`</SubSectionHeading>
          <NoteBox tone="warn" title="`unknown` is the one to handle deliberately">
            <Inline text="It means the attempt came back with no verdict, so the message may or may not have gone out. `POST /sends/{id}/retry` refuses it with **409 `INDETERMINATE`** instead of guessing, because a retry under the same key could double-send. Reconcile at the provider, or clone the draft under a new idempotency key. An autonomous client should escalate here, not loop." />
          </NoteBox>
        </>
      );

    case "errors":
      return (
        <>
          <SubSectionHeading id="the-shape">The shape</SubSectionHeading>
          {/* Braces, not a bare attribute: a JSX attribute string is not a JS
              string literal, so the escaped quotes this sentence needs would
              render as backslashes. */}
          <Prose
            text={
              'Every failure has one shape, `{"error": {"code", "message"}}`, because a client that has to guess whether today\'s 409 is `{error: "…"}` or `{message: "…"}` ends up string-matching, and then our error text becomes their API contract. So switch on `code` and show `message`.'
            }
          />
          <CodeBlock
            lang="json"
            label="Error"
            code={`{
  "error": {
    "code": "REVIEW_HASH_MISMATCH",
    "message": "REVIEW_HASH_MISMATCH: the draft changed since it was reviewed."
  }
}`}
          />

          <SubSectionHeading id="the-codes">The codes</SubSectionHeading>
          <DocTable
            head={["Code", "HTTP", "Means", "Do"]}
            rows={ERROR_CODES.map((e) => [`\`${e.code}\``, String(e.status), e.meaning, e.action])}
          />
        </>
      );

    case "rate-limits":
      return (
        <>
          <SubSectionHeading id="the-buckets">The buckets</SubSectionHeading>
          <Prose text="Token buckets, per user, so a burst is fine while the sustained rate stays capped. The threat is specific. A key that leaks, or a client stuck in a retry loop, spending somebody's Gmail quota, and that is a hard daily ceiling no amount of backoff gets back." />
          <DocTable
            head={["Bucket", "Limit", "Covers"]}
            rows={RATE_LIMITS.map((r) => [r.name, r.limit, r.covers])}
          />

          <SubSectionHeading id="retry-after">Retry-After</SubSectionHeading>
          <Prose text="A 429 carries `Retry-After`, and that value comes out of the bucket's own arithmetic instead of some guessed constant, so a client that obeys it succeeds on the next try. The same number is on the body as `error.retry_after_seconds`." />
        </>
      );
  }
}
