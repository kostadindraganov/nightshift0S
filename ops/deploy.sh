#!/usr/bin/env bash
# ops/deploy.sh — Deploy Nightshift to a Linux host. Idempotent; safe to re-run.
#
# WHY local-only: this script runs on the target host as root (or a user with
# sudo). There is no SSH fan-out here — check out the repo on the server and
# run this script there. That keeps the deploy surface minimal: one machine,
# one shell, no remote heredocs.
#
# Required env (set before running, or export from a local .env.deploy):
#   NIGHTSHIFT_API_TOKEN   Bearer token for all protected API endpoints.
#   GITHUB_TOKEN           GitHub PAT with repo scope (forge push + PR).
#
# Optional env (defaults shown):
#   SERVICE_USER=nightshift          Unprivileged user the service runs as.
#   INSTALL_DIR=/opt/nightshift       Where the repo is (or will be) checked out.
#   SERVICE_HOME=/home/nightshift     Home dir of the service user.
#   NIGHTSHIFT_PORT=3000              Port the HTTP server binds.
#   ANTHROPIC_API_KEY                 Set to enable claude-code with API auth.
#   OPENAI_API_KEY                    Set to enable codex provider.
#
# Usage (run as root, or via sudo):
#   cd /opt/nightshift
#   NIGHTSHIFT_API_TOKEN=<tok> GITHUB_TOKEN=<tok> bash ops/deploy.sh

set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────

SERVICE_USER="${SERVICE_USER:-nightshift}"
INSTALL_DIR="${INSTALL_DIR:-/opt/nightshift}"
SERVICE_HOME="${SERVICE_HOME:-/home/$SERVICE_USER}"
NIGHTSHIFT_PORT="${NIGHTSHIFT_PORT:-3000}"

# Fail-closed: secrets must be set. A silent empty token would let the server
# start but refuse all protected endpoints — catch that here instead.
: "${NIGHTSHIFT_API_TOKEN:?NIGHTSHIFT_API_TOKEN must be set (Bearer token for the API)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (GitHub PAT with repo scope)}"

# Derive the repo root from the script location so you can run from anywhere.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== Nightshift deploy =="
echo "  repo:         $REPO_DIR"
echo "  install dir:  $INSTALL_DIR"
echo "  service user: $SERVICE_USER"
echo "  port:         $NIGHTSHIFT_PORT"
echo ""

# ── 1. service user ───────────────────────────────────────────────────────────

echo "-- [1/6] service user"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -d "$SERVICE_HOME" "$SERVICE_USER"
  echo "  created user $SERVICE_USER"
else
  echo "  user $SERVICE_USER already exists"
fi

# ── 2. install dir ownership ──────────────────────────────────────────────────

echo "-- [2/6] install dir"
mkdir -p "$INSTALL_DIR/data"

# If the repo was cloned by root, hand ownership to the service user so Bun
# and git can operate without privilege escalation.
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Allow any directory ownership in git so worktree + push work across uid
# boundaries (e.g. repo cloned by root, operated by nightshift).
runuser -u "$SERVICE_USER" -- git -C "$INSTALL_DIR" config --global --add safe.directory "*"

# ── 3. Bun ────────────────────────────────────────────────────────────────────

echo "-- [3/6] Bun runtime"
BUN_BIN="$SERVICE_HOME/.bun/bin/bun"

if [ ! -x "$BUN_BIN" ]; then
  echo "  installing Bun for $SERVICE_USER..."
  # The official installer writes to ~/.bun; run as the service user.
  runuser -u "$SERVICE_USER" -- bash -c \
    'curl -fsSL https://bun.sh/install | bash'
  echo "  Bun installed"
else
  echo -n "  Bun already present: "
  runuser -u "$SERVICE_USER" -- "$BUN_BIN" --version
fi

# Sanity-check: if there is a system-wide bun that shadows the user install,
# fail loudly rather than running the wrong binary.
if command -v bun >/dev/null 2>&1; then
  SYSTEM_BUN="$(command -v bun)"
  if [ "$SYSTEM_BUN" != "$BUN_BIN" ]; then
    echo "WARNING: system bun at $SYSTEM_BUN may shadow $BUN_BIN" >&2
    echo "         Continuing; verify PATH in the systemd unit if issues arise." >&2
  fi
fi

# ── 4. dependencies + migrations ─────────────────────────────────────────────

echo "-- [4/6] dependencies + DB migration"

