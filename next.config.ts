import type { NextConfig } from "next";
import { lanAddress } from "./scripts/lan-address.mjs";

const lan = lanAddress();
const codespaceName = process.env.CODESPACE_NAME;
const codespacesDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
const codespaceOrigin =
  codespaceName && codespacesDomain
    ? `${codespaceName}-3000.${codespacesDomain}`
    : undefined;

const nextConfig: NextConfig = {
  reactCompiler: true,

  experimental: {
    // A Codespaces port-forwarding proxy reports a different forwarded host
    // than the browser origin, so Next.js rejects every Server Action as a
    // cross-site request unless the browser's host is listed here. Belt and
    // braces, because the exact hostname is only knowable at boot and is easy
    // to get wrong: the derived entry is empty when the env vars are missing
    // (a plain `next dev` in a terminal that didn't inherit them) and wrong
    // whenever the app isn't on port 3000. The wildcard covers the same
    // Codespace on any port, and the literal fallback covers any Codespace at
    // all — development-only, so a production build never carries it.
    serverActions: {
      allowedOrigins: [
        ...(codespaceOrigin ? [codespaceOrigin] : []),
        ...(codespacesDomain ? [`*.${codespacesDomain}`] : []),
        ...(process.env.NODE_ENV === "development"
          ? ["*.app.github.dev"]
          : []),
      ],
    },
  },

  // Next.js blocks cross-origin requests to dev-only resources, and it only
  // trusts localhost plus whatever `-H` names. `dev:lan` binds every interface so
  // that `https://localhost:3000` keeps working, which leaves the phone's own
  // address untrusted — every `/_next/*` and font request from it comes back 403
  // and the page renders unstyled and unhydrated. Detected rather than written
  // down, because it changes with the network. Development-only; ignored in a
  // build.
  allowedDevOrigins: lan ? [lan] : [],
};

export default nextConfig;
