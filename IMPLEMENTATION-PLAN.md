# Nightshift — Implementation Plan

Status: 2026-06-10. Blueprint APPROVED (3-round Codex review). Step 0 done.
**Resume point: Phase 1, task 1.5.** Specs that bind every task below:
`docs/BLUEPRINT.md` (§3.12 overrides), `docs/SPEC-STATE-MACHINES.md`,
`docs/SPEC-SCHEMA.md`, `docs/THREAT-MODEL.md`, `REUSE.md`.

Legend: each task has → verify criterion. Don't advance a phase until its
gate passes. ☐ open ☑ done

---

## Phase 0 — Specs & repo (DONE ☑ 2026-06-10)
☑ State machines, schema, threat model written
☑ sandcastle vendored; warren/tank/localforge code copied (REUSE.md)
☑ Repo initialized, commit 4f0a1b1
☐ **GATE: owner reads the 3 specs and says go** ← pending

## Phase 1 — Skeleton (control plane core)
1.1 ☑ Bun project wiring: tsconfig, Drizzle, `bun:sqlite` with WAL +
    busy_timeout + writer queue (SPEC-SCHEMA "SQLite discipline")
    → verify: parallel-write stress test passes, no SQLITE_BUSY surfaced.
1.2 ☑ Schema migration 0001 from SPEC-SCHEMA (all 13 tables + indexes +
    partial unique `one_active_run_per_task`)
    → verify: migration applies clean; invariant tests for unique/FK rules.
1.3 ☑ Global event log + broker: adapt `reference/warren/events.ts`
    (write-through DB → publish; subscribe→replay→tail with seq dedup;
    bounded buffers drop-oldest)
    → verify: gap-free stream test under concurrent writes.
1.4 ☑ HTTP API skeleton (Bun.serve, route table, bearer auth w/
    constant-time compare, /healthz /readyz /version)
    → verify: openapi-ish route list generated; auth rejects bad tokens.
1.5 ☐ Task CRUD + state machine enforcement (guarded SQL transitions from
    SPEC-STATE-MACHINES §6) + dependency table with BFS cycle check
    (port from `ui-reference/features.ts`)
    → verify: illegal-transition test matrix (every from→to pair).
1.6 ☐ Design tokens (`design-tokens.json`: dark base, signal accent,
    status colors, type pair) + app shell (adapt `ui-reference/app-shell`)
    + minimal kanban board (adapt `ui-reference/kanban`) reading live SSE
    from the event stream
    → verify: board renders tasks, drag-drop persists, restyled (no
    localforge look), SSE updates live.
1.7 ☐ Config file + env loader + read-only Settings page (§3.12.19)
    → verify: every knob in config renders in UI read-only.
**GATE 1:** create/move tasks in UI, events stream live, state machine
holds under concurrent API hammering.

## Phase 2 — One coder path (Claude Code end-to-end)
2.1 ☐ Provider conformance test harness + claude-code & codex conformance
    suites (§3.12.30): resume works, structured output extractable,
    cost reported? Results written to providers.capabilities_json
    → verify: suites run in CI; router refuses unproven capabilities.
2.2 ☐ Worktree service: sandcastle worktree create/reuse/lock + crypto-random
    temp-branch suffix patch (BLUEPRINT §3.6 known gap)
    → verify: parallel-claim test — no branch collisions, lock contention
    fails fast.
2.3 ☐ bwrap-lite sandbox profile (§3.12.22): private mount ns, binds
    (worktree rw, per-TASK HOME rw, provider auth ro, private /tmp), env
    allowlist + **invariant test that FAILS CLOSED** (spawning disabled on
    failure)
    → verify: invariant test asserts no host /home, no SSH agent, only
    declared binds.
2.4 ☐ Egress allowlist (uid-scoped nftables or proxy) for provider APIs +
    GitHub (§3.12.23); flag `unattended_untrusted_repos=false` until active
    → verify: agent process cannot curl a non-allowlisted host.
2.5 ☐ Run service: spawn claude-code in tmux (prompt-via-file trick §3.7.3),
    lifecycle hook bridge (adapt `ops/reference/hook.sh` → POST
    /runs/:id/events), Run state machine incl. interim-Stop /
    background_waiting, watchdog with transcript inspection, reap order
    (kill tmux → pkill → 400ms → fs/db)
    → verify: scripted task completes; kill/crash/orphan reconciliation
    tests pass; live xterm.js attach works.
2.6 ☐ Forge service (host-side, worktree-distrusting §3.12.25): explicit
    remote URL, hooks disabled, config ignored, ref validation, secret-scan
    diff, push + open PR via GitHub REST; agent env has zero gh auth
    → verify: PR opens from a real task; secret-scan blocks a planted key;
    agent worktree `git push` fails (no creds).