# bun install --frozen-lockfile refuses if bun.lock is out of sync with
# package.json. That is the desired behaviour: never silently diverge.
runuser -u "$SERVICE_USER" -- \
  env HOME="$SERVICE_HOME" \
  "$BUN_BIN" install --frozen-lockfile \
  --cwd "$INSTALL_DIR"

# Apply pending Drizzle migrations. Idempotent — already-applied migrations
# are skipped. Creates data/nightshift.db on first run.
# PATH must include bun's bin dir because the db:migrate npm script calls `bun` by name.
runuser -u "$SERVICE_USER" -- \
  env HOME="$SERVICE_HOME" \
      PATH="$(dirname "$BUN_BIN"):$PATH" \
      NIGHTSHIFT_DB_PATH="$INSTALL_DIR/data/nightshift.db" \
  "$BUN_BIN" run --cwd "$INSTALL_DIR" db:migrate

echo "  dependencies and migrations OK"

# ── 5. secrets file ───────────────────────────────────────────────────────────

echo "-- [5/6] secrets"
SECRET_FILE="/etc/nightshift/env"
mkdir -p /etc/nightshift
chmod 750 /etc/nightshift
chown root:"$SERVICE_USER" /etc/nightshift

# Write the env file; overwrite on each deploy so a token rotation takes effect
# immediately on the next service restart.
cat > "$SECRET_FILE" <<EOF
# Nightshift runtime secrets — generated by ops/deploy.sh
# Do NOT commit this file.
NIGHTSHIFT_API_TOKEN=${NIGHTSHIFT_API_TOKEN}
GITHUB_TOKEN=${GITHUB_TOKEN}
EOF

# Optional provider keys — only written when set, so unset vars don't
# overwrite existing values from a previous deploy.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" >> "$SECRET_FILE"
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >> "$SECRET_FILE"
fi

chmod 640 "$SECRET_FILE"
chown root:"$SERVICE_USER" "$SECRET_FILE"
echo "  secrets written to $SECRET_FILE (mode 640, root:$SERVICE_USER)"

# ── 6. systemd unit ───────────────────────────────────────────────────────────

echo "-- [6/6] systemd"

UNIT_SRC="$REPO_DIR/ops/nightshift.service"
UNIT_DST="/etc/systemd/system/nightshift.service"

# Substitute the three tuneable placeholders (user, dirs, port) from the
# defaults or the operator's env overrides.
# Order matters: substitute the longer / more specific patterns first so
# shorter later substitutions don't corrupt text that was already replaced.
sed \
  -e "s|ExecStart=/home/nightshift/.bun/bin/bun run /opt/nightshift|ExecStart=$SERVICE_HOME/.bun/bin/bun run $INSTALL_DIR|g" \
  -e "s|NIGHTSHIFT_DB_PATH=/opt/nightshift/data/nightshift.db|NIGHTSHIFT_DB_PATH=$INSTALL_DIR/data/nightshift.db|g" \
  -e "s|WorkingDirectory=/opt/nightshift|WorkingDirectory=$INSTALL_DIR|g" \
  -e "s|/home/nightshift/.bun/bin|$SERVICE_HOME/.bun/bin|g" \
  -e "s|HOME=/home/nightshift|HOME=$SERVICE_HOME|g" \
  -e "s|User=nightshift|User=$SERVICE_USER|g" \
  -e "s|Group=nightshift|Group=$SERVICE_USER|g" \
  -e "s|NIGHTSHIFT_PORT=3000|NIGHTSHIFT_PORT=$NIGHTSHIFT_PORT|g" \
  "$UNIT_SRC" > "$UNIT_DST"

systemctl daemon-reload
systemctl enable nightshift.service >/dev/null
systemctl restart nightshift.service

echo "  nightshift.service enabled and restarted"

# ── health check ─────────────────────────────────────────────────────────────

echo ""
echo "== Health check (up to 15s) =="
for i in $(seq 1 15); do
  # /healthz is unauthenticated — use it as the liveness probe.
  if curl -sf "http://127.0.0.1:${NIGHTSHIFT_PORT}/healthz" >/dev/null 2>&1; then
    echo "  OK — Nightshift is up on port ${NIGHTSHIFT_PORT}"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "ERROR: /healthz did not respond after 15s" >&2
    echo "  systemctl status nightshift.service:" >&2
    systemctl status nightshift.service --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done

echo ""
echo "== Done =="
echo "  API base:  http://127.0.0.1:${NIGHTSHIFT_PORT}"
echo "  Logs:      journalctl -u nightshift.service -f"
echo "  Secrets:   $SECRET_FILE"
