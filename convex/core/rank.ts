/**
 * The merge layer's ranking function.
 *
 * Three sources produce three incompatible notions of relevance — Gmail orders
 * by its own search score, Slack by recency, a web provider by whatever it
 * likes — so a merged list has to be re-scored locally or it is really just
 * three lists stapled together. This is that local score, and it is deliberately
 * simple and pure: no provider fields, no I/O, no clock of its own.
 *
 * The score is computed **at write time** and stored on the row. Two reasons:
 * a re-render must not reshuffle a list the reader is looking at, and the REST
 * API's `?order=rank` has to be stable across requests. Arrival order stays
 * available separately via `seq`, so the live UI can append while the API can
 * rank.
 */

import type { Result, Source } from "./types";

/**
 * How much a source is trusted when everything else ties.
 *
 * Mail the user personally received outranks a public web page for the same
 * terms; this only breaks ties, so it never buries a strong match.
 */
const SOURCE_WEIGHT: Record<Source, number> = {
  gmail: 6,
  slack: 5,
  web: 2,
};

/** Term hit in the title. Weighted well above a snippet hit — a subject line
 *  matching the query is the strongest signal any of the three providers give. */
const TITLE_HIT = 9;
const SNIPPET_HIT = 3;

/** Recency is capped rather than unbounded so a fresh trivial match cannot
 *  outrank a month-old exact one. Full marks under an hour, nothing past 30d. */
const RECENCY_MAX = 25;
const RECENCY_WINDOW_MS = 30 * 24 * 3600 * 1000;

/** Words too common to carry signal; scoring them rewards long queries only. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "to", "was", "with",
]);

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

function recencyScore(timestamp: string | undefined, now: number): number {
  if (timestamp === undefined) return 0;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return 0;

  const age = now - at;
  if (age <= 3_600_000) return RECENCY_MAX;
  if (age >= RECENCY_WINDOW_MS) return 0;
  // Linear rather than exponential: an operator reading the number should be
  // able to predict it, and nothing here justifies a curve.
  return Math.round(RECENCY_MAX * (1 - age / RECENCY_WINDOW_MS));
}

/**
 * Score one normalised result against the query that produced it.
 *
 * `now` is a parameter, not a `Date.now()` call, so the function is pure — the
 * same inputs always give the same score, which is what makes it testable and
 * what keeps a stored score explainable after the fact.
 */
export function scoreResult(
  result: Pick<Result, "title" | "snippet" | "timestamp"> & { source: Source },
  query: string,
  now = Date.now(),
): number {
  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();

  let score = SOURCE_WEIGHT[result.source] + recencyScore(result.timestamp, now);

  for (const term of queryTerms(query)) {
    if (title.includes(term)) score += TITLE_HIT;
    if (snippet.includes(term)) score += SNIPPET_HIT;
  }

  // The whole query appearing verbatim is a materially better match than its
  // terms appearing separately, and cheap to check.
  const phrase = query.trim().toLowerCase();
  if (phrase.length > 2 && (title.includes(phrase) || snippet.includes(phrase))) {
    score += TITLE_HIT;
  }

  return score;
}
