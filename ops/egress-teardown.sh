#!/usr/bin/env bash
# ops/egress-teardown.sh — L6 root wrapper that TEARS DOWN nightshift egress.
#
# Deletes the uid-scoped nftables table created by egress-apply.sh. After this
# runs, guard.ts's egressActive() returns false again, which re-closes the
# unattended-untrusted gate. Use when stopping the service or rotating policy.
#
# The table name MUST match allowlist.ts buildNftablesRuleset / guard.ts
# NFT_TABLE_PREFIX: inet nightshift_egress_uid<uid>.
#
# FAIL-CLOSED on platform/binary (refuses on non-Linux and when nft is absent).
# Idempotent: a missing table is treated as already-torn-down (exit 0).
# LINUX-VERIFY-ONLY: exercised live by the owner; CI checks syntax only.
#
# Required:
#   NIGHTSHIFT_EGRESS_UID   uid whose egress table is removed.
set -euo pipefail

UID_ARG="${NIGHTSHIFT_EGRESS_UID:?set NIGHTSHIFT_EGRESS_UID=<service-user-uid>}"
TABLE="nightshift_egress_uid${UID_ARG}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "egress-teardown: refusing — nftables requires Linux (got $(uname -s))" >&2
  exit 1
fi
if ! command -v nft >/dev/null 2>&1; then
  echo "egress-teardown: refusing — nft(8) not found on PATH" >&2
  exit 1
fi
if [ "$(id -u)" != "0" ]; then
  echo "egress-teardown: refusing — nft needs root; re-run with sudo" >&2
  exit 1
fi

# Idempotent: deleting an absent table is not an error.
if nft list table inet "$TABLE" >/dev/null 2>&1; then
  nft delete table inet "$TABLE"
  echo "egress-teardown: removed table inet $TABLE"
else
  echo "egress-teardown: table inet $TABLE not present — nothing to do"
fi
