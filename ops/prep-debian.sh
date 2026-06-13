#!/usr/bin/env bash
# ops/prep-debian.sh — Prepare a Debian/Ubuntu host for Nightshift. Idempotent;
# safe to re-run. Installs ONLY the OS-level prerequisites (system packages,
# Node + the AI CLIs, Bun). It does NOT touch secrets, the service user, the DB,
# or systemd — that is ops/deploy.sh's job. Run this first, then deploy.sh.
#
# WHY split from deploy.sh: deploy.sh installs Bun for the `nightshift` service
# user and wires the service, but assumes git/tmux/bwrap/nft and the claude/codex
# CLIs already exist on PATH. This script provides exactly those prerequisites so
# a fresh machine reaches a deployable state in one pass.
#
# Usage (run as a user with sudo, NOT as root-only — the Bun install targets
# your $HOME):
#   bash ops/prep-debian.sh
#
# Optional env (defaults shown):
#   INSTALL_BUN=1        Install Bun for the CURRENT user (~/.bun). 0 to skip
#                        (deploy.sh installs Bun for the service user regardless).
#   INSTALL_DOCKER=0     Install docker.io (container run-level, Phase 7.1).
#   INSTALL_PODMAN=0     Install podman instead of docker.
#   INSTALL_GH=0         Install the GitHub CLI (`gh`).
#   NODE_MAJOR=20        NodeSource major version for Node (claude/codex need >=18).

set -euo pipefail

INSTALL_BUN="${INSTALL_BUN:-1}"
INSTALL_DOCKER="${INSTALL_DOCKER:-0}"
INSTALL_PODMAN="${INSTALL_PODMAN:-0}"
INSTALL_GH="${INSTALL_GH:-0}"
NODE_MAJOR="${NODE_MAJOR:-20}"

# ── helpers ───────────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }

# sudo wrapper: use sudo only when not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; else
    echo "ERROR: not root and no sudo found. Install sudo or run as root." >&2
    exit 1
  fi
fi

echo "== Nightshift Debian prep =="

# ── 0. sanity: this is Debian/Ubuntu with apt ─────────────────────────────────

if ! have apt-get; then
  echo "ERROR: apt-get not found — this script targets Debian/Ubuntu." >&2
  exit 1
fi
if [ -r /etc/os-release ]; then . /etc/os-release; echo "  OS: ${PRETTY_NAME:-unknown}"; fi
echo "  arch: $(uname -m)"
echo ""

# ── 1. system packages ────────────────────────────────────────────────────────

echo "-- [1/4] system packages (git tmux bubblewrap nftables …)"
$SUDO apt-get update -y
$SUDO apt-get install -y \
  git \
  tmux \
  bubblewrap \
  nftables \
  curl ca-certificates unzip gnupg \
  build-essential \
  openssl
echo "  ok"
echo ""

# ── 2. Node.js + AI CLIs (claude, codex) ──────────────────────────────────────

echo "-- [2/4] Node.js ${NODE_MAJOR}.x + AI CLIs"
NODE_OK=0
if have node; then
  NODE_CUR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "${NODE_CUR:-0}" -ge 18 ]; then
    NODE_OK=1
    echo "  node $(node --version) already present (>=18) — skipping NodeSource"
  fi
fi
if [ "$NODE_OK" -ne 1 ]; then
  echo "  installing Node ${NODE_MAJOR}.x via NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

# Global CLIs — install if missing (npm i -g is itself idempotent for updates).
if have claude; then echo "  claude present: $(claude --version 2>/dev/null | head -1)"; else
  echo "  installing @anthropic-ai/claude-code…"; $SUDO npm i -g @anthropic-ai/claude-code
fi
if have codex; then echo "  codex present: $(codex --version 2>/dev/null | head -1)"; else
  echo "  installing @openai/codex…"; $SUDO npm i -g @openai/codex
fi
echo "  ok"
echo ""

# ── 3. Bun (current user) ─────────────────────────────────────────────────────

echo "-- [3/4] Bun"
if [ "$INSTALL_BUN" = "1" ]; then
  if [ -x "$HOME/.bun/bin/bun" ] || have bun; then
    echo "  bun already installed: $({ "$HOME/.bun/bin/bun" --version 2>/dev/null || bun --version; })"
  else
    echo "  installing Bun for $USER (~/.bun)…"
    curl -fsSL https://bun.sh/install | bash
    # Persist PATH for interactive shells (deploy.sh handles the service user).
    if ! grep -q '.bun/bin' "$HOME/.bashrc" 2>/dev/null; then
      echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.bashrc"
      echo "  added ~/.bun/bin to ~/.bashrc"
    fi
  fi
else
  echo "  INSTALL_BUN=0 — skipping (deploy.sh installs Bun for the service user)"
fi
echo ""

# ── 4. optional: containers + gh ──────────────────────────────────────────────

echo "-- [4/4] optional extras"
if [ "$INSTALL_DOCKER" = "1" ]; then
  echo "  installing docker.io…"; $SUDO apt-get install -y docker.io
fi
if [ "$INSTALL_PODMAN" = "1" ]; then
  echo "  installing podman…"; $SUDO apt-get install -y podman
fi
if [ "$INSTALL_GH" = "1" ]; then
  echo "  installing gh…"; $SUDO apt-get install -y gh
fi
[ "$INSTALL_DOCKER$INSTALL_PODMAN$INSTALL_GH" = "000" ] && echo "  none requested (set INSTALL_DOCKER/INSTALL_PODMAN/INSTALL_GH=1 to add)"
echo ""

# ── verify ────────────────────────────────────────────────────────────────────

echo "== verify =="
MISSING=0
for b in git tmux bwrap nft node npm claude codex openssl; do
  if have "$b"; then printf "  %-8s ok  (%s)\n" "$b" "$(command -v "$b")"; else
    printf "  %-8s MISSING\n" "$b"; MISSING=1
  fi
done
# bun may live under ~/.bun/bin without being on the current PATH yet.
if have bun || [ -x "$HOME/.bun/bin/bun" ]; then printf "  %-8s ok\n" "bun"; else
  [ "$INSTALL_BUN" = "1" ] && { printf "  %-8s MISSING\n" "bun"; MISSING=1; }
fi
echo ""

if [ "$MISSING" -ne 0 ]; then
  echo "RESULT: some prerequisites are MISSING — review the output above." >&2
  echo "        (claude/codex missing? ensure '\$(npm prefix -g)/bin' is on PATH.)" >&2
  exit 1
fi

cat <<'EOF'
RESULT: host prepared.

Next steps (operator):
  1. Provide secrets and run the deploy:
       cd /opt/nightshift   # or wherever the repo is checked out
       sudo NIGHTSHIFT_API_TOKEN="$(openssl rand -hex 32)" \
            GITHUB_TOKEN="ghp_..." \
            ANTHROPIC_API_KEY="..."  OPENAI_API_KEY="..." \
            bash ops/deploy.sh
  2. Verify service-user PATH can resolve claude/codex (Task 8 in
     docs/LINUX-SETUP-AGENT.md).
  3. Continue with the GATE-5 worklist in IMPLEMENTATION-PLAN.md (Phase 8).
EOF
