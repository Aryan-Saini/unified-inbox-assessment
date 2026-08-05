/**
 * The canonical form of a draft — the exact bytes the confirm gate hashes.
 *
 * This file is small and has its own test file because it is load-bearing out of
 * proportion to its size: **the confirm gate is only as strong as the stability
 * of this string**. If it can produce two different strings for the same payload,
 * confirmed sends start failing for no reason. If it can produce the *same*
 * string for two different payloads, someone can confirm one message and send
 * another, which is the failure this whole subsystem exists to prevent.
 *
 * Three properties, each bought deliberately:
 *
 *  1. **Unambiguous framing.** Every field is written length-prefixed
 *     (`<byteLength>:<value>`) rather than simply joined by a separator. A plain
 *     `join("|")` collides — `to = "a|b", subject = "c"` and
 *     `to = "a", subject = "b|c"` produce identical strings — and a collision here
 *     is a confirmed-payload bypass, not a cosmetic bug.
 *
 *  2. **`revision` is inside the digest.** Without it, editing a draft A → B → A
 *     would make a stale confirmation of "A" valid again: the confirm-then-mutate
 *     hole, reopened by a round trip. Every edit bumps the revision, so every
 *     confirmation is bound to one specific version of the draft.
 *
 *  3. **Absent is not empty.** A missing subject and an empty-string subject are
 *     different payloads (Slack has no subject at all), so they get different
 *     tokens rather than both collapsing to `""`.
 *
 * Line endings are normalised to `\n` because a browser textarea can submit
 * `\r\n` where the same body typed elsewhere submits `\n`. Normalising is what
 * keeps "the same text" hashing the same way; it is applied identically on the
 * review and the send side, so nothing can disagree.
 *
 * No Convex imports: this is pure string handling, unit-testable on its own.
 */

/** Schema marker. Bump it if the field list or framing ever changes, so an old
 *  stored hash is recognisably old rather than silently wrong. */
export const CANONICAL_VERSION = "v1";

/** Token for a field that is absent, distinct from any possible value (a real
 *  value always renders as `<digits>:…`, which this cannot be mistaken for). */
const ABSENT = "-";

/** The fields of a draft that determine what actually leaves the system. */
export interface DraftContent {
  channel: string;
  connectionId: string;
  /** Recipient: an email address, or a Slack channel id. */
  to: string;
  subject?: string;
  body: string;
}

export interface CanonicalDraft extends DraftContent {
  /** Incremented on every edit; folded into the digest. */
  revision: number;
}

/** `\r\n` / `\r` -> `\n`, so the same visible text always hashes the same. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** UTF-8 length, so the prefix frames bytes rather than UTF-16 code units. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function field(value: string | undefined): string {
  if (value === undefined) return ABSENT;
  const normalized = normalizeNewlines(value);
  return `${byteLength(normalized)}:${normalized}`;
}

/**
 * The content fields, in fixed order, without the version or revision.
 *
 * Used for the two "is this the same message?" comparisons that must ignore
 * revisions: de-duplicating `drafts.create` on a re-used idempotency key, and
 * checking a frozen `sends` row against the draft it was claimed from. Both ask
 * about the payload, not about how many times it was edited on the way there.
 */
export function canonicalContent(draft: DraftContent): string {
  return [
    field(draft.channel),
    field(draft.connectionId),
    field(draft.to),
    field(draft.subject),
    field(draft.body),
  ].join("|");
}

/**
 * The string the confirmation digest is taken over.
 *
 * Layout: `v1|<revision>|<channel>|<connectionId>|<to>|<subject>|<body>`, every
 * field length-prefixed.
 */
export function canonicalPayload(draft: CanonicalDraft): string {
  return `${CANONICAL_VERSION}|${field(String(draft.revision))}|${canonicalContent(draft)}`;
}