2.7 ☐ CI gate + branch-freshness gate before PR (§3.12.12)
    → verify: stale-base task gets rebased or blocked; red tests block PR.
**GATE 2:** "fix typo in README" task goes task→coding→PR fully
autonomously; human merges; dependents unblock on merge_sha.

## Phase 3 — Review path (the ping-pong)
3.1 ☐ Thread service: append-only thread_events with seq + idempotency keys;
    redaction pass before persist (§3.12.28)
    → verify: replay-safe under duplicate hook delivery; secrets redacted.
3.2 ☐ Verdict-loop engine (ONE engine, pluggable judge §3.10.1): reviewer
    run (codex CLI) on PR diff → structured verdict via XML-tag extraction +
    schema-repair wrapper (§3.12.13) → findings stored anchored (SHA +
    hunk context §3.12.10)
    → verify: malformed verdict triggers repair then needs_human, never
    default-approve (fail-closed test).
3.3 ☐ Ping-pong rounds: revise → same coder session resumed (per-task HOME
    keeps session files §3.12.24) → delta re-review (prior findings +
    resolution states + new diff only); rebuttals; max-K → needs_human
    → verify: scripted 3-round task converges; deadlock escalates with
    both positions rendered in thread UI.
3.4 ☐ Prompt-injection hygiene + test suite (§3.12.4): hostile diff/comment
    fixtures must not flip verdicts
    → verify: injection suite green; suite runs in CI.
3.5 ☐ Task detail UI: thread + live terminal + diff + verdict panel.
**GATE 3:** end-to-end: task → code → PR → cross-model review → revise
round → approved → human merge. **This is the V1 demo.**

## Phase 4 — Planner + intake
4.1 ☐ Planner agent (API driver, structured output): plan text → tasks with
    dependencies + acceptance criteria → backlog
4.2 ☐ Draft lane (To-Do as task state §3.10.2) + promote flow
4.3 ☐ Project bootstrap chat (adapt localforge bootstrapper pattern)
**GATE 4 = V1 COMPLETE:** paste a plan, watch tasks get coded, reviewed,
PR'd; merge by hand.

## Phase 5 — V1.5 (scale & unlock)
5.1 ☐ Auto-merge unlock behind preflight (§3.12.26) — verify protections,
    trusted check apps, fresh SHA, no bypass perms, every time
5.2 ☐ Editable scoped settings registry + audit events (§3.12.19)
5.3 ☐ Parallel slots: atomic claiming, slot-filling scheduler (§3.7.1)
5.4 ☐ Provider matrix: gemini-cli, antigravity, opencode CLI drivers +
    openrouter/local API drivers — each behind conformance tests
5.5 ☐ Subscription capacity pools (§3.12.14): observed 429/auth signals,
    cooldowns, concurrency caps; overflow policy subscription→api_key
5.6 ☐ Risk tiers + specialist reviewers + coordinator (§3.4); circuit
    breakers with failback-vs-routing policy split (§3.12.18)
5.7 ☐ Budgets: hard wall-clock universal, token/$ advisory where priced
5.8 ☐ Transcript browser (events-only); notifier + Telegram channel;
    auth health panel; routines + manual/cron triggers w/ authz
5.9 ☐ Failure auto-triage (haiku-class classifier → retry/reassign/human)
5.10 ☐ deploy.sh + systemd (adapt ops/reference) → Linux VM install
**GATE 5:** factory runs unattended overnight on a trusted repo; morning
digest shows merged PRs.

## Phase 6 — V2 (listed; spec in BLUEPRINT §4 step 6)
Webhook/chat triggers, Playwright verification (opt-in), per-project agent
memory, AGENTS.md auto-maintenance, analytics + evidence-based routing,
Slack/email channels + standup digest, spec-first + plan review, rubric &
design-review judge plug-ins, experiment routines + ledger UI (§3.11).

## Phase 7 — V3
Container isolation per run, multi-VM workers, CLI auto-update,
Forgejo/GitLab plugins, preview environments, CMA provider plugin,
tournament flag, prompt self-optimization.

---

## How to resume a session (for the operator)
1. Open Claude Code in `…/SOFTWARE FACTORY/nightshift/`.
2. Say: **"Прочети IMPLEMENTATION-PLAN.md и продължи от първия незавършен
   таск"** (or name a phase/task).
3. Everything needed is in-repo: BLUEPRINT (§3.12 binding), the 3 specs,
   REUSE.md, this plan. Mark tasks ☑ + commit as they complete.
