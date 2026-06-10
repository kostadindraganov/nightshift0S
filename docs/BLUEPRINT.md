# Nightshift — Blueprint (FINAL, 2026-06-10)

> **Nightshift** — autonomous "dark factory" software platform synthesized
> from the best ideas of the 6 sources in this folder: plan in → tasks →
> kanban → agents code → PR → agent review → auto-merge. Runs on a Linux VM.
> Works while you sleep.

---

## 1. What each source project is

### localforge (Next.js + SQLite, v0.1.0 — prototype)
Autonomous local code-generation app: describe an app in chat ("bootstrapper"),
AI generates a feature backlog, agents implement features in parallel (up to 3),
tracked on a drag-and-drop kanban board with live SSE streaming.
- **Best ideas to steal:** the kanban UX (Backlog → In Progress → Completed,
  dnd-kit, live status sync), feature dependency graph (a feature is "ready"
  only when blockers complete), AI bootstrapper chat that turns a plan into a
  backlog, failure handling via priority demotion, Playwright verification with
  screenshots as card badges.
- **Gaps:** no git/GitHub, no code review, local-LLM only.

### sandcastle (TypeScript / Effect.js library + CLI, v0.7.0 — beta)
Orchestration *library* for running AI coding agents in isolated sandboxes
(Docker/Podman/Vercel) on git worktrees, with pluggable **agent providers**:
`claudeCode()`, `codex()`, `pi()`, `cursor()`, `opencode()`, `copilot()`.
- **Best ideas to steal:** the **agent-provider abstraction** (one interface →
  any CLI agent; this is exactly how you use Claude Code CLI + Codex CLI on
  Max/Pro subscriptions instead of API keys), git-worktree branch strategies,
  workflow templates (`parallel-planner-with-review`: plan → parallel implement
  → per-branch review → merge), session capture/resume/fork, structured output
  with Zod schemas, completion/idle timeouts.
- **Gaps:** no UI/dashboard, no persistence of run history, single host.

### tank (Python FastAPI + HTMX + SQLite — beta, deployed in production)
Mission-control dashboard that spawns **interactive** Claude Code sessions in
tmux on a remote Linux server. Build queue with dependencies, per-task git
worktrees, Forgejo PR/merge buttons, lifecycle hooks bridging Claude Code
events back to the API, idempotent SSH deploy + systemd.
- **Best ideas to steal:** tmux + live xterm.js terminal attach (watch/steer
  any agent live), Claude Code **lifecycle-hooks → API event bridge**,
  `--session-id`/`--resume` multi-turn memory, sequential queue with
  auto-commit so later items build on earlier ones, prompt-via-temp-file trick
  (ARG_MAX), **non-root service user** (required for
  `--dangerously-skip-permissions`), the idempotent `deploy.sh` + systemd
  pattern for Linux VMs, Forgejo as self-hosted GitHub alternative.
- **Gaps:** Claude Code only, sequential-only queue, Forgejo-only.

### warren (Bun + TypeScript + SQLite/Postgres, v0.6.2 — stable V1)
Self-hostable control plane for ephemeral cloud agents: point at GitHub repos,
pick an agent, write a prompt → sandboxed run (bwrap via "burrow"), live NDJSON
event stream, mid-run steering, branch pushed back + **auto-generated PR**.
- **Best ideas to steal:** the control-plane architecture (event log persisted
  in DB → crash-safe reload + audit), **plan-runs** (a plan's children dispatch
  sequentially, each gated on the previous PR merging), per-run **cost & token
  tracking** + `/analytics/cost`, model-tier env overrides
  (`WARREN_MODEL_OPUS=...` — swap models without rebuild), agents have **no
  GitHub credentials** — the host pushes (security), per-run preview
  environments (`https://run-<id>.<host>`), PR body templates, healthz/readyz,
  structured JSON logs, single-container Docker deploy.
- **Gaps:** no kanban, manual merge, single shared GitHub token.

### autoresearch (Karpathy, Python — added 2026-06-10)
Autonomous overnight research loop: an agent edits one file (`train.py`),
trains 5 minutes, measures one metric (val_bpb), keeps or discards via git,
logs to results.tsv, repeats ~100×/night. The human edits only `program.md` —
the "research org code".
- **Best ideas to steal:**
  - **The experiment loop as a primitive**: modify → commit → run with FIXED
    time budget → measure ONE ground-truth metric → improve ⇒ advance branch,
    else ⇒ `git reset` → loop. Git is the checkpoint machine.
  - **Immutable eval harness**: the measuring code (`prepare.py`) is outside
    the agent's write scope — the agent cannot game the metric. (Anti-Goodhart
    guard.)
  - **Fixed budget per iteration** ⇒ comparable experiments + predictable
    throughput (12/hour).
  - **Simplicity criterion in the prompt**: deletion wins are celebrated;
    tiny gains that add hacky complexity are rejected.
  - **program.md pattern**: human iterates the instructions, agent iterates
    the code — exactly our versioned-prompt records (§3.8).
  - **NEVER-STOP semantics** for unattended runs: explicit "do not ask to
    continue, the human is asleep" instruction block.
  - **Context hygiene**: output → run.log, agent greps only the metric line.
  - Experiment ledger (results.tsv: commit, metric, status, description)
    kept OUT of git history.

### cloudflare-ai-code-review.md (article — battle-tested design, 10k+ MRs)
Cloudflare's CI-native AI code review: a **coordinator** agent (top-tier model)
spawns up to 7 **specialised sub-reviewers** (security, performance, quality,
docs, release, compliance), deduplicates/judges their findings, posts one
structured review, and approves / comments / **blocks the merge**.
- **Best ideas to steal:**
  - **Risk tiers:** trivial (≤10 lines) → 2 agents w/ cheap models; lite
    (≤100) → 4; full → 7+. Don't burn Opus on a typo fix.
  - **Approval rubric** biased toward approval; only critical findings block.
  - **`break glass`** human override comment → forced approval, telemetry'd.
  - Diff noise filtering (lockfiles, minified, generated — except migrations).
  - **Circuit breakers + failback chains** per model family
    (opus-4-7 → opus-4-6; never cross providers mid-task), error
    classification (only retryable API errors trigger failback).
  - Shared context file on disk instead of duplicating MR context ×7.
  - Prompt-injection stripping of XML boundary tags from user content.
  - KV-style remote config: flip a provider off, all jobs reroute in seconds.
  - Heartbeat "model is thinking…" logs; JSONL streaming; per-task +
    overall timeouts.

