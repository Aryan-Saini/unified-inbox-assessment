import { InboxApp } from "./InboxApp";

/**
 * The unified inbox. UI only: every search, result, connection and send on this
 * screen is local mock state (see `mock-data.ts`). Nothing calls Convex, Clerk
 * or a provider.
 */
export default function InboxPage() {
  return <InboxApp />;
}
