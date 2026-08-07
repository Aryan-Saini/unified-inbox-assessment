import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocPageView } from "../DocPageView";
import { docSections, findPage } from "../pages";
import { docsOrigin } from "../origin";

/**
 * Every documentation page except the index.
 *
 * A catch-all rather than a directory per page: the pages are data — they come
 * out of `pages.ts`, which composes them from `guide.ts` and `spec.ts` — so
 * hand-writing a `page.tsx` per slug would mean the route tree and the
 * navigation could disagree, and the way you would find out is a sidebar link
 * to a 404.
 *
 * The static segments in this directory (`llms.txt`, `openapi.json`,
 * `AGENTS.md`) take priority over this route, so the machine-readable copies
 * are unaffected.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string[] }> };

async function resolve(params: Params["params"]) {
  const { slug } = await params;
  const origin = await docsOrigin();
  const sections = docSections(origin);
  return { origin, sections, page: findPage(sections, slug.join("/")) };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { origin, page } = await resolve(params);
  if (page === undefined) return { title: "Not found | Unified Inbox" };

  return {
    title: `${page.title} | Unified Inbox API`,
    description: page.blurb,
    alternates: {
      canonical: `${origin}${page.href}`,
      types: {
        "text/markdown": `${origin}/documentation/llms-full.txt`,
        "application/json": `${origin}/documentation/openapi.json`,
      },
    },
  };
}

export default async function DocumentationPage({ params }: Params) {
  const { origin, sections, page } = await resolve(params);
  if (page === undefined) notFound();

  return <DocPageView page={page} sections={sections} origin={origin} />;
}