---

## 2. Dark Factory — target capability (user requirements)

1. Input a **plan** → system breaks it into **tasks** (with dependencies).
2. **Kanban board** to watch everything live.
3. A coding agent picks a task, implements it in an isolated worktree/sandbox,
   pushes a branch + opens a **PR** on GitHub *or* a self-hosted forge
   (Forgejo/Gitea/GitLab).
4. A **reviewer agent** (coordinator + specialists) reviews the PR and
   **merges** it when approved (or sends it back with findings).
5. **Multi-provider auth:**
   - API keys: Anthropic, OpenAI, Google, Groq, Mistral, DeepSeek…
   - **Subscriptions** (Claude Max / ChatGPT Pro): drive **Claude Code CLI**,
     **Codex CLI**, **Antigravity CLI**, Gemini CLI etc. as agent providers —
     the CLIs carry their own auth, so no per-token billing.
6. Deployed on a **Linux VM** (systemd or single Docker container).

## 3. Proposed architecture

```
┌─ Linux VM ───────────────────────────────────────────────────────┐
│  Web UI (kanban + live terminals + analytics)                    │
│   └─ React/Next or HTMX — kanban from localforge,                │
│      xterm.js live attach from tank                              │
│  Control plane (API server)                                      │
│   ├─ SQLite (Postgres optional)  — projects, plans, tasks,       │
│   │   runs, event log (warren-style, crash-safe), cost/tokens    │
│   ├─ Planner: plan → tasks + dependency graph (localforge        │
│   │   bootstrapper + warren plan-runs)                           │
│   ├─ Scheduler: picks ready tasks, N parallel slots,             │
│   │   failure → demote priority (localforge)                     │
│   └─ Review pipeline: risk tier → coordinator + specialists →    │
│       rubric → approve/block/merge (Cloudflare design)           │
│  Agent layer (sandcastle-style provider interface)               │
│   ├─ claude-code (CLI, subscription or API key)                  │
│   ├─ codex (CLI, subscription or API key)                        │
│   ├─ antigravity / gemini / opencode / cursor (CLI)              │
│   └─ api-direct (raw Anthropic/OpenAI APIs for cheap subtasks    │
│       like titling, dedup, classification)                       │
│  Execution layer                                                 │
│   ├─ git worktree per task (sandcastle/tank)                     │
│   ├─ tmux session per agent → live attach + steer (tank)         │
│   └─ optional Docker/bwrap sandbox per run (warren)              │
│  Forge layer (pluggable VCS provider, Cloudflare plugin idea)    │
│   ├─ GitHub (gh CLI / REST)                                      │
│   ├─ Forgejo/Gitea (tank)                                        │
│   └─ GitLab                                                      │
│  Resilience: circuit breakers, failback chains, per-task +       │
│   overall timeouts, heartbeats, JSONL event streams              │
└──────────────────────────────────────────────────────────────────┘
```

### Task lifecycle (the factory line)
```
Plan (chat/markdown) → Planner agent → tasks + deps (Backlog)
  → Scheduler claims ready task → worktree + branch + tmux
  → Coder agent (provider per task: claude-code | codex | …)
  → commit + push + open PR (host pushes; agent has no forge creds)
  → Review pipeline: risk tier → specialists → coordinator verdict
       approved            → auto-merge PR → task Done → unblock dependents
       changes requested   → findings appended → task back to coder (same
                             session resumed, max K review rounds)
       human override      → "break glass" comment forces merge
  → cost/tokens recorded per run; kanban card updates live throughout
```

### Key design decisions (carried over)
- **Agents never hold forge credentials** — the control plane pushes/merges
  (warren). Single place to rotate tokens; later GitHub App tokens.
- **Coder and reviewer are different providers by default** (e.g. Claude Code
  writes, Codex reviews) — cross-model review catches more.
- **Subscription vs API key per provider** is just config: CLI providers use
  their own login state (`claude login` / `codex login` once on the VM, under
  the service user); API providers read env keys. Model tiers remappable via
  env/config without redeploy (warren + Cloudflare KV idea).
- **Non-root service user** on the VM — Claude Code refuses
  `--dangerously-skip-permissions` as root (tank).
- **Everything is an event** in one append-only log → live UI, crash recovery,
  audit, cost analytics all come free (warren).
- **Risk-tiered review** so trivial diffs cost cents, not dollars (Cloudflare).

## 3.1 Extended feature set (confirmed 2026-06-10)

### Quality & cost control
- **CI/test gate before PR** — coder agent runs the project's tests + lint in
  the worktree; PR opens only on green. Results attached to the PR body and
  visible to the reviewer agent.
- **Playwright verification** — optional browser test + screenshots per task,
  shown as badges on the kanban card (localforge).
- **Budgets & kill-switch** — token/$ caps per project and per task; on breach
  the scheduler pauses the project and notifies. Backed by per-run cost
  tracking (warren) + risk tiers (Cloudflare).
- **Security review pass** — dedicated security specialist reviewer, always
  included when the diff touches sensitive paths (auth/, crypto/, secrets,
  .env, Dockerfiles, CI configs).

### Triggers & notifications
- **Webhook triggers** — GitHub/Forgejo issue labeled `factory` or a comment
  `@factory <instruction>` auto-creates a task; PR comments can re-trigger
  review or request changes.
- **Cron / scheduled runs** — nightly maintenance tasks: dependency updates,
  lint sweeps, backlog grooming (warren triggers.yaml pattern).
- **Telegram/Slack bot** — push notifications on done/failed/awaiting-input
  and over-budget; replying in the thread steers the agent (maps to
  `POST /runs/:id/steer` / tank `continue`).
- **Email digest** — daily summary: completed/blocked tasks, merged PRs,
  spend per project.

### Memory & knowledge
- **Per-project agent memory** — persistent expertise directory in each repo
  (mulch-style): agents record lessons learned at reap time, future runs seed
  from it.
