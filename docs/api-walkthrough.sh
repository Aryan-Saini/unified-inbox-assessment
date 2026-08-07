#!/usr/bin/env bash
#
# The whole product, over curl, with no browser open.
#
#   UNIFIED_INBOX_BASE_URL=https://<slug>.convex.site \
#   UNIFIED_INBOX_API_KEY=uik_… \
#   UNIFIED_INBOX_RECIPIENT=you@example.com ./docs/api-walkthrough.sh
#
# Create the key in the app under Settings → API keys (it is shown once). Load
# Settings → Demo data first if the account has no connections: the seeded Gmail
# account is enabled, so a draft can be composed against it, and the send will
# fail `permanent` with "seeded demo data and holds no real grant" — which is
# itself worth seeing, because it proves demo data cannot reach a provider.
#
# What this proves, in order:
#   1. a search fans out and returns partial results while it is still running
#   2. results are normalised to exactly the seven public fields
#   3. sending requires a draft, a reviewed hash, and the recipient echoed back
#   4. the same idempotency key sends once — twice-called, byte-identical answer
#   5. a failed send is retryable, an indeterminate one is not
#
# Requires: curl, python3 (for reading JSON — no jq dependency).

set -euo pipefail

BASE_URL="${UNIFIED_INBOX_BASE_URL:-}"
API_KEY="${UNIFIED_INBOX_API_KEY:-}"
RECIPIENT="${UNIFIED_INBOX_RECIPIENT:-}"

if [[ -z "$BASE_URL" || -z "$API_KEY" || -z "$RECIPIENT" ]]; then
  echo "Set UNIFIED_INBOX_BASE_URL, UNIFIED_INBOX_API_KEY, and UNIFIED_INBOX_RECIPIENT first." >&2
  exit 2
fi

API="$BASE_URL/api/v1"
AUTH=(-H "Authorization: Bearer $API_KEY" -H "content-type: application/json")

# Read one field out of a JSON body. `python3 -c` rather than jq so this script
# runs on a bare machine.
json() {
  python3 -c '
import json, sys
data = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    data = data[int(key)] if isinstance(data, list) else data[key]
print(data if not isinstance(data, (dict, list)) else json.dumps(data))
' "$1"
}

step() { printf "\n\033[1m== %s\033[0m\n" "$*"; }

step "0. Who am I connected as?"
curl -sS "${AUTH[@]}" "$API/connections"

step "1. Start a search (202 — the fan-out is scheduled, not finished)"
SEARCH=$(curl -sS "${AUTH[@]}" -d '{"query":"invoice"}' "$API/searches")
echo "$SEARCH"
SEARCH_ID=$(printf '%s' "$SEARCH" | json search_id)

step "2. Poll it. Each source settles independently — partial results are real"
for _ in 1 2 3 4 5 6 7 8; do
  STATUS_BODY=$(curl -sS "${AUTH[@]}" "$API/searches/$SEARCH_ID")
  STATUS=$(printf '%s' "$STATUS_BODY" | json status)
  COUNT=$(printf '%s' "$STATUS_BODY" | json result_count)
  echo "  status=$STATUS results=$COUNT"
  [[ "$STATUS" == "complete" ]] && break
  sleep 2
done
printf '%s' "$STATUS_BODY" | json sources

step "3. Results, ranked. Exactly seven fields per result, whatever the source"
curl -sS "${AUTH[@]}" "$API/searches/$SEARCH_ID/results?order=rank" |
  python3 -c '
import json, sys
body = json.load(sys.stdin)
print("order={} partial={} count={}".format(body["order"], body["partial"], body["count"]))
for row in body["results"][:5]:
    print("  [{}] {}".format(row["source"], row["title"][:68]))
keys = {frozenset(row) for row in body["results"]}
print("field sets present:", [sorted(k) for k in keys])
'

step "4. Arrival order, for a client polling a running search"
curl -sS "${AUTH[@]}" "$API/searches/$SEARCH_ID/results?order=arrival" | json count

step "5. Re-run it. A new search with rerun_of set — history is never overwritten"
curl -sS "${AUTH[@]}" -X POST "$API/searches/$SEARCH_ID/rerun"

