# LINUX-DEPLOY.md — Nightshift Live Deployment Runbook

**Status**: CODE-COMPLETE — 2026-06-13. All Phase 2–4 live-wiring code is built
and tested on macOS with scripted agents and injected fakes. This runbook is the
owner's playbook for activating the live system on a trusted Linux host running
the "fix typo" end-to-end test: a real Claude Code agent that claims a task,
codes, pushes to GitHub, opens a PR, awaits review, revises, and merges.

**Required environment:**
- A Linux x86_64 host (bwrap + nftables).
- Repo cloned to `/opt/nightshift` (or `$INSTALL_DIR`).
- `Bun >= 1.0`, `git`, `curl`, `nft(8)`, `nix` or manual `bwrap` install.
- GitHub PAT with `repo` scope (for forge push + PR + CI checks).
- Anthropic API key (for claude-code provider).
- `sudo` access (for egress activation).

---

## Phase 1: Environment Setup

### 1.1 Set required env vars (before running deploy.sh)

```bash
# Required — MUST be set
export NIGHTSHIFT_API_TOKEN="sk-..."         # Bearer token for all protected endpoints
export GITHUB_TOKEN="ghp_..."                 # GitHub PAT with repo scope
export ANTHROPIC_API_KEY="sk-ant-..."        # Anthropic API key for claude-code

# Optional — adjust to your host
export SERVICE_USER="nightshift"              # Unprivileged service user
export INSTALL_DIR="/opt/nightshift"          # Repo path
export SERVICE_HOME="/home/nightshift"        # User home
export NIGHTSHIFT_PORT="3000"                 # HTTP server port
```

### 1.2 Create `/etc/nightshift/env` (or let deploy.sh do it)

The deploy script creates this file automatically at step [5/6]. If you prefer
to set it manually:

```bash
sudo mkdir -p /etc/nightshift
sudo chmod 750 /etc/nightshift

cat | sudo tee /etc/nightshift/env > /dev/null <<'EOF'
NIGHTSHIFT_API_TOKEN=sk-...
GITHUB_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...
EOF

sudo chmod 640 /etc/nightshift/env
sudo chown root:nightshift /etc/nightshift/env
```

---

## Phase 2: Run the Deploy Script

### 2.1 Idempotent deployment

```bash
cd /opt/nightshift

sudo NIGHTSHIFT_API_TOKEN="$NIGHTSHIFT_API_TOKEN" \
     GITHUB_TOKEN="$GITHUB_TOKEN" \
     ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
     bash ops/deploy.sh
```

**What it does (6 steps):**
1. Creates the unprivileged service user (e.g. `nightshift`).
2. Sets directory ownership so the service user can operate the repo.
3. Installs Bun into the service user's home (`~/.bun/bin/bun`).
4. Runs `bun install --frozen-lockfile` and `bun run db:migrate` (creates SQLite DB).
5. Writes `/etc/nightshift/env` with secrets (mode 0640, group-readable by service user).
6. Installs and enables `ops/nightshift.service` as a systemd unit.

**Health check:** The script waits up to 15 seconds for `/healthz` to respond on
port 3000 (default). If it times out, check `journalctl -u nightshift.service -f`.

---

## Phase 3: Verify Base Installation

### 3.1 Check systemd service status

```bash
systemctl status nightshift.service
journalctl -u nightshift.service -f  # Follow logs
```

### 3.2 Verify API is alive

```bash
# Unauthenticated health check
curl -s http://127.0.0.1:3000/healthz | jq .

# Authenticated endpoint (requires NIGHTSHIFT_API_TOKEN as Bearer)
curl -s -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
     http://127.0.0.1:3000/config | jq .
```

### 3.3 Check database and migrations

```bash
# As the service user, verify the database exists and is writable
sudo -u nightshift sqlite3 /opt/nightshift/data/nightshift.db ".tables"
```

---

## Phase 4: Activate Egress Control (nftables)

### 4.1 Get the service user's UID

```bash
SERVICE_UID=$(id -u nightshift)
echo "Service UID: $SERVICE_UID"
```

### 4.2 Apply the nftables ruleset

The `ops/egress-apply.sh` script generates a uid-scoped, default-DROP ruleset
that ONLY allows the nightshift service user to reach:
- `api.anthropic.com` (claude-code provider)
- `api.openai.com` (optional; codex provider)
- `github.com` + `api.github.com` (forge push + PR + CI checks)

```bash
sudo NIGHTSHIFT_EGRESS_UID="$SERVICE_UID" bash ops/egress-apply.sh
```

**Output (if successful):**
```
nightshift_egress_uid<UID>: table inet nightshift_egress_uid<UID> created.
egressActive: found table inet nightshift_egress_uid<UID> — enforcing.
```

### 4.3 Verify nftables rules are loaded

```bash
# As root, list the nightshift table
sudo nft list table inet nightshift_egress_uid"$SERVICE_UID"

# Test: the nightshift service can reach GitHub; a curl from another user cannot
# (unless they are on the allowlist).
```

