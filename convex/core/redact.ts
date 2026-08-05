/**
 * Error redaction.
 *
 * The system stores provider errors in full and shows them to the operator —
 * "full error" is one of the requirements, and a truncated error is the reason
 * people give up on debugging. But a provider error body is also the single most
 * likely place for a credential to end up in the database: an echoed
 * `Authorization` header, a `client_secret` in a form dump, a token in a URL.
 *
 * So: keep everything except the things that must never be stored. Every
 * removal leaves a visible marker, so an operator reading the message can tell
 * the difference between "the provider said nothing here" and "we took it out".
 */

/** Long enough for any real provider error; short enough to bound a document. */
export const MAX_ERROR_LENGTH = 4000;

const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers, however they were serialised.
  [/(Bearer\s+)[\w\-._~+/]+=*/gi, `$1${REDACTED}`],
  [/("?authorization"?\s*[:=]\s*"?)[^"',}\s]+/gi, `$1${REDACTED}`],
  // Provider token shapes, which show up in bodies as well as headers.
  [/\bxox[abposr]-[\w-]+/gi, REDACTED],
  [/\bya29\.[\w\-._~+/]+=*/g, REDACTED],
  [/\b1\/\/[\w\-._~+/]{20,}=*/g, REDACTED],
  // JSON/form fields that carry secrets by name.
  [
    /("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|api_key|apiKey)"?\s*[:=]\s*"?)[^"',}&\s]+/gi,
    `$1${REDACTED}`,
  ],
  // `?code=…` on an OAuth callback URL is a one-time credential.
  [/([?&](?:code|state|api_key)=)[^&\s"']+/gi, `$1${REDACTED}`],
];

/**
 * Strip credentials from an error string and bound its length.
 *
 * Applied at the boundary where an error is *written*, not where it is read, so
 * there is no path that stores a raw one and hopes the reader remembers.
 */
export function redactError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;

  let out = message;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }

  if (out.length > MAX_ERROR_LENGTH) {
    return `${out.slice(0, MAX_ERROR_LENGTH)}… [truncated ${out.length - MAX_ERROR_LENGTH} chars]`;
  }
  return out;
}