# ---------------------------------------------------------------- the send gate

CONNECTION_ID=$(curl -sS "${AUTH[@]}" "$API/connections" | python3 -c '
import json, sys
rows = json.load(sys.stdin)["connections"]
usable = [r for r in rows if r["provider"] == "gmail" and r["status"] == "active" and r["enabled"]]
if not usable:
    sys.exit("No enabled, active Gmail connection. Connect one, or load the demo data.")
print(usable[0]["id"])
')
IDEMPOTENCY_KEY="walkthrough-$(date +%s)"

step "6. Compose a draft. There is no endpoint that takes a recipient and sends"
DRAFT=$(curl -sS "${AUTH[@]}" -d "$(printf '{
  "channel": "gmail",
  "connection_id": "%s",
  "to": "%s",
  "subject": "Unified inbox walkthrough",
  "body": "Sent from docs/api-walkthrough.sh with no UI involved.",
  "idempotency_key": "%s"
}' "$CONNECTION_ID" "$RECIPIENT" "$IDEMPOTENCY_KEY")" "$BASE_URL/drafts")
echo "$DRAFT"
DRAFT_ID=$(printf '%s' "$DRAFT" | json id)

step "7. Read it back. review_hash is obtainable only by reading the payload"
REVIEW=$(curl -sS "${AUTH[@]}" "$API/drafts/$DRAFT_ID")
REVIEW_HASH=$(printf '%s' "$REVIEW" | json review_hash)
echo "  canonical: $(printf '%s' "$REVIEW" | json canonical_payload)"
echo "  hash:      $REVIEW_HASH"

step "8. Sending without confirming is refused (409)"
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" "${AUTH[@]}" \
  -d "{\"acknowledged_destination\":\"$RECIPIENT\"}" "$API/drafts/$DRAFT_ID/send" || true

step "9. Confirm — the server re-derives the digest and compares"
curl -sS "${AUTH[@]}" -d "{\"reviewed_hash\":\"$REVIEW_HASH\"}" \
  "$API/drafts/$DRAFT_ID/confirm" | json status

step "10. Sending with the wrong destination echoed back is refused (409)"
curl -sS "${AUTH[@]}" -d '{"acknowledged_destination":"somebody-else@example.com"}' \
  "$API/drafts/$DRAFT_ID/send"

step "11. Send. Waits up to 5s for a settled outcome, else answers 202"
curl -sS -D /tmp/uik-send-1.h "${AUTH[@]}" \
  -d "{\"acknowledged_destination\":\"$RECIPIENT\"}" \
  "$BASE_URL/drafts/$DRAFT_ID/send" >/tmp/uik-send-1.json
grep -i '^x-idempotent-replay' /tmp/uik-send-1.h || true
cat /tmp/uik-send-1.json
SEND_ID=$(json id </tmp/uik-send-1.json)

step "12. Send again — the same key, so nothing new is delivered"
curl -sS -D /tmp/uik-send-2.h "${AUTH[@]}" \
  -d "{\"acknowledged_destination\":\"$RECIPIENT\"}" \
  "$BASE_URL/drafts/$DRAFT_ID/send" >/tmp/uik-send-2.json
grep -i '^x-idempotent-replay' /tmp/uik-send-2.h || true

if diff -q /tmp/uik-send-1.json /tmp/uik-send-2.json >/dev/null; then
  echo "  ✔ byte-identical response bodies — one delivery, two calls"
else
  echo "  ✘ bodies differ:"
  diff /tmp/uik-send-1.json /tmp/uik-send-2.json || true
fi

step "13. The delivery record, with every attempt and the full error"
curl -sS "${AUTH[@]}" "$API/sends/$SEND_ID"

step "14. Retry. Allowed for a failed send; refused (409) for an unknown one"
curl -sS "${AUTH[@]}" -X POST "$API/sends/$SEND_ID/retry" |
  python3 -c 'import json,sys; b=json.load(sys.stdin); print("  retried={} reason={} status={}".format(b["retried"], b.get("reason"), b["status"]))'

step "15. The outbox"
curl -sS "${AUTH[@]}" "$API/sends" | json count

printf "\nDone. Nothing above touched a browser.\n"
