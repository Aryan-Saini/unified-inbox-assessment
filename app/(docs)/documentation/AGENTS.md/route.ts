import { renderAgentsMd } from "../markdown";
import { docsOrigin } from "../origin";
import { preflightResponse, textResponse } from "../serve";

export const dynamic = "force-dynamic";

/**
 * `text/markdown`, not `text/plain`: this one is meant to be saved to disk as
 * `AGENTS.md` or `CLAUDE.md`, and the type is the hint a fetching tool uses to
 * decide it is a document rather than a page to render.
 */
export async function GET(): Promise<Response> {
  return textResponse(renderAgentsMd(await docsOrigin()), "text/markdown");
}

export const OPTIONS = preflightResponse;
