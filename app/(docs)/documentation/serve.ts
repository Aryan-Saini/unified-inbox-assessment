/**
 * Response plumbing for the machine-readable copies of the documentation.
 *
 * Three properties every one of them needs, and each is a way an agent's fetch
 * would otherwise fail:
 *
 *  - **`text/plain` with an explicit charset.** A `.md` served as
 *    `application/octet-stream` gets downloaded rather than read, and a shell
 *    tool that pipes the body into a model wants text.
 *  - **Permissive CORS.** These files carry no credential and describe a
 *    public interface, so a browser-based agent should be able to `fetch` them
 *    from anywhere.
 *  - **`GET` and `HEAD` and `OPTIONS`.** Clients probe before they read.
 */

const SHARED_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  // Short rather than immutable: the documents embed the origin they were served
  // from, and a proxy holding one for a day would hand out another host's URLs.
  "cache-control": "public, max-age=300, must-revalidate",
};

export function textResponse(body: string, contentType = "text/plain"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": `${contentType}; charset=utf-8`, ...SHARED_HEADERS },
  });
}

export function jsonResponse(body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...SHARED_HEADERS },
  });
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: SHARED_HEADERS });
}
