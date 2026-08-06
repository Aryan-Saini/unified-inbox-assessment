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
import { spawn } from "node:child_process";
// Next does not re-export this, so it is a deep import into a pinned version.
// It breaks loudly at startup rather than quietly, which is the tolerable kind.
import { createSelfSignedCertificate } from "next/dist/lib/mkcert.js";
import { lanAddress } from "./lan-address.mjs";

const host = lanAddress();

if (!host) {
  console.error("No LAN address found — is this machine on Wi-Fi or Ethernet?");
  process.exit(1);
}

// Always covers localhost, 127.0.0.1 and ::1 in addition to what it is passed.
// The first run downloads mkcert and installs its root CA, which prompts for a
// password; later runs are silent. It regenerates the leaf each time rather than
// reusing it, because its cached-certificate check matches host names, not IPs.
const certificate = await createSelfSignedCertificate(host);

if (!certificate) {
  console.error("Could not generate a dev certificate — see the mkcert error above.");
  process.exit(1);
}

console.log(`Phone: https://${host} — accept the certificate warning once.`);

spawn(
  "next",
  [
    "dev",
    "-H",
    "0.0.0.0",
    "--experimental-https",
    "--experimental-https-key",
    certificate.key,
    "--experimental-https-cert",
    certificate.cert,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", shell: true },
).on("exit", (code) => process.exit(code ?? 0));
