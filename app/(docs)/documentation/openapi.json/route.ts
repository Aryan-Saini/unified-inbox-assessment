import { openApiDocument } from "../openapi";
import { docsOrigin } from "../origin";
import { jsonResponse, preflightResponse } from "../serve";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return jsonResponse(openApiDocument(await docsOrigin()));
}

export const OPTIONS = preflightResponse;
