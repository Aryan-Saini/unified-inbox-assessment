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
    // all.
    //
    // `localhost:3000` is there because the public-host wildcards do not
    // actually cover every failing request. Captured in the Codespace: the
    // tunnel sometimes rewrites the browser's `Origin` to `localhost:3000`
    // while `x-forwarded-host` stays `<name>-3000.app.github.dev` (seen while
    // the tunnel relay cookie is being refreshed), and Next compares those two
    // — so no amount of public hostname matches it and the 500 comes back
    // intermittently. Safe to trust: a browser never lets a foreign page forge
    // `Origin`, so the header can only say `localhost:3000` if the request
    // really came from this machine or from the tunnel in front of it.
    //
    // The whole fallback block is development-only, so a production build
    // never carries any of it.
    serverActions: {
      allowedOrigins: [
        ...(codespaceOrigin ? [codespaceOrigin] : []),
        ...(codespacesDomain ? [`*.${codespacesDomain}`] : []),
        ...(process.env.NODE_ENV === "development"
          ? ["*.app.github.dev", "localhost:3000"]
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
