/**
 * Deployment environment for tests.
 *
 * Convex functions read their configuration from `process.env`, which in a test
 * run is whatever this file puts there. The values are fixed rather than
 * generated so a ciphertext written by one test is readable by the next and
 * failures are reproducible.
 *
 * The encryption key is a throwaway that only ever exists here — it decodes to
 * exactly 32 bytes, which is what `TOKEN_ENCRYPTION_KEY` requires.
 */

process.env.TOKEN_ENCRYPTION_KEY = "dW5pZmllZC1pbmJveC12aXRlc3QtZml4ZWQta2V5ISE=";

// Tests need to be able to demand a specific failure from a provider.
process.env.ALLOW_FAULT_INJECTION = "true";

// OAuth: dummy client credentials, so the URL builders and token exchanges have
// something to send. No test reaches a real provider.
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-client-secret";
process.env.SLACK_CLIENT_ID = "1234567890.0987654321";
process.env.SLACK_CLIENT_SECRET = "test-slack-client-secret";

// `CONVEX_SITE_URL` is injected by the real deployment; convex-test does not
// provide it, and the OAuth redirect URI is derived from it.
process.env.CONVEX_SITE_URL = "https://test-deployment.convex.site";
process.env.APP_BASE_URL = "https://app.test";

// The web adapter falls back to a labelled deterministic mock without a key.
process.env.WEB_SEARCH_PROVIDER = "mock";
