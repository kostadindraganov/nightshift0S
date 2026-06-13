# Nightshift — Linux (Debian) Setup Runbook for Claude Code

**Audience: a Claude Code CLI agent running ON the target Debian machine.**
Execute the tasks below in order. Each task has a **Verify** gate — do not advance
until it passes. Where a step needs a human secret, **STOP and ask the operator**;
never invent tokens.

> Target: Debian 12 (bookworm) / 13 or Ubuntu 22.04+. Run as a user with `sudo`.
> Goal: get the machine to the point where `ops/deploy.sh` runs clean and a `ready`
> task can actually spawn a live coder (GATE 5). This runbook does the OS prep +
> deploy; the GATE-5 wiring worklist is in `IMPLEMENTATION-PLAN.md` (Phase 8).

---

## Preflight — confirm the environment

```sh
. /etc/os-release && echo "OS: $PRETTY_NAME"
whoami; sudo -n true 2>/dev/null && echo "sudo: ok" || echo "sudo: will prompt"
uname -m   # expect x86_64 or aarch64
```

**Verify:** Debian/Ubuntu, you have sudo, arch is x86_64 or aarch64. If not, STOP
and report to the operator.

---

## Fast path (recommended) — `ops/prep-debian.sh`

Tasks 1–4 (system packages + Node/CLIs + Bun + optional extras) are bundled into
one idempotent script. Run it FIRST; if it exits `RESULT: host prepared.` you can
skip straight to **Task 5**. The manual Tasks 1–4 below are the detailed fallback
/ reference if the script reports anything `MISSING`.

```sh
# from the repo root (Task 5 clones it if needed)
bash ops/prep-debian.sh
# optional extras:  INSTALL_DOCKER=1 INSTALL_GH=1 bash ops/prep-debian.sh
```

The script installs ONLY OS prerequisites — it never touches secrets, the service
user, the DB, or systemd (that is `ops/deploy.sh`, Task 7). It is safe to re-run.

**Verify:** the script prints `RESULT: host prepared.` and the verify block shows
no `MISSING`. If it does not, fall back to the matching manual task below.

---

## Task 1 — System packages (apt)

These are the binaries Nightshift actually spawns/needs: `git` (forge), `tmux`
(agent sessions), `bwrap` (sandbox), `nft` (egress), plus the Bun-installer deps.

```sh
sudo apt update
sudo apt install -y \
  git \
  tmux \
  bubblewrap \
  nftables \
  curl ca-certificates unzip \
  build-essential \
  openssl
```

**Verify:**
```sh
for b in git tmux bwrap nft openssl; do printf '%-8s ' "$b"; command -v "$b" || echo MISSING; done
git --version; bwrap --version; nft --version
```
All five present, no `MISSING`. (`bwrap`/`nft` activate automatically once on PATH;
no config needed yet — egress rules are applied later via `ops/egress-apply.sh`.)

---

## Task 2 — Node.js 20 + the AI CLIs (coder + reviewer)

`claude` (coder) and `codex` (reviewer) are the two CLIs Nightshift drives. They
install via npm and need Node ≥ 18; Debian's default may be older, so use
NodeSource 20.

```sh
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

sudo npm i -g @anthropic-ai/claude-code   # provides `claude`
sudo npm i -g @openai/codex               # provides `codex`
```

**Verify:**
```sh
node --version    # v20.x
claude --version
codex --version
```
All three resolve. If `claude`/`codex` are not found, check the npm global bin
dir: `npm prefix -g`/bin should be on PATH.

---

## Task 3 — Bun (runtime)

`ops/deploy.sh` installs Bun for the `nightshift` service user itself, so this
step is OPTIONAL — only do it if you want `bun` available for your current user
(e.g. to run tests before deploying).

```sh
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"   # add to ~/.bashrc for persistence
```

**Verify:** `bun --version` → ≥ 1.3.

---

## Task 4 — (Optional) containers + GitHub CLI

Only if the deployment will use the container run-level (Phase 7.1) or `gh` for
token auth instead of a raw `GITHUB_TOKEN`.

```sh
sudo apt install -y docker.io   # OR: sudo apt install -y podman
sudo apt install -y gh
```

**Verify (if installed):** `docker --version` (or `podman --version`); `gh --version`.
Skip silently if the operator doesn't need these.

---

## Task 5 — Get the repository

If the repo is not already checked out at `/opt/nightshift`, clone it. **Ask the
operator for the repo URL** if it is not obvious from the current directory.

```sh
# If you are already inside the repo, skip. Otherwise:
sudo mkdir -p /opt/nightshift
sudo chown "$USER" /opt/nightshift
git clone <REPO_URL> /opt/nightshift
cd /opt/nightshift
```

**Verify:** `ls /opt/nightshift/ops/deploy.sh` exists; `git -C /opt/nightshift rev-parse HEAD` prints a SHA.

---

## Task 6 — Collect secrets (STOP — ask the operator)

`ops/deploy.sh` is fail-closed: it refuses to run without these. **Do NOT generate
or guess `GITHUB_TOKEN` or provider keys — ask the operator and wait.**

