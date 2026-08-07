/**
 * The documentation, as a site instead of a scroll.
 *
 * This used to be one page about thirty thousand pixels tall, with a rail of
 * anchors down the side. That is fine to skim and miserable to *use*: the
 * position of the scrollbar is the only sense of place you get, nothing is
 * linkable in a way that survives an edit above it, and the reader who wanted
 * one endpoint paid for the whole reference.
 *
 * So the same content — still out of `spec.ts` and `guide.ts`, still rendered
 * to markdown and OpenAPI from those same sources — is split into short pages
 * arranged in three sections, and this file is the arrangement. Everything
 * navigational reads from here: the sidebar, the "On this page" rail, the
 * previous/next cards, the per-page metadata, and the routing itself.
 *
 * One consequence worth stating: a page's slug and a heading's id are the URL.
 * They are written down rather than derived from titles, because a derived
 * anchor changes the moment somebody rewords a heading and every link into it
 * breaks with nothing failing.
 */

import { guide, type Guide } from "./guide";
import { SCHEMAS, SECTIONS, type Section } from "./spec";

export const DOCS_ROOT = "/documentation";

/** Icons cross the server/client boundary as names — components cannot. */
export type GroupIcon =
  | "rocket"
  | "lock"
  | "spark"
  | "braces"
  | "layers"
  | "plug"
  | "inbox"
  | "book";

/** A row in the right-hand rail. `depth` 2 is indented under the heading above. */
export interface TocEntry {
  id: string;
  label: string;
  depth?: 1 | 2;
  method?: "GET" | "POST";
}

/**
 * What a page actually renders. The data travels with the discriminant so the
 * renderer never has to go looking a second time for something this file
 * already resolved.
 */
export type PageBody =
  | { kind: "overview" }
  | { kind: "guide"; guide: Guide }
  | { kind: "reference"; section: Section }
  | { kind: "shapes" }
  | { kind: "send-statuses" }
  | { kind: "errors" }
  | { kind: "rate-limits" };

export interface DocPage {
  /** `""` is the documentation index. Otherwise a path under `/documentation`. */
  slug: string;
  href: string;
  title: string;
  /**
   * What the sidebar calls it, when that is not the title. The index is
   * "Unified Inbox API" as a heading and "Overview" as a row: the heading is
   * naming the API and the row is naming its position in a list.
   */
  navLabel?: string;
  /** The line under the title, and the page's meta description. */
  blurb: string;
  /** Which of the three sections this belongs to — the prev/next cards name it. */
  section: string;
  toc: TocEntry[];
  body: PageBody;
}

/** A labelled run of pages inside a section. An absent label renders bare. */
export interface PageGroup {
  label?: string;
  pages: DocPage[];
}

/** A top-level section — one row in the sidebar's switcher. */
export interface DocSection {
  id: string;
  label: string;
  icon: GroupIcon;
  groups: PageGroup[];
}

/* ----------------------------------------------------------------- the pages */

/** One line per page, kept together so the voice across them stays even. */
const BLURBS: Record<string, string> = {
  quickstart: "Make a key, prove it works, and run a search — in two shell blocks.",
  authentication: "One credential, one header, and what happens to a key after you close the dialog.",
  agents: "Plain-text copies of all of this, at stable URLs, so an agent needs no browser.",
  "send-protocol": "Four requests between a draft and a delivery. The API enforces three of them.",
  idempotency: "Why a double tap sends once, and why the second response never says it was second.",
  failures: "The attempt timeline, what is safe to retry, and the one status you must never loop on.",
  conventions: "Casing, timestamps, ids, list caps, and the bare paths the specification writes literally.",
};

const SECTION_BLURBS: Record<string, string> = {
  connections: "The accounts a search reaches and a draft can be sent through.",
  searching: "Fan a query across Gmail, Slack and the web, then read the rows back.",
  sending: "Draft, read, confirm, send. The safe-send gate, as four routes.",
  outbox: "What happened to everything you sent, attempt by attempt.",
};

function guidePage(entry: Guide): DocPage {
  return {
    slug: entry.id,
    href: `${DOCS_ROOT}/${entry.id}`,
    title: entry.title,
    blurb: BLURBS[entry.id] ?? "",
    section: "Guide",
    // The rail is exactly the subheadings the section declares. Nothing is
    // scraped out of prose, so a heading that is not in `guide.ts` cannot
    // appear here and one that is cannot go missing.
    toc: entry.blocks
      .filter((block) => block.kind === "h")
      .map((block) => ({ id: block.id, label: block.text })),
    body: { kind: "guide", guide: entry },
  };
}

