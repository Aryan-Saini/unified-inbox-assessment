import { renderIndex } from "../markdown";
import { docsOrigin } from "../origin";
import { preflightResponse, textResponse } from "../serve";

/** Reads the request host, so the URLs it hands out are the ones that resolve. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return textResponse(renderIndex(await docsOrigin()));
}

export const OPTIONS = preflightResponse;