- **AGENTS.md auto-maintenance** — a reviewer checks whether the repo's
  AGENTS.md/CLAUDE.md is stale relative to the diff and proposes the update
  (Cloudflare's AGENTS.md reviewer).
- **Analytics dashboard** — success rate, time-per-task, cost-per-task,
  provider/model leaderboard (which model completes which task types best).
- **Transcript browser** — full session history per run: prompts, tool calls,
  thinking, review verdicts; linked from the kanban card and the PR.

### Infrastructure
- **Preview environments** — every PR gets a live URL
  (`run-<id>.<domain>`), auto-reaped when idle (warren).
- **Container sandbox per run** — Docker/bwrap isolation (network + fs
  limits) as an opt-in level above worktree-only.
- **Multi-VM workers** — worker daemons on extra Linux machines pull tasks
  from the central queue; control plane stays single.
- **CLI auto-update + auth healthcheck** — factory keeps claude/codex/
  antigravity CLIs updated and surfaces auth expiry (subscription login state)
  on a status page before it breaks runs.

## 3.2 Work intake: To-Do / Schedule / Routines (added 2026-06-10)

Three intake surfaces feed the same task pipeline:

- **To-Do** — per-project checklist (tank's TODO.md pattern, but DB-backed with
  markdown import/export). Items are lightweight notes; a "→ task" action
  promotes an item into a real kanban task (planner agent expands it into
  description + acceptance criteria + dependencies).
- **Schedule** — one-off ("run this Saturday 03:00") and recurring (cron)
  entries. Each entry points at a routine or a task template; the scheduler
  creates a task instance at fire time (warren `triggers.yaml` pattern).
- **Routines** — named, reusable task templates with parameters: e.g.
  `dependency-update(repo)`, `lint-sweep(repo)`, `triage-issues(repo)`,
  `security-audit(paths)`. Runnable manually (one click), from schedule, or
  from webhook. Routines define: prompt template, default provider/model,
  risk tier, budget cap, and whether result goes through full review.

## 3.3 Inter-agent communication: the Coder ↔ Reviewer dialogue (added 2026-06-10)

Agents don't just hand off artifacts — they hold a **conversation per task**
until they agree the code is correct.

### Task thread (the shared channel)
Every task has an append-only **thread** in the DB. Participants: coder agent,
reviewer agent(s), system, human. Messages are structured:
`{author, role: coder|reviewer|system|human, type: finding|reply|verdict|note,
body, refs: [file:line], round}`. The thread is rendered in the UI and is the
single source of truth both agents see.

### The ping-pong review loop
```
Round r (max K rounds, default 4):
1. Coder (e.g. Claude Code CLI) implements / fixes → commit → push → PR diff
2. Reviewer (different provider: Codex CLI or Gemini CLI) reads the diff +
   thread history → emits STRUCTURED verdict (JSON schema, not prose):
   { verdict: approved | revise,
     findings: [{file, line, severity, confidence, description, suggestion}],
     summary }
3. verdict == approved → merge, task Done.
   verdict == revise  → findings appended to thread → coder RESUMES THE SAME
   SESSION (claude --resume <uuid> / codex resume) with the findings as the
   next turn → coder either fixes (commit) or REBUTS a finding in the thread
   ("intentional because X") → reviewer's next round must address rebuttals
   explicitly (accept/withdraw or escalate).
4. Re-review is a DELTA review: reviewer gets previous findings + new diff
   only, marks each prior finding resolved/persisting (Cloudflare re-review
   pattern). No starting from scratch each round.
5. Round K reached without agreement → task → "needs human", thread + both
   positions presented; human verdict is final ("break glass" merge or reject).
```

Key properties:
- **Cross-model by default** — writer and reviewer are different vendors
  (Claude writes / Codex or Gemini reviews, or rotated per task). Same-vendor
  review allowed but flagged in analytics.
- **Session continuity** — both sides keep their CLI session ids; every round
  is a resume, not a fresh context. Cheap (cached) and the agents genuinely
  "remember" the argument.
- **Disagreement is data** — rebuttal-accepted vs rebuttal-rejected rates per
  provider feed the analytics leaderboard.
- **Optional tiebreaker** — on round K-1, a third model (e.g. Gemini if
  Claude+Codex are deadlocked) gets the thread and votes; 2-of-3 wins. This is
  the API-direct "advisor / judge" use case — a single structured-output call,
  no CLI session needed.

## 3.4 Review harness — best-practice design (added 2026-06-10)

Synthesis of Cloudflare's production system + Anthropic agent-design guidance.

### Pipeline shape
```
PR diff → noise filter (lockfiles, minified, generated; keep migrations)
       → risk tier (trivial/lite/full + always-full for security paths)
       → context pack (shared-context file on disk + per-file patches;
         sub-reviewers read files, context is NOT duplicated into N prompts)
       → finder stage: N specialist reviewers IN PARALLEL
         (security / correctness / performance / quality / docs / AGENTS.md)
       → coordinator (top-tier model): dedup, re-categorize, adversarial
         verify uncertain findings by reading source, apply verdict rubric
       → verdict: approve / approve-with-comments / block
       → post ONE structured review; findings also land in the task thread
```

### Rules that make it work
- **Recall-first finders, precision at the coordinator.** Finder prompts say:
  "Report every issue you find, including uncertain/low-severity ones, with
  confidence + severity — a separate verification step filters." (Modern
  models follow severity filters literally; self-filtering at the finder
  stage silently kills recall.)
- **Structured outputs everywhere.** Verdicts and findings are JSON-schema
  validated (`output_config.format` on API calls; `--output-schema` /
  structured-output parsing for CLI agents). No prose parsing.
- **Approval-biased rubric** (Cloudflare): only critical/production-risk
  findings block; one warning ≠ block. `break glass` comment = forced merge,
  logged.
- **Prompt-injection hygiene**: strip XML boundary tags from PR
  titles/descriptions/comments before they enter any reviewer prompt.
- **Model resilience**: circuit breaker per model family, failback chains
  within a vendor (opus-4-8 → opus-4-7; never cross vendors mid-task), error
  classification (only retryable API errors trigger failback; auth/context
  overflow do not). Remote config flips a provider off in seconds.
- **Caching discipline**: frozen system prompts, deterministic tool lists,
  diff content after the last cache breakpoint; verify
  `cache_read_input_tokens > 0` in telemetry.
