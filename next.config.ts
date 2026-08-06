import type { NextConfig } from "next";
import { lanAddress } from "./scripts/lan-address.mjs";

const lan = lanAddress();

const nextConfig: NextConfig = {
  reactCompiler: true,

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
