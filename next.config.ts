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
    // than the browser origin. Trust only this Codespace's generated hostname
    // so Next.js can keep its Server Action CSRF check enabled.
    serverActions: {
      allowedOrigins: codespaceOrigin ? [codespaceOrigin] : [],
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
