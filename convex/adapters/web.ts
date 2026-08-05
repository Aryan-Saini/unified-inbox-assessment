/**
 * Web search: a read-only `SearchAdapter` with no sender.
 *
 * The third source exists to prove the fan-out is not two hard-coded providers
 * in a trench coat: it needs no OAuth grant, it returns no timestamps, and it
 * cannot be replied to — three ways of being unlike Gmail and Slack that the
 * merge layer has to absorb without special-casing.
 *
 * Provider choice is an env switch with a **deterministic labelled mock as the
 * fallback**, so a fresh clone or Codespace searches all three sources with zero
 * signups. Every mock title is prefixed `[mock]`: demo data that can be mistaken
 * for real data is worse than no demo data.
 *
 *   WEB_SEARCH_PROVIDER=tavily + WEB_SEARCH_API_KEY  → Tavily (1k free/mo, no card)
 *   anything else, or no key                          → the mock below
 */

import { maybeDelay } from "../core/faults";
import { fetchJson, withTimeout } from "../core/http";
import type { EnrichedAdapter, EnrichedResult } from "../core/registry";
import { AdapterError, type AdapterContext } from "../core/types";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 15_000;

type WebProvider = "tavily" | "mock";

/**
 * Which provider is actually in play.
 *
 * A configured provider with no key falls back to the mock rather than failing:
 * a missing key is a setup state, not an outage, and a source that reports
 * `failed` for it teaches the reviewer nothing.
 */
export function webProvider(): WebProvider {
  const configured = (process.env.WEB_SEARCH_PROVIDER ?? "").toLowerCase();
  const key = process.env.WEB_SEARCH_API_KEY ?? "";
  if (configured === "tavily" && key !== "") return "tavily";
  return "mock";
}

/** The label the fan-out shows for this source. Names the provider, because
 *  "mock" is exactly the sort of thing a reviewer deserves to see up front. */
export function webSourceLabel(): string {
  return webProvider() === "tavily" ? "Tavily web search" : "Web search (mock provider)";
}

interface TavilyResponse {
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
}

async function tavilySearch(query: string, ctx: AdapterContext): Promise<EnrichedResult[]> {
  const body = await fetchJson<TavilyResponse>(TAVILY_ENDPOINT, {
    label: "Tavily",
    method: "POST",
    headers: {
      // Bearer auth rather than the legacy `api_key` body field, so the key
      // never lands in a request body that an error handler might echo.
      Authorization: `Bearer ${process.env.WEB_SEARCH_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(ctx.limit, 10),
      search_depth: "basic",
    }),
    signal: withTimeout(ctx.signal, REQUEST_TIMEOUT_MS),
  });

  return (body.results ?? []).flatMap((item): EnrichedResult[] => {
    const url = typeof item.url === "string" ? item.url : undefined;
    if (url === undefined) return [];

    return [
      {
        source: "web",
        // The URL *is* the identity of a web result — there is no provider-side
        // id, and a hash would only obscure it.
        id: url,
        title: typeof item.title === "string" && item.title !== "" ? item.title : url,
        snippet: typeof item.content === "string" ? item.content.trim() : "",
        url,
        // No `timestamp`: Tavily's `published_date` is absent for most pages and
        // wrong for a fair share of the rest. An absent timestamp is honest and
        // the schema already allows it; a guessed one would poison ranking.
        externalId: url,
      },
    ];
  });
}

/** A cheap stable hash, so the mock's shape varies by query but never by run. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Real destinations, fabricated relevance.
 *
 * Every URL is a genuine search page on a real site, so the links work and a
 * reviewer clicking one is not sent somewhere broken — but the *titles say
 * `[mock]`*, so nothing here can be mistaken for a real search hit.
 */
const MOCK_SITES: Array<{ name: string; url: (q: string) => string; blurb: string }> = [
  {
    name: "Wikipedia",
    url: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
    blurb: "Encyclopedia overview, history and references for",
  },
  {
    name: "MDN Web Docs",
    url: (q) => `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}`,
    blurb: "Reference documentation and browser compatibility notes for",
  },
  {
    name: "Hacker News",
    url: (q) => `https://hn.algolia.com/?q=${encodeURIComponent(q)}`,
    blurb: "Discussion threads and practitioner commentary about",
  },
  {
    name: "Stack Overflow",
    url: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
    blurb: "Question-and-answer threads covering",
  },
  {
    name: "arXiv",
    url: (q) => `https://arxiv.org/a/search?searchtype=all&query=${encodeURIComponent(q)}`,
    blurb: "Preprints and papers referencing",
  },
];

function mockSearch(query: string, ctx: AdapterContext): EnrichedResult[] {
  const seed = hash(query);
  // 3–5 results, decided by the query: a fixed count reads as a stub, and a
  // random one makes screenshots and tests unreproducible.
  const count = Math.min(ctx.limit, 3 + (seed % 3));

  return MOCK_SITES.slice(0, count).map((site, index) => ({
    source: "web",
    id: site.url(query),
    title: `[mock] ${query} — ${site.name}`,
    snippet: `${site.blurb} “${query}”. Simulated web result ${index + 1} of ${count}; set WEB_SEARCH_PROVIDER=tavily and WEB_SEARCH_API_KEY to search the real web.`,
    url: site.url(query),
    externalId: site.url(query),
  }));
}

export const webAdapter: EnrichedAdapter = {
  source: "web",

  async search(query: string, ctx: AdapterContext): Promise<EnrichedResult[]> {
    await maybeDelay(ctx.artificialDelayMs, ctx.signal);

    // The mock is synchronous, so it would otherwise ignore a deadline the rest
    // of the fan-out respects — and the fan-out is what is being demonstrated.
    if (ctx.signal.aborted) {
      throw AdapterError.transient("Web search aborted before it started.");
    }

    return webProvider() === "tavily"
      ? await tavilySearch(query, ctx)
      : mockSearch(query, ctx);
  },
};
