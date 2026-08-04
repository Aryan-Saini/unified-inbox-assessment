const authConfig = {
  providers: [
    {
      // Set on the Convex deployment (a separate environment from Next.js):
      //   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      // Must match the `aud` claim Clerk puts on the session token — set either
      // by a JWT template named `convex` or on the dashboard's Sessions page.
      applicationID: "convex",
    },
  ],
};

export default authConfig;