function referencePage(section: Section): DocPage {
  return {
    slug: `reference/${section.id}`,
    href: `${DOCS_ROOT}/reference/${section.id}`,
    title: section.title,
    blurb: SECTION_BLURBS[section.id] ?? "",
    section: "API reference",
    toc: section.endpoints.map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.path,
      method: endpoint.method,
    })),
    body: { kind: "reference", section },
  };
}

/**
 * The whole site, in reading order.
 *
 * Parameterised by origin for the reason `guide()` is: half the value of the
 * agent page is that its URLs are copy-pasteable, and the app origin is not
 * knowable at build time.
 */
export function docSections(origin: string): DocSection[] {
  const guides = guide(origin);
  const byId = (id: string): Guide => {
    const found = guides.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`guide section "${id}" is missing`);
    return found;
  };

  const overview: DocPage = {
    slug: "",
    href: DOCS_ROOT,
    title: "Unified Inbox API",
    navLabel: "Overview",
    blurb:
      "Search Gmail, Slack and the web from one place, and only send a reply after you have explicitly confirmed it.",
    section: "Guide",
    toc: [
      { id: "what-this-is", label: "What this is" },
      { id: "base-url", label: "Base URL" },
      { id: "the-one-rule", label: "The one rule that matters" },
      { id: "for-agents", label: "For agents" },
    ],
    body: { kind: "overview" },
  };

  return [
    {
      id: "guide",
      label: "Guide",
      icon: "rocket",
      groups: [
        { pages: [overview] },
        {
          label: "Get started",
          pages: [byId("quickstart"), byId("authentication"), byId("agents")].map(guidePage),
        },
        {
          label: "Core concepts",
          pages: [
            byId("send-protocol"),
            byId("idempotency"),
            byId("failures"),
            byId("conventions"),
          ].map(guidePage),
        },
      ],
    },
    {
      id: "reference",
      label: "API reference",
      icon: "braces",
      groups: [{ label: "Endpoints", pages: SECTIONS.map(referencePage) }],
    },
    {
      id: "appendix",
      label: "Appendix",
      icon: "layers",
      groups: [
        {
          pages: [
            {
              slug: "shapes",
              href: `${DOCS_ROOT}/shapes`,
              title: "Object shapes",
              blurb:
                "Every response object, field by field, as the runtime validators enforce them.",
              section: "Appendix",
              toc: Object.keys(SCHEMAS).map((name) => ({ id: `shape-${name}`, label: name })),
              body: { kind: "shapes" },
            },
            {
              slug: "send-statuses",
              href: `${DOCS_ROOT}/send-statuses`,
              title: "Send statuses",
              blurb: "Where a send can be, and what you are supposed to do about it.",
              section: "Appendix",
              toc: [
                { id: "the-statuses", label: "The statuses" },
                { id: "handling-unknown", label: "Handling `unknown`" },
              ],
              body: { kind: "send-statuses" },
            },
            {
              slug: "errors",
              href: `${DOCS_ROOT}/errors`,
              title: "Error codes",
              blurb: "One failure shape, one field to switch on, and a message meant for a human.",
              section: "Appendix",
              toc: [
                { id: "the-shape", label: "The shape" },
                { id: "the-codes", label: "The codes" },
              ],
              body: { kind: "errors" },
            },
            {
              slug: "rate-limits",
              href: `${DOCS_ROOT}/rate-limits`,
              title: "Rate limits",
              blurb: "Token buckets, per user, and a `Retry-After` that is worth obeying.",
              section: "Appendix",
              toc: [
                { id: "the-buckets", label: "The buckets" },
                { id: "retry-after", label: "Retry-After" },
              ],
              body: { kind: "rate-limits" },
            },
          ],
        },
      ],
    },
  ];
}

/* --------------------------------------------------------------- lookups */

export function allPages(sections: DocSection[]): DocPage[] {
  return sections.flatMap((section) => section.groups.flatMap((group) => group.pages));
}

export function findPage(sections: DocSection[], slug: string): DocPage | undefined {
  return allPages(sections).find((page) => page.slug === slug);
}

/**
 * The pages either side of this one, for the footer cards.
 *
 * Reading order is the order of this file, which runs straight through the
 * three sections — so "next" at the end of the guide is the first reference
 * page rather than a dead end, and the whole site is walkable with one key.
 */
export function neighbours(
  sections: DocSection[],
  slug: string,
): { previous?: DocPage; next?: DocPage } {
  const pages = allPages(sections);
  const index = pages.findIndex((page) => page.slug === slug);
  if (index === -1) return {};
  return { previous: pages[index - 1], next: pages[index + 1] };
}