### 4.4 Optional: add extra hosts to the allowlist

If your organization uses a proxy or additional provider, pass extra hosts:

```bash
sudo NIGHTSHIFT_EGRESS_UID="$SERVICE_UID" \
     NIGHTSHIFT_EGRESS_HOSTS="proxy.example.com api.custom.ai" \
     bash ops/egress-apply.sh
```

---

## Phase 5: End-to-End Test: "Fix Typo"

The live system is now ready to run a real coding task. This test verifies:
- Claude Code spawns under tmux on the Linux host.
- The coder session resumes with `--resume` flag.
- The code is pushed to GitHub via the forge service.
- A PR is opened (GitHub REST API).
- CI checks run and are polled.
- A human reviews and approves the PR.
- The dependent task unblocks when the PR is merged.

### 5.1 Prepare a real GitHub repo

Create or select a repo you control on GitHub (e.g. `my-org/test-repo`).
Ensure your PAT (`GITHUB_TOKEN`) has `repo` scope and can push to this repo.

### 5.2 Create the task via the API

Create a task with a simple fix and a dependency chain:

```bash
TASK_ID=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  http://127.0.0.1:3000/tasks \
  -d '{
    "title": "fix: typo in README",
    "description": "Change 'recieve' to 'receive' in README.md line 42",
    "project": "my-org/test-repo",
    "acceptance_criteria": "Typo is fixed and PR is merged"
  }' | jq -r '.id')

echo "Task ID: $TASK_ID"
```

**Verify in the UI:** Navigate to http://127.0.0.1:3000 and see the task in the
backlog. Its state should be `draft`.

### 5.3 Claim the task and move it to "Coding"

```bash
curl -s -X PATCH \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
  http://127.0.0.1:3000/tasks/"$TASK_ID"/transition \
  -d '{"to": "coding"}' | jq .
```

**What happens next:**
1. Nightshift orchestrator detects the transition to `coding`.
2. `completeCoderRun` is invoked (injectable spawner; on Linux → real Claude Code).
3. The coder claims the task and spawns a tmux session with the task prompt.

### 5.4 Monitor the coder session

In a separate terminal on the Linux host, watch the tmux session:

```bash
# List active tmux sessions
tmux list-sessions

# Attach to the coder's session (window 0)
tmux attach-session -t <session-name>

# Or view logs in real-time
journalctl -u nightshift.service -f | grep -i coder
```

**What to check:**
- The claude-code CLI spawns and reads the prompt.
- The agent makes edits to the file(s) in the worktree.
- The session captures output (thread events).
- The run transitions to `completed` when the agent finishes.

### 5.5 Verify the PR opens on GitHub

```bash
# Poll the task state
curl -s -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
     http://127.0.0.1:3000/tasks/"$TASK_ID" | jq '.state, .pr_url'
```

**Expected sequence:**
1. Task state: `coding` → `run` (agent working).
2. Task state: `run` → `review` (when coder completes, forge pushes, and PR opens).
3. You should see a real PR on GitHub at the URL in `pr_url`.

### 5.6 CI checks: GitHub Actions or other

If your repo has GitHub Actions enabled:
- The PR triggers CI.
- Nightshift polls the Checks API (via `CiClient`).
- Once all checks pass (or if not required), the task transitions to `review`.

**To verify CI fetch:**

```bash
# Watch logs for "CI checks" or "branch-freshness"
journalctl -u nightshift.service -f | grep -i "ci\|checks\|freshness"
```

### 5.7 Review round (optional; human reviewer on macOS/browser)

On a separate machine (e.g. your dev laptop), you can run the Codex/Gemini
reviewer in interactive mode (not yet live in this deploy; uses injected fake
for now). For this test, manually approve the PR on GitHub:

```bash
# On GitHub, click "Approve" on the PR.
# Then merge (Squash or Merge Commit — either is fine).
```

### 5.8 Verify merge and dependent unblock

Once you merge the PR on GitHub:

```bash
# The task should detect the merge and transition
curl -s -H "Authorization: Bearer $NIGHTSHIFT_API_TOKEN" \
     http://127.0.0.1:3000/tasks/"$TASK_ID" | jq '.state, .merge_sha'
```

**Expected:**
- Task state: `review` → `merged` → `done`.
- `merge_sha` is populated with the commit hash of the merge commit.
- Any dependent tasks (created with a `dependsOn` link) unblock and can be claimed.

---

## Phase 6: Troubleshooting

### Service won't start

```bash
journalctl -u nightshift.service -n 50 -e
# Check for missing env vars, database lock, or port conflict.
```

### Claude Code doesn't spawn

1. Verify `ANTHROPIC_API_KEY` is set in `/etc/nightshift/env`.
2. Check that the `claude` CLI is installed on the Linux host.
3. Look for spawn errors in the run logs: `journalctl -u nightshift.service -f`.

### Egress blocks all outbound (even GitHub)

