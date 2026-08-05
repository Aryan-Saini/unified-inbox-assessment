/**
 * Public HTTP surface of the Convex deployment.
 *
 * Right now that is one route: the Clerk webhook that keeps `users` in step
 * with Clerk. This lives in Convex rather than in a Next.js route handler
 * because a Convex deployment already has a stable public URL
 * (`https://<slug>.convex.site`), so the webhook works while the frontend is
 * still only running on localhost.
 */

import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

/** The subset of Clerk's `user.*` payload this app actually consumes. */
interface ClerkUserData {
  id: string;
  email_addresses?: { id: string; email_address: string }[];
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
}

interface ClerkEvent {
  type: string;
  data: ClerkUserData;
}

/**
 * Narrow Svix's verified payload to the shape above.
 *
 * A passing signature only proves Clerk sent it — not that the body looks the
 * way this code expects — so the shape is still checked before use.
 */
function asClerkEvent(payload: unknown): ClerkEvent | null {
  if (typeof payload !== "object" || payload === null) return null;

  const { type, data } = payload as { type?: unknown; data?: unknown };
  if (typeof type !== "string") return null;
  if (typeof data !== "object" || data === null) return null;
  if (typeof (data as { id?: unknown }).id !== "string") return null;

  return { type, data: data as ClerkUserData };
}

/**
 * Clerk sends every address on the account, so pick the primary one rather than
 * the first — otherwise a user who adds a second address can have their stored
 * email silently change.
 */
function primaryEmail(data: ClerkUserData): string | undefined {
  const addresses = data.email_addresses ?? [];
  const primary =
    addresses.find((a) => a.id === data.primary_email_address_id) ??
    addresses[0];
  return primary?.email_address;
}

function fullName(data: ClerkUserData): string | undefined {
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
  return name === "" ? undefined : name;
}

const handleClerkWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (secret === undefined) {
    // A misconfigured deployment is our fault, not the sender's. 500 makes Svix
    // retry, so events are not lost between deploying and setting the secret.
    console.error("CLERK_WEBHOOK_SIGNING_SECRET is not set on this deployment");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  // Must be the raw body: the signature covers the exact bytes Clerk sent, so
  // parsing and re-serialising first would invalidate it.
  const body = await request.text();
  const headers = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  };

  let event: ClerkEvent | null;
  try {
    event = asClerkEvent(new Webhook(secret).verify(body, headers));
  } catch (err) {
    // Bad signature or a replayed/stale timestamp. 400 so Svix stops retrying —
    // an unsigned request will never become signed.
    console.error("Clerk webhook signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event === null) {
    console.error("Clerk webhook payload was not in the expected shape");
    return new Response("Malformed payload", { status: 400 });
  }

  switch (event.type) {
    case "user.created":
    case "user.updated":
      await ctx.runMutation(internal.clerk.upsertFromClerk, {
        clerkUserId: event.data.id,
        email: primaryEmail(event.data),
        name: fullName(event.data),
        imageUrl: event.data.image_url ?? undefined,
      });
      break;

    case "user.deleted":
      await ctx.runMutation(internal.clerk.deleteFromClerk, {
        clerkUserId: event.data.id,
      });
      break;

    default:
      // Subscribing to extra events in the dashboard should not start failing
      // deliveries, so anything unhandled is acknowledged and ignored.
      console.log(`Ignoring unhandled Clerk event: ${event.type}`);
  }

  return new Response(null, { status: 200 });
});

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: handleClerkWebhook,
});

export default http;
