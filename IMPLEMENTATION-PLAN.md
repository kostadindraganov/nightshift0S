# Nightshift — Implementation Plan

Status: 2026-06-10. Blueprint APPROVED (3-round Codex review). Step 0 done.
**Resume point: live GATE 2 on the Linux deploy host.** Phase 1 done (GATE 1 ✓);
Phase 2 services 2.1–2.7 + the GATE 2 orchestrator all built & logic-tested on
macOS (356 tests). What remains is RUNTIME/NETWORK verification on the Linux
host + live GitHub: stand up the live launcher/forge/CI clients and run the
"fix typo" task end-to-end (real claude-code spawn → push → PR → human merge →
dependents unblock). Also pending: 2.4 nftables enforcement, 2.6 live push/PR,
2.7 live CI fetch, and the **xterm.js live-attach UI** (not built).
Specs that bind every task below:
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
1.5 ☑ Task CRUD + state machine enforcement (guarded SQL transitions from
    SPEC-STATE-MACHINES §6) + dependency table with BFS cycle check
    (port from `ui-reference/features.ts`)
    → verify: illegal-transition test matrix (every from→to pair).
1.6 ☑ Design tokens (`web/design-tokens.json` + `web/styles/tokens.css`) +
    Bun-fullstack React app shell (`web/`) + minimal kanban board reading
    live SSE from the event stream (drag-drop enforces the transition law).
    → verify: ☑ board renders tasks, drag-drop persists via transition/PATCH
    API, restyled (ClickHouse dark+yellow tokens, no localforge look), SSE
    updates live (fetch+ReadableStream, bearer-auth'd).
1.7 ☑ Config file + env loader (`src/config/config.ts`, file<-env merge) +
    read-only Settings page (GET /config → `describeConfig`, §3.12.19)
    → verify: ☑ all 21 config knobs render read-only in the UI with
    value/source/scope; secrets masked.
**GATE 1 ☑ (2026-06-10):** create/move tasks in UI, events stream live,
state machine holds under concurrent API hammering — verified by
`src/server/gate1.test.ts` (20-way concurrent transition: exactly 1 wins,
events.seq gap-free; SSE delivers task.state_changed; / serves the SPA).
Typecheck clean; 70/70 tests pass.

## Phase 2 — One coder path (Claude Code end-to-end)
2.1 ☑ Provider conformance test harness + claude-code & codex conformance
    suites (§3.12.30): resume works, structured output extractable (XML-tag +
    schema-repair, fail-closed), cost reported? Results → providers
    .capabilities_json. `src/providers/` {types, schemaRepair, conformance,
    router, claudeCode, codex}.
    → verify: ☑ 31/31 — router REFUSES unproven caps (reviewer needs
    structured_output); capabilities_json round-trips; fake-driver matrix.
    Live claude/codex CLI probes run when the binaries are present.
2.2 ☑ Worktree service (native plain-Promise port of sandcastle's
    WorktreeManager — its internals aren't publicly exported & are Effect-
    based; see REUSE.md): create/reuse/lock + crypto-random suffix, ff-only
    reuse (never reset --hard), ADR-0004 no auto-teardown. `src/worktree/`.
    → verify: ☑ 18/18 on REAL git — parallel-claim (10×, distinct branches),
    lock contention fails fast (WorktreeLockError), reuse/dirty-preserve/prune.
2.3 ☑ bwrap-lite sandbox profile (§3.12.22): private mount ns, binds
    (worktree rw, per-TASK HOME rw, provider auth ro, private /tmp), env
    allowlist + **invariant test that FAILS CLOSED** (spawn disabled on
    failure OR when bwrap absent). `src/sandbox/` {profile, invariants, spawn}.
    → verify: ☑ 27/27 — invariant test asserts no host /home, no SSH agent,
    only declared binds; spawnSandboxed throws (no child) when bwrap absent.
    NOTE: live bwrap namespace isolation is Linux-runtime, verified at deploy.
2.4 ◑ Egress allowlist (uid-scoped nftables or proxy) for provider APIs +
    GitHub (§3.12.23); flag `unattended_untrusted_repos=false` until active.
    `src/egress/` {allowlist (ruleset gen, default-DROP), guard (refuse-gate)}.
    → CODE-COMPLETE: 26/26 — ruleset default-drop + skuid scoping +
    refuse-unattended gate tested. RUNTIME VERIFY ("agent cannot curl a
    non-allowlisted host") is Linux/nftables — PENDING deploy.
2.5 ☑ Run service (`src/runs/`): Run state machine (transitions.ts, guarded
    SQL, 1:1 SPEC §2 — incl. interim-Stop/background_waiting; boot-reconcile
    edges broadened to any non-terminal→interrupted per §2 prose), spawn in
    tmux via injectable Launcher + prompt-via-file (spawn.ts/launcher.ts),
    lifecycle hook bridge POST /runs/:id/events + ops/hook.sh (hookBridge.ts/
    runRoutes.ts), watchdog ADR-0019 (watchdog.ts), reap order + boot
    reconciliation (reap.ts).
    → verify: ☑ scripted task completes (engine.e2e), kill/crash/orphan
    reconciliation tests pass (260 tests, scripted agent / real git).
    PENDING (deploy host/browser): live claude/codex spawn under real tmux;
    **live xterm.js attach** (not built). NOTE: 1 low-freq flaky test in the
    real-git/tmux suites to harden.
2.6 ◑ Forge service (`src/forge/`, host-side, worktree-distrusting §3.12.25):
    worktree-distrust push builder (explicit remote, core.hooksPath=/dev/null,
    --no-verify, local/global config nulled), ref validation, secret-scan diff
    (10 rule classes, added-lines only), submodule/LFS ack, PR via GitHub REST
    behind an injectable ForgeClient; prepareAndOpenPR 5-gate pipeline.
    → verify: ☑ secret-scan BLOCKS a planted key (and blocks push+PR, no calls);
    ☑ distrust flags asserted; agent env carries zero gh auth (host-side design).
    DEPLOY-PENDING: live push + "PR opens from a real task" (need real remote +
    host GITHUB_TOKEN).
2.7 ◑ CI gate + branch-freshness gate before PR (`src/gate/`, §3.12.12):
    checkBranchFreshness (fresh/rebase/block via merge-base on real git),
    pure ciGate (required checks green) behind an injectable CiClient, prePrGate.
    → verify: ☑ stale-base → rebase/block correct on real git; ☑ red/pending/
    missing checks block, all-green passes. DEPLOY-PENDING: live CI status fetch
    (GitHub Checks API).
**GATE 2 ◑ (integration built & tested, 2026-06-11):** the autonomous coder
loop is WIRED — `src/orchestrator/coder.ts`: `completeCoderRun` (run succeeded
→ branch-freshness + CI gate → forge secret-scan/push/PR → task coding→review;
ANY block → coding→needs_human, a NEW state-machine edge added here) +
`confirmMergeAndUnblock` (merging→done(+merge_sha) → dependents unblock via
recomputeReadiness). The transition API also recomputes readiness on →done.
Verified on macOS with a scripted agent + injected fakes (forge/CI/pusher) +
real git: orchestrator branches (review / needs_human / failed) and dependent
unblock (356 tests). DEPLOY-PENDING: the fully-live "fix typo" run (real
claude-code spawn + real GitHub push/PR + human merge) on the Linux host.

## Phase 3 — Review path (the ping-pong)
3.1 ☑ Thread service: append-only thread_events with seq + idempotency keys;
    redaction pass before persist (§3.12.28)
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
3.2 ☑ Verdict-loop engine (ONE engine, pluggable judge §3.10.1): reviewer
    run (codex CLI) on PR diff → structured verdict via XML-tag extraction +
    schema-repair wrapper (§3.12.13) → findings stored anchored (SHA +
    hunk context §3.12.10)
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
3.3 ☑ Ping-pong rounds: revise → same coder session resumed (per-task HOME
    keeps session files §3.12.24) → delta re-review (prior findings +
    resolution states + new diff only); rebuttals; max-K → needs_human
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
3.4 ☑ Prompt-injection hygiene + test suite (§3.12.4): hostile diff/comment
    fixtures must not flip verdicts
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
3.5 ☑ Task detail UI: thread + live terminal + diff + verdict panel.
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
**GATE 3 ◑ (review path built, 2026-06-12):** the ping-pong loop is wired —
thread service (`src/thread/`), verdict engine (`src/review/{judge,engine,verdict}`),
findings anchoring, resolution lifecycle, injection-safe prompt rendering, and task
detail UI (TaskDetailView + ThreadView + VerdictPanel + FindingsPanel). Verified on
macOS with scripted review runs + injected fakes (judge): 385 tests pass. DEPLOY-PENDING:
live reviewer-CLI spawn under tmux (Codex/Gemini reviewer invoke), xterm.js live-attach
UI (WebSocket terminal stream), live PR diff fetch on the Linux host.

## Phase 4 — Planner + intake
4.1 ☑ Planner agent (API driver, structured output): plan text → tasks with
    dependencies + acceptance criteria → backlog
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
4.2 ☑ Draft lane (To-Do as task state §3.10.2) + promote flow
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
4.3 ☑ Project bootstrap (structured planner call, fail-closed task creation)
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
**GATE 4 ◑ (partial; intake & planner wired, 2026-06-12):** planner (`src/planner/`),
draft lane (DraftColumn + promote API), bootstrap (bootstrap.ts). Verified on macOS
with scripted planner + injected fakes: 385 tests pass. REMAINING for V1 complete:
live planner-agent spawn (Codex/Gemini task-planning CLI invoke), project bootstrap
chat UI (intake modal or dedicated view).

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