1. Verify nftables table is active: `sudo nft list table inet nightshift_egress_uid<UID>`.
2. Check the table for syntax errors: `sudo nft -c -f <(sudo nft list table inet ...)`.
3. Try clearing and re-applying: `sudo NIGHTSHIFT_EGRESS_UID="$SERVICE_UID" bash ops/egress-teardown.sh`
   then re-apply with `ops/egress-apply.sh`.

### PR doesn't open on GitHub

1. Verify `GITHUB_TOKEN` is set and has `repo` scope.
2. Check the forge logs: `journalctl -u nightshift.service -f | grep -i "forge\|push\|pr"`.
3. Verify the worktree path exists and is writable by the service user.

### CI checks never resolve

1. Verify your GitHub Actions workflow is triggering (check the PR on GitHub).
2. Check the Checks API is responsive: `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs | jq .`
3. Look for CI polling logs: `journalctl -u nightshift.service -f | grep -i "check"`.

---

## Phase 7: Cleanup and Teardown

### 7.1 Stop the service (preserve tmux sessions)

```bash
systemctl stop nightshift.service
# Existing tmux sessions remain; boot reconciliation picks them up on restart.
```

### 7.2 Tear down egress (revert nftables)

```bash
sudo NIGHTSHIFT_EGRESS_UID="$SERVICE_UID" bash ops/egress-teardown.sh
```

### 7.3 Uninstall the systemd unit

```bash
sudo systemctl disable nightshift.service
sudo rm /etc/systemd/system/nightshift.service
sudo systemctl daemon-reload
```

### 7.4 Remove secrets (optional; keep for token rotation)

```bash
sudo rm /etc/nightshift/env
# Or keep it if you plan to restart the service.
```

---

## Appendix: Key Files

| File | Purpose |
|------|---------|
| `ops/deploy.sh` | Idempotent installer; does steps 1–6. |
| `ops/nightshift.service` | systemd unit; manages service lifecycle. |
| `ops/egress-apply.sh` | Activates nftables ruleset (requires root). |
| `ops/egress-teardown.sh` | Deactivates nftables ruleset (requires root). |
| `/etc/nightshift/env` | Secrets store; created by deploy.sh, mode 0640. |
| `data/nightshift.db` | SQLite database; created by deploy.sh. |
| `src/egress/applyCli.ts` | Live nftables builder (called by egress-apply.sh). |
| `src/runs/liveSpawn.ts` | Live Claude Code spawner (called by coder orchestrator). |
| `src/forge/githubForgeClient.ts` | Live GitHub REST client (push + PR). |
| `src/gate/githubCiClient.ts` | Live GitHub Checks API client. |

---

## Appendix: State Machine Summary

The task state machine for the "fix typo" test:

```
draft → coding
         ↓
       run (agent working)
         ↓
    completed (agent done)
       ↓ (forge: branch-freshness + CI gate pass)
       review (awaiting human approval)
         ↓ (human approves + merges on GitHub)
       merged (merge_sha captured)
         ↓ (task completion logic)
       done (dependents unblocked)
```

Blocking edges (coding → needs_human):
- Branch is stale; rebase required (gate_blocked).
- CI checks are red or missing (gate_blocked).
- Secret scanner found credentials (forge_blocked).
- Any other validation failure (orchestrator_error).

---

## Appendix: Provider CLI Flags

The live spawner uses these CLI invocations (defined in `src/live/oneShot.ts`):

| Provider | Invocation | Notes |
|----------|-----------|-------|
| claude-code | `claude --print` | Reads prompt from stdin; no file/TTY. |
| codex | `codex exec -` | Reads prompt from stdin (same pattern). |

If you upgrade Bun or Anthropic CLI, verify the flag names still work:
```bash
# On the Linux host, test manually
echo "Say hello" | claude --print
echo "Write a function" | codex exec -
```

---

## Appendix: Rollback Checklist

If the system is unstable and you need to rollback:

1. **Tear down egress** (restore unrestricted outbound):
   ```bash
   sudo NIGHTSHIFT_EGRESS_UID="$(id -u nightshift)" bash ops/egress-teardown.sh
   ```

2. **Stop the service:**
   ```bash
   systemctl stop nightshift.service
   ```

3. **Restore the previous code** (if you deployed from a different commit):
   ```bash
   cd /opt/nightshift
   git reset --hard <previous-commit-sha>
   ```

4. **Restart:**
   ```bash
   systemctl start nightshift.service
   systemctl status nightshift.service
   ```

---

**Questions?** See `docs/BLUEPRINT.md` (§3.12), `docs/SPEC-STATE-MACHINES.md`,
`IMPLEMENTATION-PLAN.md`, or the inline JSDoc in `src/`.

**Live findings** (post-deploy feedback for owners):
- Record any issues, times, error messages, and workarounds here for the next iteration.
- If xterm.js terminal is not responsive, check browser console and `journalctl`.
- If CI polling stalls, validate the PAT scope and rate limits on GitHub.
