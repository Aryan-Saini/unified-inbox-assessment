import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "../../Logo";
import { KeyIcon } from "../../(inbox)/icons";
import { BlockView, CodeBlock, DocTable, FieldTable, NoteBox, Prose } from "./blocks";
import { CopyPageMenu } from "./CopyPageMenu";
import { DocsSidebar, MobileNav, type NavGroup } from "./DocsNav";
import { ArrowUpRightIcon, BookGlyph } from "./docs-icons";
import { guide } from "./guide";
import { Inline } from "./inline";
import { docsOrigin } from "./origin";
import {
  API_BASE,
  API_PREFIX,
  BASE_URL,
  ERROR_CODES,
  RATE_LIMITS,
  SCHEMAS,
  SECTIONS,
  SEND_STATUSES,
  type Endpoint,
} from "./spec";

/**
 * The human rendering of the documentation.
 *
 * Server-rendered end to end, on purpose. An agent that fetches this URL and
 * reads the HTML gets the whole reference in the response body rather than an
 * empty shell and a promise to hydrate — and the `<link rel="alternate">` tags
 * in the head, plus the Copy page control in the title block, point it at the
 * markdown and OpenAPI copies, which are the same content from the same source
 * (`spec.ts`, `guide.ts`).
 *
 * The layout is a three-part shell — fixed header, 280px section rail, measured
 * content column — which is the arrangement every reference site converges on
 * for the same reason: the reader is looking something up, so where they are
 * and what else exists both have to stay on screen.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const origin = await docsOrigin();
  return {
    title: "API documentation | Unified Inbox",
    description:
      "REST reference for the Unified Inbox API: search Gmail, Slack and the web, and send replies only after an explicit confirmation step.",
    alternates: {
      canonical: `${origin}/documentation`,
      types: {
        // Discovery for anything that follows alternates rather than guessing
        // URLs — the same files the Copy page menu names in the UI.
        "text/markdown": `${origin}/documentation/llms-full.txt`,
        "text/plain": `${origin}/documentation/llms.txt`,
        "application/json": `${origin}/documentation/openapi.json`,
      },
    },
  };
}

/** One glyph per reference group — two sharing `{}` read as the same thing. */
const REFERENCE_ICONS: Record<string, NavGroup["icon"]> = {
  connections: "plug",
  searching: "spark",
  sending: "lock",
  outbox: "inbox",
};

