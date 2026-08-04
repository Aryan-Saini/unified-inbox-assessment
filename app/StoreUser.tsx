"use client";

import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Upserts the Clerk identity into Convex once per authenticated session.
 * Renders nothing; mount it inside the providers in the root layout.
 */
export function StoreUser() {
  const { isAuthenticated } = useConvexAuth();
  const store = useMutation(api.users.store);

  useEffect(() => {
    if (!isAuthenticated) return;
    void store();
  }, [isAuthenticated, store]);

  return null;
}
