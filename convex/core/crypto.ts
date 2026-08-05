/**
 * Token encryption, hashing and random-id helpers.
 *
 * OAuth tokens are the most sensitive thing this system holds, so they are
 * encrypted with AES-256-GCM before they reach the database. A dump of the
 * `connections` table on its own grants nobody anything — you also need
 * `TOKEN_ENCRYPTION_KEY`, which lives only in the deployment environment.
 *
 * GCM (rather than CBC) because it is authenticated: a tampered ciphertext
 * fails to decrypt instead of silently yielding garbage that we would then send
 * to Google as a bearer token.
 *
 * Everything here uses Web Crypto, which the default Convex runtime provides,
 * so none of this forces a file into the Node runtime.
 */

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12; // 96 bits, the size GCM is defined for.
const KEY_BYTES = 32; // AES-256.

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without relying on `btoa`, which is not guaranteed in every runtime. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromBase64(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);

  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1]);
    const c2 = BASE64_ALPHABET.indexOf(clean[i + 2]);
    const c3 = BASE64_ALPHABET.indexOf(clean[i + 3]);

    if (byteIndex < bytes.length) bytes[byteIndex++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0 && byteIndex < bytes.length) bytes[byteIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0 && byteIndex < bytes.length) bytes[byteIndex++] = ((c2 & 0x03) << 6) | c3;
  }
  return bytes;
}

/** URL-safe base64, for values that ride in a query string (PKCE, state). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function requireKeyMaterial(): Uint8Array {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (raw === undefined || raw === "") {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set on the Convex deployment. " +
        "Generate one with `openssl rand -base64 32` and set it with " +
        "`npx convex env set TOKEN_ENCRYPTION_KEY <value>`.",
    );
  }

  const key = fromBase64(raw);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
  return key;
}

async function importKey(): Promise<CryptoKey> {
  // Imported per call rather than cached in module scope: Convex may reuse an
  // isolate across deployments, and a stale key would fail confusingly.
  return await crypto.subtle.importKey(
    "raw",
    requireKeyMaterial() as BufferSource,
    ALGORITHM,
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Which token a ciphertext is, and which row it belongs to.
 *
 * This is bound into the ciphertext as GCM additional authenticated data, so a
 * ciphertext is only decryptable in the exact position it was written to. Moving
 * a row's `refreshTokenCipher` into another row's `accessTokenCipher` — or into
 * another connection entirely — fails to decrypt rather than silently handing a
 * worker somebody else's token.
 *
 * `connectionId` is the right binding rather than the identity triple because it
 * survives a reconnect: a re-grant upserts the same row, so a kept refresh token
 * still decrypts.
 */
export interface TokenAad {
  /** `"gmail"` / `"slack"`. */
  provider: string;
  connectionId: string;
  tokenType: "access" | "refresh";
}

/**
 * Envelope version. Prefixed to every ciphertext so the format can change
 * without a migration guessing game: a v1 blob is recognisably v1 forever, and
 * a v2 reader can refuse (or upgrade) it deliberately.
 */
const ENVELOPE_VERSION = 1;

/**
 * The AAD string. Written out longhand rather than JSON-stringified so its bytes
 * are stable regardless of key order or serialiser behaviour — the whole
 * mechanism fails closed if the two sides ever disagree by one byte.
 */
function aadBytes(aad: TokenAad): Uint8Array {
  return new TextEncoder().encode(
    `v${ENVELOPE_VERSION}|${aad.provider}|${aad.connectionId}|${aad.tokenType}`,
  );
}

/**
 * Encrypt a token. The IV is random per call, so encrypting the same token twice
 * yields different output — an attacker cannot tell which two connections share
 * a token.
 *
 * Layout: `[version:1][iv:12][ciphertext+tag]`, base64.
 */
export async function encryptToken(
  plaintext: string,
  aad: TokenAad,
): Promise<string> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: ALGORITHM,
        iv: iv as BufferSource,
        additionalData: aadBytes(aad) as BufferSource,
      },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );

  const packed = new Uint8Array(1 + iv.length + ciphertext.length);
  packed[0] = ENVELOPE_VERSION;
  packed.set(iv, 1);
  packed.set(ciphertext, 1 + iv.length);
  return toBase64(packed);
}

/**
 * Decrypt a token. Throws if the ciphertext was tampered with, if it was written
 * for a different row or token slot, or if the envelope version is unknown.
 */
export async function decryptToken(
  packedBase64: string,
  aad: TokenAad,
): Promise<string> {
  const key = await importKey();
  const packed = fromBase64(packedBase64);

  if (packed.length <= 1 + IV_BYTES) {
    throw new Error("Token ciphertext is truncated or malformed.");
  }
  if (packed[0] !== ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported token envelope version ${packed[0]} (expected ${ENVELOPE_VERSION}).`,
    );
  }

  const iv = packed.slice(1, 1 + IV_BYTES);
  const ciphertext = packed.slice(1 + IV_BYTES);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: ALGORITHM,
      iv: iv as BufferSource,
      additionalData: aadBytes(aad) as BufferSource,
    },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/** Hex SHA-256. Used for API-key lookup and the draft confirmation digest. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input) as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Base64url SHA-256. This is exactly the PKCE `S256` code challenge transform,
 * which needs the raw digest rather than the hex rendering above.
 */
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input) as BufferSource,
  );
  return toBase64Url(new Uint8Array(digest));
}

/** A URL-safe random token of `bytes` entropy. */
export function randomToken(bytes = 24): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Constant-time string comparison, so comparing a presented API key digest
 * against the stored one cannot be timed to recover it byte by byte.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