- **Cheap-lane batching**: non-urgent classification (task titling, dedup,
  failure triage) goes through the Batches API at 50% cost.
- **Timeouts at three levels**: per-reviewer (5–10 min), overall review
  (25 min), retry budget. Inactivity watchdog (60 s no output → kill+retry).
  Heartbeat "model is thinking… (Ns)" lines so humans don't kill live jobs.

### Claude Agent SDK / Managed Agents as a third execution substrate
The agent layer gets **three provider kinds**, all behind one interface:
1. **CLI** (claude-code, codex, gemini/antigravity, opencode…) — subscription
   auth, interactive tmux, session resume. Workhorse for coding.
2. **API-direct** (Anthropic/OpenAI SDKs) — structured-output one-shots:
   coordinator judging, tiebreaker votes, titling, planning. Supports prompt
   caching + batches.
3. **Managed Agents (Anthropic CMA)** — server-managed sessions where
   Anthropic hosts the sandbox: create reviewer/coder Agent configs ONCE
   (versioned), spawn a Session per task with the GitHub repo mounted as a
   resource (`github_repository` + checkout branch), stream events (SSE),
   and use **Outcomes** (`user.define_outcome` + rubric) to get the built-in
   iterate → grade → revise loop — the platform-native version of our review
   ping-pong. **Memory stores** give reviewers persistent memory of past
   false positives per project; **multiagent coordinator** mirrors the
   Cloudflare coordinator/specialist pattern natively; **webhooks** notify
   the control plane on idle/terminated without holding streams.
   Useful when the VM is busy or for burst capacity; costs API tokens
   (not subscription), so routed by the budget policy.

## 3.5 Productivity boosters (added 2026-06-10)

- **Spec-first tasks**: planner writes acceptance criteria as *testable
  assertions*; coder must add/extend a test proving each one; reviewer checks
  criteria coverage, not just code quality.
- **Plan review before code** (codex-review pattern): for high-risk tasks
  (schema, auth, concurrency), coder first emits PLAN.md; reviewer model
  approves the plan in the same thread before a line is written. Cheap rounds
  on the plan beat expensive rounds on the diff.
- **Tournament mode** for hard tasks: 2–3 agents (different providers)
  implement in parallel worktrees; a judge panel scores; best branch proceeds
  to review; losers' good ideas appended to the thread.
- **Auto-triage of failures**: a Haiku-class classifier reads the failed run
  transcript → {flaky: retry same | wrong-approach: retry with hint |
  provider-issue: reassign other provider | needs-human}. Feeds priority
  demotion (localforge) instead of dumb retries.
- **Model routing by evidence**: analytics leaderboard (success rate ×
  cost × review-rounds per provider per task-category) drives default
  provider selection per routine/category; manual override always possible.
- **Context packs**: every agent run is seeded with AGENTS.md, the project
  memory file, the task thread, and ONLY diff-relevant source paths —
  assembled by the control plane, not rediscovered by each agent (token +
  latency win, mirrors Cloudflare shared-context file).
