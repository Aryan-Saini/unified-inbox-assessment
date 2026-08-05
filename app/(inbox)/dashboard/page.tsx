import { AuthGate } from "../../AuthGate";
import { InboxApp } from "../InboxApp";

/**
 * The unified inbox. Signed-in only: `proxy.ts` bounces a signed-out request to
 * `/auth`, and `AuthGate` holds the shell back until Convex has an identity, so
 * everything below it can assume an owner exists.
 */
export default function DashboardPage() {
  return (
    <AuthGate>
      <InboxApp />
    </AuthGate>
  );
}
