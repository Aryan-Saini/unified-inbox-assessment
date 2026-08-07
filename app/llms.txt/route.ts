import { renderIndex } from "../(docs)/documentation/markdown";
import { docsOrigin } from "../(docs)/documentation/origin";
import { preflightResponse, textResponse } from "../(docs)/documentation/serve";

/**
 * `/llms.txt` at the site root.
 *
 * The [llms.txt](https://llmstxt.org) convention puts the index at the origin
 * root, which is where an agent handed nothing but a hostname will look. It is
 * the same document `/documentation/llms.txt` serves rather than a pointer to
 * it: a redirect costs a round trip and some fetchers do not follow one.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return textResponse(renderIndex(await docsOrigin()));
}

export const OPTIONS = preflightResponse;
