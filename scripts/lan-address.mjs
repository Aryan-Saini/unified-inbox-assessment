import { networkInterfaces } from "node:os";

/**
 * This machine's LAN IPv4 address — the one another device on the same Wi-Fi can
 * route to — or `undefined` when there is no such interface.
 *
 * Shared by `dev-lan.mjs`, which needs it in the dev certificate, and
 * `next.config.ts`, which needs it in `allowedDevOrigins`. Those two have to
 * agree: a certificate the phone accepts still leaves every `/_next/*` request
 * from it answered with 403 if the origin is not on the allowlist.
 */
export function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}