Required:
- `NIGHTSHIFT_API_TOKEN` — Bearer token for all protected API endpoints. You MAY
  generate this one: `openssl rand -hex 32`. Confirm with the operator that a
  fresh token is acceptable, then record it where they can retrieve it.
- `GITHUB_TOKEN` — GitHub PAT with `repo` scope (forge push + PR). **Operator-supplied.**

Provider auth — at least one path per CLI (**operator-supplied**):
- Anthropic: `ANTHROPIC_API_KEY=...` **or** an interactive `claude` subscription login.
- OpenAI: `OPENAI_API_KEY=...` **or** an interactive `codex` login.

> Security note (THREAT-MODEL): these keys stay host-side. `launcher.ts`
> deliberately strips `*_API_KEY` from the agent's tmux environment — they are for
> forge/CI and provider auth, never injected into the agent. Do not work around this.

**Verify:** you have a value for `NIGHTSHIFT_API_TOKEN` and `GITHUB_TOKEN`, and at
least one provider auth method per CLI. If any are missing, STOP and ask.

---

## Task 7 — Run the deploy

`ops/deploy.sh` is idempotent. It creates the `nightshift` service user, installs
Bun for it, runs `bun install --frozen-lockfile` + `bun run db:migrate`, writes
secrets to `/etc/nightshift/env` (mode 640), installs+starts the systemd unit, and
health-checks `/healthz`.

```sh
cd /opt/nightshift
sudo \
  NIGHTSHIFT_API_TOKEN="<token>" \
  GITHUB_TOKEN="<pat>" \
  ANTHROPIC_API_KEY="<key-or-omit-if-using-login>" \
  OPENAI_API_KEY="<key-or-omit-if-using-login>" \
  bash ops/deploy.sh
```

**Verify:**
```sh
systemctl status nightshift.service --no-pager   # active (running)
curl -sf http://127.0.0.1:3000/healthz           # {"ok":true}
curl -sf http://127.0.0.1:3000/readyz            # {"ok":true} (DB migrated)
```
All green. If `/readyz` is 503, migrations didn't apply — check
`journalctl -u nightshift.service -n 50`.

---

## Task 8 — PATH sanity for spawned CLIs (critical)

When the server spawns `claude`/`codex` it inherits the SERVICE process's PATH —
not your interactive shell. Confirm the systemd unit's environment can find every
binary, or live coder/reviewer spawns will fail with `ENOENT posix_spawn`.

```sh
systemctl show nightshift.service -p Environment
# As the service user, every binary must resolve:
sudo -u nightshift bash -lc 'for b in git tmux bwrap nft node claude codex bun; do printf "%-8s " "$b"; command -v "$b" || echo MISSING; done'
```

**Verify:** no `MISSING` for the service user. If `claude`/`codex` are missing,
add the npm global bin dir (`npm prefix -g`/bin) and `~/.bun/bin` to the unit's
`Environment=PATH=...` (drop-in at `/etc/systemd/system/nightshift.service.d/`),
then `sudo systemctl daemon-reload && sudo systemctl restart nightshift.service`.

---

## Task 9 — (Optional now / required for untrusted repos) egress allowlist

Only when `sandbox.unattendedUntrustedRepos: true` in config. Applies nftables
default-drop egress scoped to the service UID.

```sh
SERVICE_UID=$(id -u nightshift)
sudo NIGHTSHIFT_EGRESS_UID=$SERVICE_UID bash /opt/nightshift/ops/egress-apply.sh
sudo nft list tables          # expect nightshift_egress_uidXXXX
```

**Verify:** the `nightshift_egress_uidXXXX` table is listed. Teardown if needed:
`sudo NIGHTSHIFT_EGRESS_UID=$SERVICE_UID bash ops/egress-teardown.sh`.

---

## Done — report back to the operator

Summarize:
1. Versions installed (`node`, `bun`, `claude`, `codex`, `git`, `bwrap`, `nft`).
2. `systemctl status` + `/healthz` + `/readyz` results.
3. Service-user PATH check result (Task 8).
4. Whether egress (Task 9) and containers (Task 4) were set up or skipped.

Then point the operator at **`IMPLEMENTATION-PLAN.md` → Phase 8 / GATE-5 worklist**
and **`docs/LINUX-DEPLOY.md`** for the next phase: boot-wiring the host
`resolveSpawn` closure and running the "fix typo" task end-to-end
(real spawn → push → PR → review → human merge → dependents unblock).

---

## Gotchas (do not violate)

- **Never run bare `bun test`** — it discovers vendored/e2e files that HANG. Use
  `bun run test` (the curated script in `package.json`).
- **Secrets are host-side only.** Don't echo tokens into logs, don't commit
  `/etc/nightshift/env`, don't inject `*_API_KEY` into agent environments.
- **Don't generate `GITHUB_TOKEN` or provider keys** — they are operator-supplied.
- **A `ready` task parking without spawning is expected** until the host
  `resolveSpawn` closure is wired (GATE-5, Phase 8). OS prep being complete does
  NOT by itself make tasks auto-code.
