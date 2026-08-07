#!/usr/bin/env node
// `next dev` over HTTPS, reachable from a phone on the same Wi-Fi.
//
// This is what the t3 "Dev" script runs, because plain `pnpm dev` cannot sign
// anyone in from another device. (`pnpm dev` stays as it was for Codespaces,
// where the forwarded URL is already HTTPS and there is no LAN to speak of.)
//
// `http://localhost:3000` is a *secure context* by special case, but
// `http://10.0.0.124:3000` is not, so the browser withholds `crypto.subtle` and
// `crypto.randomUUID`. clerk-js downloads fine and then never finishes loading:
// it never reaches its first Frontend API call, `useAuth().isLoaded` stays
// false, and the app sits on "Checking your session…" until you close the tab.
// Nothing is logged, because nothing threw — the handshake simply never starts.
//
// The fix is the origin, not the code. Over HTTPS clerk-js behaves on the LAN
// address exactly as it does on localhost.
//
//   pnpm dev:lan        # any extra args are passed through, e.g. -p 3001
//
// `next dev --experimental-https` would do the certificate itself, but only for
// whatever `-H` says, so it forces a choice between localhost and the LAN
// address. Calling Next's own mkcert helper directly instead gets one certificate
// covering both, which is what lets this bind every interface and keep
// `https://localhost:3000` working for desktop and the t3 preview pane.
//
// The phone will warn about the certificate on first visit: mkcert's root CA is
// trusted on this Mac, not there. Accepting it is enough — a browser treats an
// origin whose certificate you accepted as secure, which is the whole point.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
// Next does not re-export this, so it is a deep import into a pinned version.
// It breaks loudly at startup rather than quietly, which is the tolerable kind.
import { createSelfSignedCertificate } from "next/dist/lib/mkcert.js";
import { lanAddress } from "./lan-address.mjs";

const host = lanAddress();

if (!host) {
  console.error("No LAN address found — is this machine on Wi-Fi or Ethernet?");
  process.exit(1);
}

const args = process.argv.slice(2);

/**
 * The port Next would land on, settled here rather than left to it.
 *
 * Next picks the next free port silently when the requested one is taken, so
 * printing the address for the phone before it starts means printing a guess.
 * Claiming the port up front makes the address we print the address it serves.
 */
function requestedPort() {
  const flag = args.findIndex((arg) => arg === "-p" || arg === "--port");
  const explicit = flag === -1 ? process.env.PORT : args[flag + 1];
  const port = Number(explicit);
  return Number.isInteger(port) && port > 0 ? port : 3000;
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });
}

let port = requestedPort();
while (!(await isFree(port))) port += 1;

// Read above and re-added below as the settled value, so a `-p` that was taken
// does not come through twice and win back the port we just moved off.
const passThrough = args.filter((arg, i) => {
  const flag = args[i - 1];
  return arg !== "-p" && arg !== "--port" && flag !== "-p" && flag !== "--port";
});

// Always covers localhost, 127.0.0.1 and ::1 in addition to what it is passed.
// The first run downloads mkcert and installs its root CA, which prompts for a
// password; later runs are silent. It regenerates the leaf each time rather than
// reusing it, because its cached-certificate check matches host names, not IPs.
const certificate = await createSelfSignedCertificate(host);

if (!certificate) {
  console.error("Could not generate a dev certificate — see the mkcert error above.");
  process.exit(1);
}

allowPrivateNetworkOrigins();

console.log(`\nPhone: https://${host}:${port} — accept the certificate warning once.\n`);

/**
 * Let the OAuth callback return to this LAN origin, on the dev deployment only.
 *
 * Without it, connecting Gmail or Slack from the phone ends at `APP_BASE_URL` —
 * `http://localhost:3000`, which on a phone is the phone. `resolveAppOrigin`
 * refuses a private-network origin unless this flag is set, so setting it here
 * ties "the LAN is allowed" to "I am deliberately serving the LAN", and it never
 * reaches the deployed environment.
 *
 * Idempotent, and deliberately non-fatal: `dev:lan` is also how you work offline
 * or on a laptop with no Convex credentials, and neither should stop the server
 * from starting.
 */
function allowPrivateNetworkOrigins() {
  const convex = new URL("../node_modules/.bin/convex", import.meta.url).pathname;
  const read = spawnSync(convex, ["env", "get", "ALLOW_PRIVATE_NETWORK_ORIGINS"], {
    encoding: "utf8",
  });

  if (read.stdout?.trim() === "true") return;

  const write = spawnSync(
    convex,
    ["env", "set", "ALLOW_PRIVATE_NETWORK_ORIGINS", "true"],
    { encoding: "utf8" },
  );

  if (write.status === 0) {
    console.log("Set ALLOW_PRIVATE_NETWORK_ORIGINS=true on the dev deployment.");
  } else {
    console.warn(
      "Could not set ALLOW_PRIVATE_NETWORK_ORIGINS on the dev deployment — " +
        "connecting Gmail or Slack from the phone will return to localhost.\n" +
        `  ${(write.stderr ?? "").trim() || "npx convex env set failed"}`,
    );
  }
}

// The `next` binary by path rather than by name through a shell: `shell: true`
// concatenates rather than escapes, and one of these arguments is a filesystem
// path from outside this script.
const next = new URL("../node_modules/.bin/next", import.meta.url).pathname;

spawn(
  next,
  [
    "dev",
    "-H",
    "0.0.0.0",
    "-p",
    String(port),
    "--experimental-https",
    "--experimental-https-key",
    certificate.key,
    "--experimental-https-cert",
    certificate.cert,
    ...passThrough,
  ],
  { stdio: "inherit" },
).on("exit", (code) => process.exit(code ?? 0));
