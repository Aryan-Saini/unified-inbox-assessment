import { AuthGate } from "../../AuthGate";
import { InboxApp } from "../InboxApp";

/**
 * The outbox. The same shell as `/dashboard` — one sidebar, one set of dialogs —
 * showing the send history in the pane the results normally occupy, so it is a
 * place you can navigate to and link at rather than a modal over the search.
 */
export default function OutboxRoute() {
  return (
    <AuthGate>
      <InboxApp view="outbox" />
    </AuthGate>
  );
}