- **Outcome rubrics on routines**: routines ship a "done rubric"; a grader
  pass scores the result against it before the task can close (own-harness
  version of CMA Outcomes; with CMA substrate it's native).
- **Quiet-agent prompts**: coder agents get a silence-default instruction
  (narrate only findings/blockers); cuts tokens in long tool sessions
  without quality loss.
- **Daily standup digest**: an agent reads yesterday's event log → 10-line
  digest (done/blocked/spend/flaky) → Telegram/email; doubles as the email
  digest feature.

## 3.6 Hard-won implementation rules (mined from ADRs + knowledge graphs, 2026-06-10)

> Source: sandcastle/docs/adr/ (20 ADRs), */graphify-out/GRAPH_REPORT.md,
> */.understand-anything/. These are guardrails against failures the source
> projects already hit in production — inherit them, don't rediscover them.

### Git & worktree correctness (sandcastle ADRs)
- **Worktree locking** (ADR-0007): atomic file lock per worktree with PID
  stale-detection; fail-fast on contention, never wait/retry. Two concurrent
  runs on one branch silently clobber unpushed commits otherwise.
- **Worktree reuse** (ADR-0003): clean + strictly-behind-origin → fast-forward
  only; NEVER `reset --hard`; dirty/diverged → reuse as-is + log why.
- **Branch name randomness**: temp branch names need a crypto-random suffix —
  second-granularity timestamps collide under parallel fan-out (known latent
  bug in sandcastle).
- **Fork ≠ isolation** (ADR-0018): session fork does NOT isolate git; parallel
  forks MUST get distinct branches or they race on shared HEAD.
- **Sync-base ref** (ADR-0017): for isolated sandboxes track last-synced commit
  in `refs/<ns>/sync-base` — `git am` rewrites SHAs, so host HEAD is never a
  valid base on run 2+; commits get lost without this.
- **Worktrees preserved on error/abort** (ADR-0004): never auto-teardown on
  failure — that's the recovery surface.

### Session & process management (sandcastle + tank)
- **Resume = exactly one iteration** (ADR-0011); orchestrator chains resumes.
  **Provider-owned session storage** (ADR-0012/0016): each agent provider owns
  where/how sessions persist; file-backed (JSONL) is resumable, SQLite-backed
  agents are not.
- **Completion timeout ≠ idle timeout** (ADR-0019): once the completion signal
  is seen, switch from idle timeout (10 min) to completion timeout (1 min),
  then force-complete SUCCESSFULLY and warn — a hanging `gh`/MCP subprocess
  must not turn finished work into a failure. Saves ~9 min per hang.
- **Per-step timeouts** (ADR-0001): every lifecycle step (container start,
  git ops, hooks) gets its own timeout + typed error; defaults baked in, no
  config knobs.
- **Prompt expansion fails fast** (ADR-0020): deterministic, no retry, no
  silent degradation; typed errors (timeout vs exit-code) so the orchestrator
  can decide retry-whole-run vs don't.
- **Orphan reaping order matters** (tank): kill tmux → pkill the agent CLI →
  **sleep ~400 ms** → only then touch files/DB; the agent process outlives
  tmux by a beat and rewrites state files.
- **Interim Stop for background subagents** (tank): a Stop hook with
  `background_tasks: [{status: running}]` is interim — park the task as
  `background_waiting`, keep tmux alive; finalize only on the Stop after all
  subagents return.
- **Watchdog with transcript inspection** (tank): every 60 s, tasks silent
  >5 min get their JSONL transcript inspected — api-error tail → errored;
  normal assistant tail → completed (missed hook); empty → leave alone.
- **Startup reconciliation** (tank/localforge): on boot, close DB sessions
  whose process/tmux is gone, return their tasks to backlog; atomic file
  writes (`.tmp` + rename) everywhere config/markdown is touched.

### Event log & streaming (warren)
- **Write-through, then publish**: DB insert FIRST, in-memory broker notify
  second. DB = durability, broker = ephemeral fan-out.
- **Subscribe → replay history → tail live, dedup by event seq** — the only
  gap-free streaming recipe (subscribe before reading history).
- **Bounded subscriber buffers** (~1024 events), drop-oldest + `dropped`
  counter; a slow consumer must never block the publisher (tank does the same
  with `put_nowait`; localforge's synchronous EventEmitter broadcast is the
  anti-pattern — it stalls the orchestrator).
- **SQLite in WAL mode** from day one (warren does; tank/localforge default
  journal is a known contention point under parallel agents).
- **Idempotent state transitions**: `UPDATE ... WHERE id=? AND state='queued'`
  narrow-guard pattern + transactions around run-creation and plan-run child
  transitions — prevents double-dispatch.
- **Single-flight ticks**: scheduler/pollers (60s tick, 30s merge-poll) drop
  overlapping ticks, isolate per-row errors; event-wake (`asyncio.Event` /
  equivalent) for immediacy + poll as fallback (tank queue runner).
- **Supervisor pattern**: child restart with exponential backoff inside a
  5-in-60s budget; main app crash = process exit (let systemd restart).
- **Cost rows carry a `priced` flag** so unpriced runs aren't misread as free.

### UI/sync (localforge)
- Kanban drag-drop: optimistic update + revert snapshot + re-fetch after
  PATCH batch; ref-mirror for synchronous drag handlers; SSE replay-history-
  on-connect + 15 s keepalive; auto-close stream on terminal status.
- Dependency readiness: completed-set lookup O(1) per feature; BFS cycle
  check on dependency add.

## 3.7 Additional performance & efficiency measures (2026-06-10)

1. **Slot-filling scheduler** (localforge #70): on every task completion, fill
   ALL free slots in one pass (not one), via deferred call after slot release.
2. **Wake-event + poll hybrid** everywhere: never wait for the next poll tick
   when an event can wake the loop now (tank `queue_wake`); poll remains the
   safety net.
3. **Prompt-via-file delivery** for CLI agents (tank): temp file read by the
   spawned shell (`p=$(cat f); rm f; exec claude "$p"`) — kills the tmux 16 KB
   limit, the multiline auto-submit bug, and the SessionStart race in one move.
4. **Per-purpose tight timeouts on auxiliary LLM calls** (tank): titling 45 s,
   todo-rewrite 12 s, icon-suggest 15 s — degrade silently to placeholders;
   never let a nicety block the pipeline.
5. **Config & registry caches with explicit invalidation** (warren): per-repo
   config cached until `/refresh`; agent registry lazy + cached.
6. **In-memory orchestrator state in a hot-reload-safe singleton**
   (localforge globalThis pattern) so dev restarts don't orphan children.
7. **Async SSE dispatch / topic pub-sub** instead of synchronous EventEmitter
   broadcast (fixes localforge's known bottleneck at 100+ subscribers).
8. **Pre-trusted sandboxes** (tank): write `hasTrustDialogAccepted` into the
   service user's `~/.claude.json` per task cwd before spawn — no first-run
   trust dialog stalls; sweep stale entries on startup.
9. **Knowledge-graph self-documentation**: run graphify/understand-anything
   over Dark Factory itself on a cron routine; the graph reports become the
   context pack for agents working ON the factory (dogfooding what made this
   deep-dive possible).
10. **Token economics per round**: delta re-reviews + session resume (cached
    prefix) + shared context file on disk + recall-first-finder/precision-
    coordinator split = the review loop's cost scales with the diff, not with
    the repo.

## 3.8 UI/UX design & full configurability (added 2026-06-10)

### Design direction — "mission control", not AI slop
The UI is a **dark-first operations console** (factory floor at night), not a
generic SaaS template. Hard rules:

- **No generic AI aesthetics**: no Inter/Roboto-on-white, no purple gradients,
  no cookie-cutter shadcn-default look, no emoji noise, no hero sections.
  Dashboard character: dense, calm, legible under long sessions.
- **Concrete design system** (locked before coding, in `design-tokens.json`):
  - Dark base (near-black with a subtle warm or cold tint — pick one and stay),
    one **signal accent** (e.g. industrial amber or electric green) used ONLY
    for live/running states, semantic colors for statuses (running / review /
    blocked / done / failed) used consistently across kanban, terminal strip,
    analytics.
  - Typography: a distinctive grotesk for UI + a high-quality monospace
    (terminals, diffs, IDs) — type pairing chosen deliberately, not defaults.
  - Spacing/density: data-dense tables and boards (8px grid), generous only
    around primary actions.
  - Motion: micro-interactions for state changes (card slides column on
    status change, pulse dot on live agents), 150–250 ms, never decorative
    animation loops.
- **Live-ness is the hero**: pulsing presence dots per agent, streaming
  terminal panes (xterm.js themed to match), event ticker, token/cost meters
  filling in real time. The product's wow factor is watching the factory run.
- **Key screens**: ① Factory overview (all projects, live agents, spend
  today), ② Project board (kanban + thread side-panel), ③ Task detail
  (thread + live terminal + diff + review verdicts), ④ Routines & schedule,
  ⑤ Analytics (leaderboard, cost), ⑥ Settings. Keyboard-first navigation
  (cmd-k palette), every entity linkable by URL.
- Build/refine passes run through the frontend-design / impeccable skill
  pipeline; a dedicated **design review agent** (separate from code review)
  screenshots key pages via Playwright on every UI PR and judges against the
  design tokens + anti-slop rules.

### Everything configurable from the UI (no redeploy, no SSH)
Single **Settings service**: typed registry of every knob, DB-backed
(tank/warren pattern), three scopes — global → project → routine/task
(narrower wins). Hot-reload: settings read at use-time (cached with explicit
invalidation), not at boot. Env vars only bootstrap (port, install dir, DB).

Editable in UI, per scope:
- **Providers & models**: enable/disable provider, auth mode (subscription
  CLI / API key), API keys (write-only, masked), model tiers + failback
  chains, default coder/reviewer pairing, CLI auth status panel.
- **Pipeline**: max parallel slots, review rounds K, risk-tier thresholds,
  approval rubric strictness, CI-gate on/off, auto-merge on/off, security
  paths list, diff noise filters.
- **Budgets**: $/token caps per project/task/routine, kill-switch behavior.
- **Timeouts & watchdogs**: per-step values surfaced read-only with override
  field (defaults baked in per ADR-0001, override = explicit opt-in).
- **Integrations**: forge (GitHub/Forgejo/GitLab) URLs + tokens,
  Telegram/Slack webhooks, email digest schedule, webhook triggers.
- **Routines**: full CRUD in UI — prompt template editor with preview,
  parameters, schedule, provider, rubric.
- **Prompts**: every system/reviewer/planner prompt is a versioned record
  editable in UI (with diff history + revert), not a hardcoded string.
- **Appearance**: accent color, density, light mode as a supported variant.

Settings changes are events in the event log (who/when/old→new) → audit +
revert for free.

## 3.9 Provider Matrix — the unified agent/model layer (revised 2026-06-10)

One interface, two driver kinds, capability flags decide what each driver can
be used for. This replaces the looser "agent layer" sketch in §3.

### Driver kinds
**CLI drivers** (run as processes in tmux/worktrees; sandcastle provider
pattern):
`claude-code`, `codex`, `gemini-cli`, `antigravity`, `opencode`, `cursor`,
`pi`, … Each declares its session storage (ADR-0012) and capabilities.

**API drivers** (direct SDK calls; no process, no worktree):
`anthropic`, `openai`, `google` (Gemini), **`openrouter`** (one key → hundreds
of models; universal fallback lane), `mistral`, `deepseek`, `groq`, and
**`local`** (Ollama / LM Studio via OpenAI-compatible endpoint — the
localforge heritage; a free lane for utility subtasks).

### Auth is per-provider config, orthogonal to driver kind
- CLI drivers accept **subscription login** (Claude Max, ChatGPT Pro — logged
  in once on the VM under the service user) **or an API key** via env
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Both modes per provider,
  switchable in Settings.
- API drivers take keys from the Settings vault: **write-only, masked in UI,
  encrypted at rest**; injected by the control plane per run (warren pattern —
  agents never hold credentials they don't need).
- **Auth health panel**: subscription login state, key validity, expiry —
  checked on a routine, surfaced before runs break.

### Capability flags (drive the router)
```
{ interactive: bool, resume: bool, fork: bool, structured_output: bool,
  cost_reporting: bool, auth: [subscription|api_key],
  roles: [coder, reviewer, judge, planner, utility] }
```
The router picks a driver per role using: task category → leaderboard
evidence → budget policy → availability (circuit breaker state).

### Subscription quota scheduler (new — key feature)
Subscriptions are the cheap lane but have usage windows (e.g. 5-hour limits).
The factory tracks per-provider subscription usage and rate-limit signals;
when a subscription lane is exhausted it either **queues** work until the
window resets or **overflows to the API-key lane** — per budget policy,
per project. This is what makes "all-out subscription" usage actually
maximize value: subscription first, API keys as paid overflow, local models
for free utility work.

## 3.10 Simplifications — what we cut or merged (revised 2026-06-10)

Scope-control pass over everything above. The blueprint had begun to sprawl;
these consolidations remove duplicate machinery without losing features:

1. **One verdict-loop engine, not two.** The review ping-pong (§3.3) and the
   routine "outcome rubric" grading (§3.5) are the same loop shape:
   produce → judge (structured verdict) → revise → repeat. Build ONE engine
   with a pluggable judge (code reviewer | rubric grader | design reviewer).
   The §3.8 design review agent is a third judge plug-in, not a new system.
2. **To-Do is a task state, not a subsystem.** Drop the separate tank-style
   TODO.md service; a To-Do item = task in `draft` state (leftmost kanban
   lane). Promote = planner expands it. One data model, markdown import kept.
3. **One trigger abstraction.** Manual / cron / webhook / chat-bot are all
   `trigger → routine/task-template` records. No separate scheduler, webhook
   handler, and bot pipelines — one dispatch path (warren triggers pattern).
4. **One notifier interface.** Telegram, Slack, email digest = channels behind
   a single notifier with per-event-type routing. Ship ONE channel in V1.5
   (Telegram), add others as plugins.
5. **Managed Agents (CMA) demoted to optional plugin.** Powerful but a whole
   parallel integration; the CLI + API drivers cover every requirement. CMA
   becomes a provider plugin someone can enable in V3 — not core architecture.
6. **Preview environments deferred to V3.** Wildcard DNS + reverse proxy +
   idle reaping is real infrastructure; CI gate + Playwright screenshots
   cover most of the verification value much earlier.
7. **Tournament mode = experiment flag,** not a scheduler mode. Implemented
   trivially on top of fork/worktrees when wanted; no dedicated machinery.
8. **Playwright verification stays opt-in per project** (web projects only),
   never a default gate.

## 3.11 Experiment loops — optimization routines (from autoresearch, 2026-06-10)

A new **routine kind: `experiment`** — the generic version of autoresearch's
hill-climbing loop, applicable to anything with a measurable metric:

```
config: { target_paths: [...],          # what the agent may edit
          eval_command: "...",          # immutable, outside target_paths
          metric: {name, direction},    # one number, lower|higher is better
          iteration_budget: "5m",       # fixed wall-clock per attempt
          max_iterations | until: time, # overnight = until 07:00
          keep_rule: improved }         # advance branch vs git reset
```

Loop per iteration: edit → commit → run eval under budget → parse metric →
keep (advance) or discard (reset) → append to experiment ledger → continue.
**NEVER-STOP block** in the prompt for unattended runs. Ledger (commit,
metric, status, description) is a first-class table → renders as an
experiment timeline in the UI with the metric chart (the `progress.png`
moment is the celebration screen of this routine kind).

Uses beyond ML training:
- **Performance**: speed up a hot function/benchmark, shrink bundle size,
  cut memory — metric = benchmark output.
- **Quality**: raise coverage %, burn down lint/type-error count.
- **Cost**: minimize token spend of a routine's prompt while holding its
  rubric score (prompt golf).
- **Self-optimization (the factory improves itself)**: the versioned prompts
  (§3.8) are the factory's `program.md`. An experiment routine mutates a
  reviewer/planner prompt, replays it against a frozen benchmark set of past
  tasks (recorded threads + known-good verdicts), metric = agreement/success
  rate. The leaderboard data becomes training signal for the org code.

Hard rules inherited:
- **Eval harness immutable & outside the agent's write scope** — enforce via
  worktree path permissions; an agent that can edit the eval can game it.
- **Fixed iteration budget** — comparability + predictable throughput.
- **One metric per experiment routine** — no multi-objective mush; secondary
  constraints (e.g. VRAM/memory) are soft caps, logged not optimized.
- **Simplicity criterion** in every experiment prompt: deletion wins, no
  hacky-complexity-for-epsilon trades.

## 3.12 Hardening revisions (Codex adversarial review, round 1 — accepted 2026-06-10)

These amendments OVERRIDE earlier sections where they conflict.

### Security & trust boundary (overrides §3, §3.8, §3.11 details)
1. **Auto-merge is NOT in V1.** V1 ships PR creation + human merge. Auto-merge
   unlocks in V1.5 only after: branch protection + CI status verification +
   budgets + circuit breakers + verdict audit trail are live.
2. **Forge credentials live in a host-side forge service only.** A dedicated
   control-plane process owns push/PR/merge via GitHub token (later GitHub
   App). Agent runtimes get a worktree whose remote has NO credentials and an
   environment with NO `gh` auth. Pushing happens by the host from the
   worktree after the run.
3. **Per-run ephemeral HOME in V1** (bwrap-lite, not full containers): each
   agent run gets a minimal `$HOME` with only that provider's auth material
   copied/linked in (provider-level lock when shared state is unavoidable),
   tmpdir, and the worktree. Prevents cross-run mutation of `~/.claude`,
   `~/.codex`, SSH/git config, and agent reads of other repos. Full container
   + network policy remains V3.
4. **Prompt-injection scope widened**: ALL externally-influenced content —
   repo files, diffs, issue/PR text, comments, logs, AGENTS.md — is quoted
   data, never instructions; system prompts isolated from it; an injection
   test suite (hostile files/comments) is part of the review-harness tests.
5. **Break-glass requires**: allowlisted maintainer identity + exact command
   syntax + pinned fresh PR head SHA + immutable audit event. Not just a
   comment string.
6. **Triggers (webhook/chat) get authz**: per-repo allowlist, dedupe keys,
   rate limits, and a "dry-run pending approval" default for external
   sources.
7. **Secrets**: OS keyring/KMS where available; honest threat model
   documented (same-VM root compromise = plaintext regardless); audit events
   never contain secret values.
8. **Experiment eval runs OUTSIDE the agent workspace**: locked harness with
   read-only checkout of the agent's commit + explicit writable output dir.
   Worktree path permissions alone don't stop a shell-capable agent.

### Correctness & data model (overrides §3.3/§3.4 sketches)
9. **One reconciled state machine** for task/run/review/PR written BEFORE
   coding (V1 step 0 artifact); all transitions enforced via guarded SQL
   (`UPDATE … WHERE state='X'`), atomic task claiming with unique
   active-run-per-task constraint + per-worktree lock.
10. **Thread = append-only event stream**, not a message table sketch:
    `(task_id, seq, kind, actor, round, idempotency_key, payload,
    artifact_refs)`; review findings stored with commit SHA + file path
    (old/new) + patch hunk context + resolution state per round — survives
    force-pushes and line drift (this is what makes delta re-review real).
11. **SQLite discipline specified**: single writer queue (or short explicit
    transactions) + `busy_timeout` + WAL checkpoint strategy + SQLITE_BUSY
    retry policy — Bun under parallel agents.
12. **Branch freshness gate**: rebase/merge-base validation immediately
    before push, review, and merge; gates re-run after updating from target.
13. **Provider capabilities are proven, not declared**: a conformance test
    suite per driver (resume works? structured output extractable? cost
    reported?) gates what the router may use. Reality check: sandcastle's
    usage parsing is Claude-Code-only today; structured output is XML-tag
    extraction over stdout — so CLI verdicts get a retryable schema-repair
    wrapper and are untrusted until validated.
14. **Subscription lanes are opaque capacity pools**: no pretend quota API —
    driven by observed 429/auth-limit errors, operator-configured cooldowns
    and concurrency caps. (Replaces the speculative "tracks usage windows"
    wording in §3.9.)
15. **Budgets**: hard wall-clock/process budgets are universal and enforced;
    token/$ caps are advisory unless the provider has proven cost telemetry
    (cost rows keep the `priced` flag).
16. **Transcript browser promises observable events only** (normalized
    provider event envelope); no "thinking" claims for CLIs that don't
    expose it.
17. **Context pack builder is deterministic and specified**: changed files +
    import/reference closure + owning tests + reviewer-requested expansion;
    never vibes-based file selection.
18. **Failback policy ≠ routing policy**: retry/failback (within vendor,
    same task) and role routing / subscription overflow (between tasks or at
    task start) are separate policies with an explicit allowed-transition
    table per failure class.

### Round-2 amendments (Codex review round 2 — accepted 2026-06-10)
22. **bwrap-lite is SPECIFIED, not vibes** (replaces the loose wording in
    §3.12.3): private mount namespace; explicit binds only — worktree (rw),
    per-task agent HOME (rw), provider auth dir (ro), private `/tmp`; no host
    `/home`, no SSH agent socket, cleaned env (allowlist); an automated test
    asserts these invariants on every release.
23. **Egress control in V1**: uid-scoped egress allowlist (nftables skuid
    match or HTTP(S) proxy) limited to the configured provider API endpoints
    + GitHub. Until egress control is active, **unattended runs on untrusted
    repos are disabled by default** — provider credentials are readable by
    the CLI process by necessity, so exfiltration is contained by network
    policy, not by pretending the agent can't read its own auth.
24. **Per-TASK agent HOME (not per-run)** resolves the session-resume
    conflict: all rounds of one task's ping-pong share one isolated HOME, so
    provider session files (`~/.claude/projects/...`) persist naturally
    across resumes; isolation is between tasks. A session-store service
    (export/import + cwd rewrite + `{provider, session_id}` locks, per
    ADR-0012) is the V2 path for cross-machine resume.
25. **Forge service distrusts the worktree**: pushes with explicit remote
    URL, `core.hooksPath` disabled, local git config ignored; validates
    branch/ref/base; secret-scans the outgoing diff; pushes only validated
    commits. Submodule/LFS pointer changes require explicit reviewer
    acknowledgment.
26. **Auto-merge preflight** (extends §3.12.1): programmatically verify
    branch protection/rulesets exist, required checks come from trusted
    check-run app IDs, head SHA is fresh, and the bot token has no bypass
    permissions — before every auto-merge, not just at setup.
27. **Provider-auth abuse limits in V1** (not V1.5): per-provider concurrency
    caps + per-run kill budgets (wall-clock/process) + a documented
    revocation/rotation procedure for each provider credential.
28. **Thread event retention/redaction**: secret-pattern redaction before
    persistence, payload classification, per-project retention/export
    controls. Transcripts contain code and terminal output; they are not
    forever-data by default.
29. **Dependencies unblock on merge-confirmed SHA only**: each task records
    its base SHA; dependents start from the confirmed merge commit, never
    from a PR branch that may change or close.
30. **Conformance tests for claude-code + codex land BEFORE build steps 2–3**
    (V1's own providers), not with the V1.5 matrix.
31. **Nightshift-specific threat model is a step-0 artifact** (multi-provider
    auth, agent capabilities, exfiltration paths). tank is precedent for
    tmux/lifecycle mechanics only — not for multi-provider credential
    isolation.

### Scope resequencing (overrides §3.8 and build order)
19. **Settings**: V1 = config file + env + READ-ONLY settings UI. The typed
    editable registry with 3 scopes + audit + hot reload arrives in V1.5.
    (UI-editable everything stays the goal — just not the skeleton.)
20. **Task/dependency schema (incl. acceptance criteria fields) lands in the
    V1 skeleton** even though planner automation ships in step 4.
21. **Design**: V1 locks essential tokens + app shell only; full design
    polish passes and the design-review judge follow the working core loop.

## 4. Suggested build order (tracer bullets)
0. **State machine + schema spec + threat model** (§3.12.9–10, §3.12.31):
   task/run/review/PR transition graph (incl. base-SHA tracking §3.12.29),
   thread event-stream schema (incl. redaction/retention §3.12.28),
   task/dependency schema, multi-provider auth threat model — written and
   reviewed before code.
1. **Skeleton:** API + SQLite (WAL + writer discipline §3.12.11) + event log
   + minimal kanban UI; manual task CRUD. **Essential design tokens + app
   shell** (§3.8, trimmed per §3.12.21). Config file + read-only settings UI
   (§3.12.19).
2. **One coder path:** conformance tests for claude-code/codex first
   (§3.12.30) → task → worktree (locked, §3.6) → per-task isolated HOME in
   specified bwrap-lite + egress allowlist (§3.12.22–24) → Claude Code CLI
   in tmux → commit → host-side forge service (worktree-distrusting,
   §3.12.25) pushes + opens PR. Provider concurrency caps + kill budgets
   (§3.12.27). Live terminal attach.
3. **Review path:** single reviewer agent (Codex CLI) on the PR diff →
   structured verdict (schema-repair wrapper, §3.12.13) → **human merge**
   (auto-merge deferred to V1.5, §3.12.1) or send back. **Task thread +
   ping-pong loop (§3.3)** — anchored findings (§3.12.10), session resume,
   max-K rounds, needs-human escalation. **+ CI/test gate + branch freshness
   gate (§3.12.12)** before the PR opens.
4. **Planner:** plan text → task breakdown with dependencies → backlog.
   **+ To-Do intake** (promote item → task).
5. **Scale out (V1.5):** **auto-merge unlock** (branch protection + CI
   verification + verdict audit, §3.12.1), editable scoped settings registry
   (§3.12.19), parallel slots (atomic claiming §3.12.9), full provider
   matrix (§3.9 + conformance tests §3.12.13), **subscription capacity
   pools** (§3.12.14), risk tiers + specialist reviewers + coordinator
   (§3.4), circuit breakers (policy split §3.12.18), wall-clock budgets &
   kill-switch (§3.12.15), transcript browser (events-only §3.12.16),
   notifier w/ Telegram channel, auth health panel, **routines + unified
   triggers (manual/cron, authz §3.12.6)**, failure auto-triage,
   Docker/systemd deploy script.
6. **V2:** webhook + chat triggers (same trigger abstraction), Playwright
   verification (opt-in), per-project agent memory, AGENTS.md
   auto-maintenance, analytics dashboard + model routing by evidence,
   Slack/email notifier channels + standup digest, spec-first tasks + plan
   review, rubric judge plug-in (same verdict-loop engine), design review
   judge plug-in, **experiment routines (§3.11)** with ledger + metric chart
   (prompt self-optimization variant in V3).
7. **V3:** container sandbox per run, multi-VM workers, CLI auto-update,
   Forgejo/GitLab forge providers, preview environments, CMA provider
   plugin, tournament experiment flag, three-model tiebreaker.

## 5. Decisions (FINAL — confirmed by owner, 2026-06-10)
- **Name:** **Nightshift**.
- **Stack:** **TypeScript + Bun + SQLite** (WAL); sandcastle embedded as the
  agent-orchestration library; Postgres optional later (warren R-13 pattern).
- **Sandboxing V1:** git worktree + non-root service user (tank-style);
  container isolation per run is V3.
- **UI:** React kanban (localforge components) on the §3.8 design system.
- **Forge V1:** **GitHub** (gh CLI / REST); Forgejo/GitLab as V3 plugins.
- **Validation gate:** blueprint passes adversarial /codex-review before the
  first line of implementation code.
