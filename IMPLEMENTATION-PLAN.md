# Nightshift — Implementation Plan

Status: 2026-06-13 (origin/main @ a7d4b76 + uncommitted Phase-5-finish wave). Blueprint
APPROVED. Step 0 done.
**Resume point: live runtime-verify on the Linux deploy host (GATE 5). ALL Phase 5
tasks are now built & logic-tested on macOS.**
Phases 0–4 DONE on macOS (GATE 1 ✓; GATE 2/3/4 ◑ = built & logic-tested with
scripted agents/injected fakes + real git/DB). Phase 5: **5.1–5.9 done** (5.2 / 5.6 /
5.8 closed this wave) + 5.10 code-complete. The whole
live/Linux wiring is CODE-COMPLETE: real reviewer/coder/planner spawn
(`src/runs/liveSpawn.ts`, coder `--resume`), host-side GitHub forge+CI clients
(`src/forge/githubForgeClient.ts`, `src/gate/githubCiClient.ts`,
`src/orchestrator/prodDeps.ts`), auto-merge preflight (`src/forge/preflight.ts`),
egress apply (`src/egress/apply.ts` + `ops/egress-*.sh`), xterm.js terminal
(`src/server/terminalRoutes.ts` + `web/components/terminal/`), and deploy
(`ops/deploy.sh` + `ops/nightshift.service`). **782 tests pass; typecheck clean.**
NOTE: run the suite with `bun run test` (the curated dir list) — bare `bun test`
discovers vendored/e2e files that HANG. What REMAINS is RUNTIME/NETWORK verification
on Linux + live GitHub — run the "fix typo" task end-to-end per **`docs/LINUX-DEPLOY.md`**
(real spawn → push → PR → review → human merge → dependents unblock) plus
nftables/bwrap activation, plus boot-wiring the cron/notifier timers in main.ts.
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
    (2026-06-13: fixed the 400-vs-409 code — an illegal edge to `done` now
    returns 409 illegal_transition; the merge_sha guard fires AFTER legality.)
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
    → CODE-COMPLETE — Linux runtime-verify pending: ruleset default-drop + skuid scoping +
    refuse-unattended gate tested; live nftables enforcement ("agent cannot curl a
    non-allowlisted host") requires ops/egress-apply.sh + Linux host.
2.5 ◑ Run service (`src/runs/`): Run state machine (transitions.ts, guarded
    SQL, 1:1 SPEC §2 — incl. interim-Stop/background_waiting; boot-reconcile
    edges broadened to any non-terminal→interrupted per §2 prose), spawn in
    tmux via injectable Launcher + prompt-via-file (spawn.ts/launcher.ts),
    lifecycle hook bridge POST /runs/:id/events + ops/hook.sh (hookBridge.ts/
    runRoutes.ts), watchdog ADR-0019 (watchdog.ts), reap order + boot
    reconciliation (reap.ts).
    → CODE-COMPLETE — Linux runtime-verify pending: ☑ scripted task completes;
    ☑ kill/crash/orphan reconciliation passes. Live claude-code spawn, session
    `--resume` wiring (`liveSpawn.ts`), and xterm.js live-attach terminal
    (`terminalRoutes.ts`) are now WIRED — only real-tmux/browser verification on
    the Linux host remains. NOTE: the low-freq flaky test (crypto-random suffix
    collision) was FIXED 2026-06-13 (suffix entropy 24→64 bits).
2.6 ◑ Forge service (`src/forge/`, host-side, worktree-distrusting §3.12.25):
    worktree-distrust push builder (explicit remote, core.hooksPath=/dev/null,
    --no-verify, local/global config nulled), ref validation, secret-scan diff
    (10 rule classes, added-lines only), submodule/LFS ack, PR via GitHub REST
    behind an injectable ForgeClient; prepareAndOpenPR 5-gate pipeline.
    → CODE-COMPLETE — Linux runtime-verify pending: ☑ secret-scan BLOCKS planted key;
    ☑ distrust flags asserted; agent env carries zero gh auth. Live push + PR opens
    requires ops/deploy.sh + real GITHUB_TOKEN + Linux host.
2.7 ◑ CI gate + branch-freshness gate before PR (`src/gate/`, §3.12.12):
    checkBranchFreshness (fresh/rebase/block via merge-base on real git),
    pure ciGate (required checks green) behind an injectable CiClient, prePrGate.
    → CODE-COMPLETE — Linux runtime-verify pending: ☑ stale-base → rebase/block correct;
    ☑ red/pending/missing checks block, all-green passes. Live CI status fetch
    (GitHub Checks API) requires ops/deploy.sh + GITHUB_TOKEN + Linux host.
**GATE 2 ◑ (integration built & tested, 2026-06-11):** the autonomous coder
loop is WIRED — `src/orchestrator/coder.ts`: `completeCoderRun` (run succeeded
→ branch-freshness + CI gate → forge secret-scan/push/PR → task coding→review;
ANY block → coding→needs_human, a NEW state-machine edge added here) +
`confirmMergeAndUnblock` (merging→done(+merge_sha) → dependents unblock via
recomputeReadiness). The transition API also recomputes readiness on →done.
Verified on macOS with a scripted agent + injected fakes (forge/CI/pusher) +
real git: orchestrator branches (review / needs_human / failed) and dependent
unblock (408 tests). CODE-COMPLETE — Linux runtime-verify pending: the fully-live
"fix typo" run (real claude-code spawn + real GitHub push/PR + human merge)
requires ops/deploy.sh + GITHUB_TOKEN + Linux host.

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
macOS with scripted review runs + injected fakes (judge): 385 tests pass. CODE-COMPLETE
since the live-wiring pass (`liveSpawn.ts` reviewer spawn, `terminalRoutes.ts` xterm.js
WebSocket stream, live PR diff fetch) — RUNTIME-VERIFY pending on the Linux host:
real Codex/Gemini reviewer-CLI under tmux + browser xterm attach.

## Phase 4 — Planner + intake
4.1 ☑ Planner agent (API driver, structured output): plan text → tasks with
    dependencies + acceptance criteria → backlog
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
4.2 ☑ Draft lane (To-Do as task state §3.10.2) + promote flow
    → verify: ☑ built & logic-tested on macOS (scripted reviewer/fakes)
4.3 ☑ Project bootstrap (structured planner call, fail-closed task creation)
    + intake UI (`web/views/IntakeView.tsx`: pick/create project, paste a plan,
    planner expands → backlog; wired into nav as "Intake")
    → verify: ☑ built & logic-tested on macOS; typecheck clean, frontend bundles,
    385 tests pass.
**GATE 4 ◑→✅ on macOS (2026-06-12):** planner (`src/planner/`), draft lane
(DraftColumn + promote API), bootstrap (bootstrap.ts) + intake view. "Paste a plan
→ backlog" works end-to-end with a scripted planner + injected fakes: 385 tests pass.
REMAINING for live V1: live planner-agent spawn (Codex/Gemini task-planning CLI invoke).

## Phase 5 — V1.5 (scale & unlock)
5.1 ☑ Auto-merge unlock behind preflight (§3.12.26) — verify protections,
    trusted check apps, fresh SHA, no bypass perms, every time
    → built & logic-tested on macOS (fakes/injected clients); live merge + live
    CLI/endpoint probes on Linux/real-GitHub = GATE 5
5.2 ☑ Editable scoped settings registry + audit events (§3.12.19)
    → typed REGISTRY of editable knobs (3 scopes global/project/routine),
    fail-closed putSetting (unknown_key/wrong_scope/scope_id_required/invalid_value),
    upsert-by-select for global nulls, resolveEffectiveConfig layering
    (default<file<env<db:global<db:project<db:routine) with provenance, audit via
    global events (`settings.updated`/`.reverted`, NEVER secret values), editable UI
    + auth-health panel + audit trail. `src/config/registry.ts` + registryRoutes
    (GET/PUT/DELETE /settings, /settings/registry, /settings/audit). 27 tests.
5.3 ☑ Parallel slots: atomic claiming, slot-filling scheduler (§3.7.1)
    → built & logic-tested on macOS (fakes); unattended-live on Linux = GATE 5
5.4 ☑ Provider matrix: gemini-cli, antigravity, opencode CLI drivers +
    openrouter/local API drivers — each behind conformance tests
    → built & logic-tested on macOS (fakes/injected clients); live merge + live
    CLI/endpoint probes on Linux/real-GitHub = GATE 5
5.5 ☑ Subscription capacity pools (§3.12.14): observed 429/auth signals,
    cooldowns, concurrency caps; overflow policy subscription→api_key
    → built & logic-tested on macOS (fakes); unattended-live on Linux = GATE 5
5.6 ☑ Risk tiers + specialist reviewers + coordinator (§3.4); circuit
    breakers with failback-vs-routing policy split (§3.12.18)
    → §3.4 review harness as an ADDITIVE injectable pipeline (existing single-judge
    path untouched): `src/review/{riskTier,specialists,coordinator,harness}.ts` —
    noiseFilter (keeps migrations, drops lockfiles/minified/generated), risk tier
    (declaredTier floor + security-forces-full), 6 injection-safe specialist finders
    run IN PARALLEL (recall-first), coordinator dedup + adversarial-verify of
    low-confidence + approval-biased rubric, FAIL-CLOSED (all-finders-fail ⇒ never
    approve). `toVerdictShape` feeds the existing orchestrator unchanged. Failback ≠
    routing (§3.12.18): `src/providers/failback.ts` — classifyFailure, MODEL_FAMILIES,
    ALLOWED_TRANSITIONS table, within-vendor failback (never cross-vendor; auth/
    context_overflow/rate_limit ⇒ stop), routingDecision avoids prior failed providers.
    Circuit-breaker STATE stays owned by capacity.ts. 127 tests. (Security bugfix
    shipped: specialist prompts now sanitize against the finder's OWN extraction tag.)
    Live specialist spawn (deps.produceFinder) = Linux/GATE 5.
5.7 ☑ Budgets: hard wall-clock universal, token/$ advisory where priced
    → built & logic-tested on macOS (fakes); unattended-live on Linux = GATE 5
5.8 ☑ Transcript browser (events-only); notifier + Telegram channel;
    auth health panel; routines + manual/cron triggers w/ authz
    → transcript (§3.12.16): `src/runs/transcript.ts` normalized observable-events
    envelope merging events+thread_events per run/task (redacted rows stay redacted),
    GET /runs/:id/transcript + /tasks/:id/transcript. Notifier (§3.10 item 4):
    `src/notify/{notifier,telegram}.ts` — ONE interface, per-event-type routing,
    channel-failure isolation, tail-only event bridge; Telegram fail-closed when
    unconfigured (no HTTP, token NEVER in any reason/log), injected HttpSend.
    Auth health (§3.9): `src/providers/authHealth.ts` status derivation
    (healthy/degraded/cooling_down/circuit_open/disabled/unproven) + GET /providers/health
    + UI panel. Routines+triggers (§3.2/§3.12.6): `src/triggers/{routines,triggers,cron}.ts`
    — routine+trigger CRUD, standard 5-field cron evaluator, fireTrigger with authz
    (allowlist/rate-limit/dedupe/dry-run-pending for external sources), creates a
    backlog task w/ routineId provenance; startTriggerScheduler for cron. Routines UI
    view + "Fire now". 173 tests. Live cron/notifier boot wiring = main.ts (GATE 5).
5.9 ☑ Failure auto-triage (haiku-class classifier → retry/reassign/human)
    → built & logic-tested on macOS (fakes); unattended-live on Linux = GATE 5
5.10 ◑ deploy.sh + systemd (adapt ops/reference) → Linux VM install
    → CODE-COMPLETE: ops/deploy.sh (env setup, service install, launch),
    ops/nightshift.service (systemd unit), ops/egress-apply.sh + ops/egress-teardown.sh
    (nftables enforcement). Live deployment requires Linux host + GITHUB_TOKEN + test.
**GATE 5:** ALL V1.5 modules built (scheduler + capacity + budgets + triage + auto-merge +
provider matrix + settings registry + review harness/failback + transcript + notifier +
auth-health + routines/triggers; **782 tests pass** on macOS with injectable fakes;
typecheck clean). Factory unattended-live overnight on Linux host = pending: boot-wire the
live seams (resolveSpawn, produceFinder specialist spawn, cron/notifier timers in main.ts,
Telegram HttpSend), then verify the morning digest shows merged PRs.

## Phase 6 — V2 (spec in BLUEPRINT §4 step 6)
**Batch A DONE ☑ (2026-06-13, built & logic-tested on macOS; 916 tests, typecheck clean):**
6.A1 ☑ Rubric + design-review judge plug-ins (§3.10.1) — `rubricJudge` (grades an
    artifact against a routine rubric §3.5) + `designJudge` (UX/a11y review §3.8)
    implemented in `src/review/judge.ts`, injection-safe, fail-closed parse, same
    Verdict contract → plug straight into the existing `runVerdict` engine. 27 tests.
6.A2 ☑ Slack/email channels + standup digest (§3.10.4/§3.5) — `src/notify/{slack,
    email,digest}.ts`: two more channels behind the one notifier (fail-closed when
    unconfigured, secrets never in reasons), `buildStandupDigest` (done/failed/
    needs_human/merged/spend/flaky/topErrors) + scheduler. 21 tests.
6.A3 ☑ Webhook triggers (§3.12.6) — `src/triggers/{webhook,webhookRoutes}.ts`:
    HMAC-SHA256 constant-time verify + 7-gate fail-closed gauntlet (kind/authz/
    signature/dedupe/rate-limit → fireTrigger honoring dry-run); `POST /webhooks/:id`
    (auth via HMAC, not bearer). 32 tests. node:crypto, no new dep.
6.A4 ☑ Experiment routines + ledger (§3.11/§3.12.8) — `src/experiment/{ledger,
    engine}.ts`: hill-climbing loop (edit→commit→eval-under-budget→parse metric→
    keep/discard→ledger; NEVER-STOP; crash never advances the branch; eval runs on a
    READ-ONLY checkout OUTSIDE target_paths), `GET /runs/:id/experiment` timeline +
    metric series + best. 54 tests. Loop run + ledger UI = GATE 5 (needs agent spawn).

**Batch B DONE ☑ (2026-06-13, built & logic-tested on macOS; typecheck clean):**
6.B1 ☑ Per-project agent memory (§3 Memory & knowledge) — NEW `agent_memory` table
    (migration 0002, the 14th table) + `src/memory/{memory,memoryRoutes}.ts`:
    namespaced key-value upsert per project, fail-closed (project_not_found/invalid),
    audit events, secrets-not-stored. GET/PUT/DELETE /projects/:id/memory. 26 tests.
6.B2 ☑ Analytics + evidence-based routing (§3.7) — `src/analytics/{aggregate,routing}.ts`:
    per-provider success/cost/latency aggregates + factory overview + a deterministic
    evidence scorer (cold-start guarded) the scheduler MAY consult; GET /analytics. 30 tests.
6.B3 ☑ Chat triggers / Telegram inbound (§3.2/§3.12.6) — `src/triggers/{chat,chatRoutes}.ts`:
    POST /chat/telegram/:id (secret-token auth), allowlist/dedupe/rate-limit → fireTrigger
    (source=chat, honors dry-run); token never logged. 35 tests.
6.B4 ☑ AGENTS.md auto-maintenance (§3) — `src/maintenance/agentsMd.ts`: marker-delimited
    managed block (preserves hand-written prose), deterministic proposal from a repo
    snapshot, optional injected LLM refine; GET /projects/:id/agents-md/proposal. 36 tests.
6.B5 ☑ Playwright verification, opt-in (§3.10 item 8) — `src/verify/{browser,verifyGate}.ts`:
    opt-in-per-project gate (NEVER a default), injectable BrowserRunner + LAZY playwright
    adapter (fail-closed when absent — real browser install = GATE 5), fail-closed verdicts
    (unrunnable ⇒ fail, never pass). 11 tests.

**Phase 6 remaining ☐:** spec-first / plan-review flow; experiment ledger UI (timeline +
metric chart — ships when live experiment runs exist); real `playwright install` + live
browser verify (GATE 5); main.ts boot-wiring of the live V2 seams (channels/digest/experiment
loop, chat/webhook receivers, evidence-routing into resolveSpawn, live repo scan for AGENTS.md);
UI for memory/analytics/routines/transcript panels. These are GATE-5/runtime or UI polish.

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
