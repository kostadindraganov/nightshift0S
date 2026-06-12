#!/usr/bin/env bash
# ops/egress-apply.sh — L6 root wrapper that ACTIVATES nightshift egress control.
#
# nft(8) needs root, so an operator runs this under sudo (or systemd
# ExecStartPre) on the LINUX host. It shells into src/egress/applyCli.ts, which
# generates the uid-scoped, default-DROP nftables ruleset (provider + GitHub
# allowlist) via allowlist.ts and loads it with `nft -f`. Once this succeeds,
# guard.ts's egressActive() finds the nightshift_egress_uid<uid> table and the
# unattended-untrusted gate may be opened by the operator.
#
# FAIL-CLOSED: refuses on non-Linux and when nft is absent — it never runs the
# agent unfiltered. LINUX-VERIFY-ONLY: this is exercised live by the owner on
# the Linux host; CI checks syntax only (bash -n).
#
# Required:
#   NIGHTSHIFT_EGRESS_UID   uid whose outbound packets are filtered (the
#                           unprivileged service user, NOT root). Required.
# Optional:
#   NIGHTSHIFT_EGRESS_HOSTS space-separated extra hosts on top of the default
#                           provider+GitHub allowlist (api.anthropic.com,
#                           api.openai.com, github.com, api.github.com).
set -euo pipefail

UID_ARG="${NIGHTSHIFT_EGRESS_UID:?set NIGHTSHIFT_EGRESS_UID=<service-user-uid>}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Fail-closed: nftables is Linux-only; refuse rather than run unfiltered.
if [ "$(uname -s)" != "Linux" ]; then
  echo "egress-apply: refusing — nftables requires Linux (got $(uname -s))" >&2
  exit 1
fi
if ! command -v nft >/dev/null 2>&1; then
  echo "egress-apply: refusing — nft(8) not found on PATH" >&2
  exit 1
fi
if [ "$(id -u)" != "0" ]; then
  echo "egress-apply: refusing — nft needs root; re-run with sudo" >&2
  exit 1
fi

# Build the --host flags from the optional extra-hosts list.
HOST_ARGS=()
for h in ${NIGHTSHIFT_EGRESS_HOSTS:-}; do
  HOST_ARGS+=(--host "$h")
done

exec bun "$SRC_DIR/src/egress/applyCli.ts" --uid "$UID_ARG" "${HOST_ARGS[@]}"