/* ------------------------------------------------------------------ fragments */

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

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    // `scroll-mt` clears the sticky header: without it every in-page link lands
    // with its own heading hidden behind the bar it was clicked from.
    <h2 id={id} className="scroll-mt-20 pt-11 text-[19px] font-semibold tracking-tight text-white">
      <a href={`#${id}`} className="group inline-flex items-baseline gap-2">
        {children}
        <span
          aria-hidden
          className="text-[15px] text-neutral-700 opacity-0 transition-opacity group-hover:opacity-100"
        >
          #
        </span>
      </a>
    </h2>
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
      className="mt-6 scroll-mt-20 overflow-hidden rounded-xl border border-line bg-ink-900/50"
    >
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line bg-ink-850/60 px-4 py-3">
        <MethodPill method={endpoint.method} />
        <code className="min-w-0 flex-1 font-mono text-[13px] wrap-anywhere text-neutral-100">
          {fullPath}
        </code>
      </header>

      <div className="min-w-0 px-4 py-3">
        <p className="text-[13.5px] font-medium text-neutral-200">{endpoint.summary}</p>

        {endpoint.alias === undefined ? null : (
          <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-500">
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

/* ----------------------------------------------------------------------- page */

export default async function DocumentationPage() {
  const origin = await docsOrigin();
  const sections = guide(origin);

  /** The rail. Groups mirror the page's own three movements. */
  const navGroups: NavGroup[] = [
    {
      label: "Guide",
      icon: "rocket",
      items: sections.map((s) => ({ id: s.id, label: s.title })),
    },
    ...SECTIONS.map(
      (section): NavGroup => ({
        label: section.title,
        icon: REFERENCE_ICONS[section.id] ?? "braces",
        items: section.endpoints.map((endpoint) => ({
          id: endpoint.id,
          label: endpoint.path,
          method: endpoint.method,
        })),
      }),
    ),
    {
      label: "Appendix",
      icon: "layers",
      items: [
        { id: "shapes", label: "Object shapes" },
        { id: "send-statuses", label: "Send statuses" },
        { id: "errors", label: "Error codes" },
        { id: "rate-limits", label: "Rate limits" },
      ],
    },
  ];

  const machineFiles = [
    {
      href: `${origin}/documentation/llms.txt`,
      name: "llms.txt",
      what: "The index. What this API is, every route, and the send protocol in full.",
    },
    {
      href: `${origin}/documentation/llms-full.txt`,
      name: "llms-full.txt",
      what: "This entire page as markdown. Every field, error and example, in one fetch.",
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
    <div className="min-h-dvh">
      {/* Header — 60px, sticky, the full width of the window. */}
      <header className="sticky top-0 z-40 h-14 border-b border-line bg-ink-950/85 backdrop-blur">
        <div className="mx-auto flex h-full items-center gap-3 px-4 sm:px-5">
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
            <Logo className="h-6 w-6 shrink-0 text-white" />
            <span className="truncate text-[13px] font-semibold tracking-tight text-white">
              Unified Inbox
            </span>
          </Link>
          <span
            className="hidden items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-medium text-indigo-300 sm:flex"
          >
            <BookGlyph className="h-3.5 w-3.5" />
            Docs
          </span>

          <div className="ml-auto flex items-center gap-2">
            <MobileNav groups={navGroups} />
            <Link
              href="/dashboard"
              className="flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
            >
              <KeyIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Get a key</span>
            </Link>
          </div>
        </div>
      </header>

      <div className="flex">
        <DocsSidebar groups={navGroups} />

        {/* `min-w-0`: the code blocks inside are unbreakable and a flex child
            will not shrink below its widest content without it. */}
        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[52rem] px-4 pb-28 sm:px-8">
            {/* Title block: heading, one-line description, and the page's own
                actions on the right — the arrangement that puts "take the
                markdown instead" within reach before any prose is read. */}
            <div className="pt-9">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h1 className="min-w-0 text-[26px] leading-tight font-semibold tracking-tight text-white">
                  Unified Inbox API
                </h1>
                <div className="shrink-0 pt-1.5">
                  <CopyPageMenu origin={origin} />
                </div>
              </div>
              <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">
                Search Gmail, Slack and the web from one place, and only send a reply
                after you have explicitly confirmed it.
              </p>
            </div>

            <hr className="my-6 border-t border-line" />

            <NoteBox tone="info" title="These docs are also plain Markdown, for agents">
              <Inline
                text={`Everything below is also plain text at a stable URL. Same source, no HTML to parse, and one fetch gets you the entire reference: \`curl -sS ${origin}/documentation/llms-full.txt\`. Or hit **Copy as Markdown** above.`}
              />
            </NoteBox>

            <div className="my-4 text-[13px] leading-relaxed text-neutral-400">
              <p>
                One bearer token, JSON in and out, and no endpoint anywhere that takes a
                recipient and a body and just sends it.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-neutral-500">Base URL</span>
              <code className="min-w-0 rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 font-mono text-[12.5px] wrap-anywhere text-neutral-200">
                {API_BASE}
              </code>
            </div>

            {/* The prose guide: quickstart, auth, the send protocol, failures. */}
            {sections.map((section) => (
              <section key={section.id}>
                <SectionHeading id={section.id}>{section.title}</SectionHeading>
                {section.blocks.map((block, i) => (
                  <BlockView key={i} block={block} />
                ))}
              </section>
            ))}

            {/* The endpoint reference. */}
            <SectionHeading id="reference">Endpoint reference</SectionHeading>
            <Prose text="Every route lives under `/api/v1` on the Convex deployment. Ids are opaque strings, so do not parse them." />

            {SECTIONS.map((section) => (
              <section key={section.id}>
                <h3
                  id={`ref-${section.id}`}
                  className="mt-10 scroll-mt-20 text-[15px] font-semibold tracking-tight text-neutral-200"
                >
                  {section.title}
                </h3>
                {section.endpoints.map((endpoint) => (
                  <EndpointCard key={endpoint.id} endpoint={endpoint} />
                ))}
              </section>
            ))}

            {/* Object shapes. */}
            <SectionHeading id="shapes">Object shapes</SectionHeading>
            <Prose text="These mirror the response validators the backend enforces at runtime, so a field that is not listed here is a field the API cannot return." />
            {Object.entries(SCHEMAS).map(([name, schema]) => (
              <section key={name} id={`shape-${name}`} className="scroll-mt-20">
                <h3 className="mt-8 font-mono text-[13.5px] font-semibold text-neutral-200">
                  {schema.title}
                </h3>
                {schema.note === undefined ? null : <Prose text={schema.note} />}
                <FieldTable fields={schema.fields} />
              </section>
            ))}

            {/* Send statuses. */}
            <SectionHeading id="send-statuses">Send statuses</SectionHeading>
            <Prose text="A send is not done until it stops moving on its own. A `failed_transient` with `next_retry_at` set is still going, and a manual retry on top of a scheduled one is wasted work. A retry schedules the next attempt rather than running it inline, so the `status` you get straight back is the pre-retry one." />
            <DocTable
              head={["Status", "Means", "What to do"]}
              rows={SEND_STATUSES.map((s) => [`\`${s.status}\``, s.meaning, s.retryable])}
            />
            <NoteBox tone="warn" title="`unknown` is the one to handle deliberately">
              <Inline text="It means the attempt came back with no verdict, so the message may or may not have gone out. `POST /sends/{id}/retry` refuses it with **409 `INDETERMINATE`** instead of guessing, because a retry under the same key could double-send. Reconcile at the provider, or clone the draft under a new idempotency key. An autonomous client should escalate here, not loop." />
            </NoteBox>

            {/* Errors. */}
            <SectionHeading id="errors">Error codes</SectionHeading>
            {/* Braces, not a bare attribute: a JSX attribute string is not a JS
                string literal, so the escaped quotes this sentence needs would
                render as backslashes. */}
            <Prose
              text={
                'Every failure has one shape, `{"error": {"code", "message"}}`, because a client that has to guess whether today\'s 409 is `{error: "…"}` or `{message: "…"}` ends up string-matching, and then our error text becomes their API contract. So switch on `code` and show `message`.'
              }
            />
            <DocTable
              head={["Code", "HTTP", "Means", "Do"]}
              rows={ERROR_CODES.map((e) => [`\`${e.code}\``, String(e.status), e.meaning, e.action])}
            />

            {/* Rate limits. */}
            <SectionHeading id="rate-limits">Rate limits</SectionHeading>
            <Prose text="Token buckets, per user, so a burst is fine while the sustained rate stays capped. The threat is specific. A key that leaks, or a client stuck in a retry loop, spending somebody's Gmail quota, and that is a hard daily ceiling no amount of backoff gets back." />
            <DocTable
              head={["Bucket", "Limit", "Covers"]}
              rows={RATE_LIMITS.map((r) => [r.name, r.limit, r.covers])}
            />
            <Prose text="A 429 carries `Retry-After`, and that value comes out of the bucket's own arithmetic instead of some guessed constant, so a client that obeys it succeeds on the next try." />

            <footer className="mt-16 border-t border-line pt-6">
              <p className="mb-3 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                For agents
              </p>
              <ul className="space-y-1.5">
                {machineFiles.map((file) => (
                  <li key={file.name} className="flex flex-wrap items-baseline gap-x-2">
                    <a
                      href={file.href}
                      className="inline-flex items-center gap-1 font-mono text-[12px] text-indigo-300 transition-colors hover:text-indigo-200"
                    >
                      {file.name}
                      <ArrowUpRightIcon className="h-3 w-3" />
                    </a>
                    <span className="text-[12px] text-neutral-500">{file.what}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-[12px] text-neutral-600">
                The API itself runs on the Convex deployment at{" "}
                <code className="rounded border border-line bg-ink-850 px-1 py-0.5 font-mono text-[0.9em] text-indigo-200">
                  {BASE_URL}
                </code>. These files come from this app. Both are public.
                <span className="mx-2">·</span>
                <Link href="/dashboard" className="text-indigo-300 transition-colors hover:text-indigo-200">
                  Back to the app
                </Link>
              </p>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
