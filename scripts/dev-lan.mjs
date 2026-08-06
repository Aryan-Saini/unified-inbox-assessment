#!/usr/bin/env node
// Serve the dev app to a phone on the same Wi-Fi — over HTTPS, because plain
// http to a LAN IP cannot sign anyone in.
//
// `http://localhost:3001` is a *secure context* by special case, but
// `http://10.0.0.124:3001` is not, so the browser withholds `crypto.subtle` and
// `crypto.randomUUID`. clerk-js downloads fine and then never finishes loading:
// it never reaches its first Frontend API call, `useAuth().isLoaded` stays
// false, and the app sits on "Checking your session…" until you close the tab.
// Nothing is logged, because nothing threw — the handshake simply never starts.
//
// The fix is the origin, not the code: HTTPS makes it a secure context and
// clerk-js behaves exactly as it does on localhost.
//
//   pnpm dev:lan            # any extra args are passed through, e.g. -p 3001
//
// `--experimental-https` has Next generate a certificate with mkcert covering
// whatever `-H` is, which is why the LAN address has to be resolved up front
// rather than left as 0.0.0.0. The trade-off of naming one interface is that
// `localhost` stops answering while this runs — use plain `pnpm dev` for
// desktop-only work.
//
// The phone will warn about the certificate on first visit: mkcert's root CA is
// trusted on this Mac, not there. Accepting it is enough — a browser treats an
// origin whose certificate you accepted as secure, which is the whole point.
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

/** The first non-internal IPv4 address, i.e. the one a phone can route to. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

const host = lanAddress();

if (!host) {
  console.error("No LAN address found — is this machine on Wi-Fi or Ethernet?");
  process.exit(1);
}

console.log(`Serving on https://${host} — accept the certificate warning on the phone.`);

spawn("next", ["dev", "--experimental-https", "-H", host, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
}).on("exit", (code) => process.exit(code ?? 0));
