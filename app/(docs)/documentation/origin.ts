import { headers } from "next/headers";

/**
 * The origin this documentation is being served from.
 *
 * Read off the request rather than configured, because every URL in the agent
 * section is meant to be pasted into a shell — and the right answer differs
 * between `http://localhost:3000`, a Codespace forwarded port and the deployed
 * hand-in. A hand-set env var is exactly the thing that goes stale and hands an
 * agent a `curl` that 404s.
 *
 * `x-forwarded-*` first: behind Vercel or a Codespace proxy, `host` is the
 * internal name and the forwarded pair is the one the caller can actually reach.
 * The protocol is inferred only when nothing said — loopback is the one case
 * where guessing `https` would be wrong.
 */
export async function docsOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const forwardedProto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const protocol = forwardedProto ?? (isLoopback ? "http" : "https");
  return `${protocol}://${host}`;
}
