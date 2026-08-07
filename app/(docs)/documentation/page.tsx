import type { Metadata } from "next";
import { DocPageView } from "./DocPageView";
import { docSections, findPage } from "./pages";
import { docsOrigin } from "./origin";

/**
 * The documentation index.
 *
 * Its own file rather than a case in the catch-all because `/documentation` is
 * the URL the app links to and the one a reviewer types, so it should be a
 * route in its own right — and because the alternates in the head, which point
 * an agent at the markdown and OpenAPI copies, belong on the entry page.
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

export default async function DocumentationIndex() {
  const origin = await docsOrigin();
  const sections = docSections(origin);
  const page = findPage(sections, "")!;

  return <DocPageView page={page} sections={sections} origin={origin} />;
}
