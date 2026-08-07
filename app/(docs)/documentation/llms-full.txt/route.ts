import { renderFull } from "../markdown";
import { docsOrigin } from "../origin";
import { preflightResponse, textResponse } from "../serve";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return textResponse(renderFull(await docsOrigin()));
}

export const OPTIONS = preflightResponse;
