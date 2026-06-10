#!/usr/bin/env bash
# ops/hook.sh — Claude Code lifecycle hook bridge for Nightshift.
#
# Installed via settings.json hooks[].command. Called on every lifecycle event;
# receives the event JSON on stdin and posts it to the Nightshift backend.
#
# Required env vars:
#   NIGHTSHIFT_RUN_ID      — integer run id for this agent session
#   NIGHTSHIFT_API_TOKEN   — Bearer token for the Nightshift API
#
# Optional:
#   NIGHTSHIFT_PORT        — default 3000
#
# Usage (from settings.json args[]): hook.sh <event-kind>
#
# Best-effort: never blocks the agent on hook delivery failure (|| true).

set -u
KIND="${1:-unknown}"
PORT="${NIGHTSHIFT_PORT:-3000}"
PAYLOAD="$(cat 2>/dev/null || echo '{}')"

# Validate JSON; if Claude sent something malformed, wrap as raw string.
if ! echo "$PAYLOAD" | jq -e . >/dev/null 2>&1; then
    PAYLOAD=$(jq -nc --arg r "$PAYLOAD" '{raw: $r}')
fi

BODY=$(jq -nc --arg k "$KIND" --argjson p "$PAYLOAD" '{kind: $k, payload: $p}')

# Best-effort POST; never block the agent on hook delivery failure.
curl -sfm 5 -X POST \
    "http://127.0.0.1:${PORT}/runs/${NIGHTSHIFT_RUN_ID}/events" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${NIGHTSHIFT_API_TOKEN}" \
    --data-binary "$BODY" >/dev/null 2>&1 || true

exit 0
