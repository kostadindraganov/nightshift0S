# Nightshift — Installation & Configuration

Setup guide for macOS development and Linux production.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Bun](https://bun.sh) | ≥ 1.3 | Runtime, test runner, package manager — replaces Node/npm |
| Git | ≥ 2.38 | Required for forge features and version probe |
| `claude` CLI | latest | Claude Code — default coder; install via `npm i -g @anthropic-ai/claude-code` |
| `codex` CLI | latest | Default reviewer; install via `npm i -g @openai/codex` |
| `bwrap` | any | **Linux only** — bubblewrap sandbox for agents (`apt install bubblewrap`) |

Only `bun` is strictly required to run the server. The AI CLIs are only needed when you actually trigger a coding or review run.

---

## Install

```sh
# 1. Clone and enter the project
git clone https://github.com/your-org/nightshift.git
cd nightshift

# 2. Install dependencies (Bun reads bun.lock — no network surprises)
bun install

# 3. Apply database migrations (creates data/nightshift.db)
bun run db:migrate
```

The server also auto-applies migrations on startup, so step 3 is optional.

---

## Configuration

### Config file

Copy the example and edit as needed:

```sh
cp nightshift.config.example.json nightshift.config.json
```

Key sections:

```jsonc
{
  "providers": {
    "defaultCoder": "claude-code",   // "codex" | "claude-code" | "gemini"
    "defaultReviewer": "codex",      // same options
    "claudeCodeEnabled": true,
    "codexEnabled": true
  },
  "concurrency": {
    "maxParallelSlots": 1            // raise on beefy Linux hosts
  },
  "review": {
    "maxRounds": 3,
    "autoMergeEnabled": false
  },
  "sandbox": {
    "unattendedUntrustedRepos": false  // requires egress control on Linux
  }
}
```

Full reference: `nightshift.config.example.json`.

### Environment variables

Bun auto-loads `.env`. Create one in the project root:

```sh
# .env  (never commit this file)
NIGHTSHIFT_API_TOKEN=<openssl rand -hex 32>
GITHUB_TOKEN=ghp_...
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `NIGHTSHIFT_API_TOKEN` | *(none)* | Bearer token for all protected endpoints. **Required** — server is fail-closed without it (returns `503 auth_not_configured`). |
| `NIGHTSHIFT_PORT` | `3000` | HTTP listen port |
| `NIGHTSHIFT_HOST` | `127.0.0.1` | HTTP listen host |
| `NIGHTSHIFT_DB_PATH` | `data/nightshift.db` | SQLite file path (`:memory:` works for tests) |
| `NIGHTSHIFT_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NIGHTSHIFT_REPO_DIR` | *(none)* | Absolute path to a repo to bootstrap a project from |
| `GITHUB_TOKEN` | *(none)* | GitHub PAT with `repo` scope — needed for forge push and PR creation |
| `OPENROUTER_API_KEY` | *(none)* | Required when `openrouterEnabled: true` in config |

---

## macOS (development)

The agent sandbox uses `bwrap`, which is Linux-only. On macOS the two escape-hatch env vars unlock unsandboxed spawns for attended local development:

| Variable | Purpose |
|----------|---------|
| `NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS=1` | Allows the reviewer CLI (`codex`/`claude --print`) to spawn without bwrap |
| `NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER=1` | Allows the coder CLI (`claude code`) to spawn without bwrap |

### PATH gotcha

When Nightshift spawns `claude` or `codex`, it inherits `process.env.PATH` from the server process — not your interactive shell profile. If those binaries live in `~/.local/bin`, `~/.bun/bin`, or similar, make sure the server is started from a terminal where `which claude` and `which codex` return valid paths.

**Recommended dev start command:**

```sh
NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS=1 \
NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER=1 \
PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" \
bun run dev
```

Or use a `.env.local` file:

```sh
# .env.local
NIGHTSHIFT_API_TOKEN=dev-token-change-me
NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS=1
NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER=1
```

Then: `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" bun run dev`

### Smoke test

```sh
# Server must be running in another terminal first
TOKEN=dev-token-change-me

curl http://localhost:3000/healthz        # {"ok":true}
curl http://localhost:3000/readyz         # {"ok":true}
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:3000/routes         # full route listing
```

---

## Linux (production)

### Quick deploy

```sh
# On the server as root (or sudo):
git clone https://github.com/your-org/nightshift.git /opt/nightshift
cd /opt/nightshift

sudo \
  NIGHTSHIFT_API_TOKEN="$(openssl rand -hex 32)" \
  GITHUB_TOKEN="ghp_yourtoken" \
  bash ops/deploy.sh
```

`ops/deploy.sh` is idempotent. It:
1. Creates a `nightshift` service user
2. Installs Bun for that user
3. Runs `bun install --frozen-lockfile` and `bun run db:migrate`
4. Writes secrets to `/etc/nightshift/env` (mode 640, root:nightshift)
5. Installs and starts `nightshift.service` (systemd)
6. Health-checks `/healthz`

### Service management

```sh
systemctl status nightshift.service
journalctl -u nightshift.service -f    # live logs
systemctl restart nightshift.service
```

### Update

```sh
cd /opt/nightshift
git pull --ff-only
sudo \
  NIGHTSHIFT_API_TOKEN="$(grep NIGHTSHIFT_API_TOKEN /etc/nightshift/env | cut -d= -f2)" \
  GITHUB_TOKEN="$(grep GITHUB_TOKEN /etc/nightshift/env | cut -d= -f2)" \
  bash ops/deploy.sh
```

### bwrap sandbox

Install bubblewrap — the sandbox activates automatically when `bwrap` is on PATH:

```sh
sudo apt install bubblewrap
which bwrap && bwrap --version
```

If `bwrap` is absent the server logs a warning and runs without namespace isolation. Acceptable for trusted repos; **not** for `unattendedUntrustedRepos: true`.

### Egress control (required for untrusted repos)

```sh
SERVICE_UID=$(id -u nightshift)
sudo NIGHTSHIFT_EGRESS_UID=$SERVICE_UID bash /opt/nightshift/ops/egress-apply.sh
# Verify
sudo nft list tables    # should show nightshift_egress_uidXXXX
```

Then in `nightshift.config.json`:
```json
{
  "sandbox": {
    "egressAllowlist": ["api.anthropic.com","api.openai.com","api.github.com","github.com"],
    "unattendedUntrustedRepos": true
  }
}
```

Teardown: `sudo NIGHTSHIFT_EGRESS_UID=$SERVICE_UID bash ops/egress-teardown.sh`

### nginx reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name nightshift.example.com;
    proxy_read_timeout 120s;   # SSE heartbeat is 15s — must exceed 60s

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;   # required for SSE
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
    }
}
```

---

## Running tests

```sh
# Correct — bare `bun test` hangs (no file filter)
bun run test

# Type check
bun run typecheck
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `One-shot spawn disabled — unsandboxed one-shots refused off Linux` | macOS, missing env var | Add `NIGHTSHIFT_ALLOW_UNSANDBOXED_ONESHOTS=1` |
| `unsandboxed coder refused off Linux` | macOS, missing env var | Add `NIGHTSHIFT_ALLOW_UNSANDBOXED_CODER=1` |
| `ENOENT: no such file or directory, posix_spawn 'claude'` | `claude` not on PATH when server starts | Start server with `PATH="$HOME/.local/bin:$PATH"` prefix |
| `ENOENT: posix_spawn 'codex'` | `codex` not on PATH | Same fix; ensure `which codex` works in the same shell |
| `503 auth_not_configured` on every route | `NIGHTSHIFT_API_TOKEN` not set | Set it in `.env` |
| `401 unauthorized` | Wrong or missing `Authorization: Bearer` header | Check token matches `NIGHTSHIFT_API_TOKEN` |
| `/readyz` returns `503 not_ready` | Migrations not applied | Run `bun run db:migrate` |
| SSE connection drops repeatedly | Reverse proxy idle timeout too short | Set `proxy_read_timeout` > 60s |
