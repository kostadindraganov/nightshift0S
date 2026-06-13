# Nightshift — Implementation Plan

Status: 2026-06-14 — **DEPLOYED & LIVE-WIRED on the Debian/Proxmox host**, single git
branch `main` (master + ecc-tools consolidated/deleted). Blueprint APPROVED.
**1234 tests pass / 4 pre-existing bwrap-on-Linux fails; typecheck clean.** Run the
suite ONLY as `bun run test` (curated dirs) — bare `bun test` discovers vendored/e2e
files that HANG.

WHAT IS NOW LIVE (this 2026-06-14 wave, on top of the prior code-complete base):
- **Deploy (5.10 ☑):** systemd service live on the host; `/healthz`+`/readyz` ok; scheduler
  loop + all triggers/cadences boot cleanly (see GATE-5 worklist below).
- **The autonomous loop is wired end-to-end** in `main.ts onReady`: coder-completion trigger
  (run→succeeded ⇒ `completeCoderRun`), review-round trigger (task→review ⇒ `runReviewRound`,
  tournament-aware), evidence-routing wrap around `resolveSpawn` (6.D2), AGENTS.md cadence
  (6.B4/6.D4), CLI auto-update cadence (7.3), plus the V2 loops + auto-merge hook.
- **§3.4 specialist-harness review path (5.6)** selectable via `config.review.specialistHarness`.
- **Experiments (6.A4/6.D3)** end-to-end: `dispatchExperiment` + `makeLiveExperimentDeps`
  (§3.12.8 eval isolation) + `POST /routines/:id/experiment`.
- **Anti Gravity CLI (`agy`)** replaces the old `gemini` binary throughout.
- **Built+tested modules awaiting only runtime/architecture to wire:** tiebreaker live spawn
  (7.7), container-spawn selector (7.1).

WHAT REMAINS = runtime/infra/architecture only (NOT connectable code) — see the GATE-5
worklist at the end of Phase 8: nftables egress needs a SEPARATE agent uid (control plane
+ agents share uid 1000); container needs docker; tiebreaker needs a Verdict-level review
restructure; remote workers/preview/CMA/playwright/prompt-optimize need infra/keys/a
dispatcher; the "fix typo" e2e needs a dedicated target repo + an explicit go (outward-facing
push). Specs that bind every task below:
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
5.10 ☑ deploy.sh + systemd (adapt ops/reference) → Linux VM install
    → DEPLOYED 2026-06-14 on Proxmox Debian host: ops/deploy.sh (PATH bun-fix),
    ops/nightshift.service (PATH includes /usr/sbin for nft, /home/nightshift/.local/bin
    for claude + agy), NIGHTSHIFT_REPO_DIR wired, service live at :3000, /healthz + /readyz
    both {"ok":true}, scheduler loop confirmed started in journalctl.
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

**Batch C DONE ☑ (2026-06-13, built & logic-tested on macOS; typecheck clean):**
6.C1 ☑ Spec-first / plan-review flow (§3.10.1) — `src/review/planReviewJudge.ts` (the 4th
    judge plug-in: reviews a PLAN against acceptance criteria before coding, injection-safe,
    fail-closed, same Verdict contract) + `src/orchestrator/planReview.ts` (advisory
    verdict-loop round recording to the thread; injectable, never auto-approves). Minimal
    tests (4) per the owner's "fewer tests" directive.
6.C2 ☑ Analytics dashboard UI (§3.7) — `web/views/AnalyticsView.tsx` (factory overview +
    per-provider success/cost/latency table + routing scores), new "Analytics" nav item +
    `getAnalytics` api helper.
6.C3 ☑ main.ts V2 boot-wiring documented — the cron-trigger scheduler, notifier→channels
    bridge, and standup-digest poller are composed call-sites under `import.meta.main`
    (`void`-referenced, never inside createServer), ready for the operator to wire on Linux.

**Batch D DONE ☑ (2026-06-13, live-wiring CODE-COMPLETE on macOS; typecheck clean):**
6.D1 ☑ Notifier transports + V2 boot composer — `src/notify/transports.ts` (fetchHttpSend
    for Telegram/Slack; unconfiguredEmailSend fail-closed default) + `src/server/v2Boot.ts`
    `startV2Loops` (cron-trigger scheduler + env-built channels + event bridge + standup
    digest, each guarded/inert when unconfigured). **Now LIVE-wired in main.ts** via the new
    `createServer({onReady})` seam (runs only on `bun run dev`/Linux, never under test).
6.D2 ☑ Evidence-based routing closure — `src/orchestrator/evidenceRouting.ts`
    (chooseProviderByEvidence + makeEvidenceResolveSpawn wrapper, cold-start fail-safe,
    fail-closed to base plan). Wraps resolveSpawn on the Linux host.
6.D3 ☑ Experiment-run orchestration hook — `src/orchestrator/experimentRun.ts`
    (runExperimentForRun + makeFailClosedExperimentDeps; eval on read-only checkout §3.12.8).
6.D4 ☑ AGENTS.md host repo scanner — `src/maintenance/repoScan.ts` (scanRepoSnapshot, fail-soft).
6.D5 ☑ UI — `web/views/{AnalyticsView,MemoryView,ExperimentView}.tsx` + nav tabs (the §3.11
    experiment ledger timeline+chart "progress.png" view is now in the UI). 7 nav tabs total.

**Phase 6 remaining ☐ — GATE-5 only (physically not validatable on macOS):** real `playwright
install` + live browser verify; the live host closures the Linux VM supplies (resolveSpawn
repo→checkout mapping, real git/eval/agent for experiment runs, a live EmailSend transport);
optional transcript tab in TaskDetailView. Everything code-able on the dev host is built,
green, and wired; what is left needs the Linux runtime + real provider/GitHub/browser surfaces.

## Phase 7 — V3
**Forge plugins + tournament + transcript DONE ☑ (2026-06-13, commit 5675c4b):**
7.0 ☑ Transcript tab (TaskDetailView 4th tab), Forgejo + GitLab forge plugins
    (`src/forge/{forgejoForgeClient,gitlabForgeClient,forgeFactory}.ts`, dispatch on
    config.forge.provider), tournament mode (`src/review/tournament.ts` dual-reviewer
    synthesis behind config.tournament.enabled).

**V3 build DONE ☑ (2026-06-13, built & logic-tested on macOS; 1160 tests pass, typecheck
clean, frontend bundles). 8-agent fan-out (Sonnet/Opus/Haiku), ZERO migrations:**
7.1 ☑ Container isolation per run (§infra) — `src/sandbox/container.ts`: `buildContainerArgv`
    (network/mem/cpu limits, `--network none` default, NO host-env leak) + `makeContainerRunner`
    (FAIL-CLOSED off-Linux via `ContainerUnavailableError`). Opt-in level ABOVE worktree-only.
    6 tests. Run-spawn integration = GATE-5/runtime.
7.2 ☑ Multi-VM workers (§infra) — `src/scheduler/{workers,workersRoutes}.ts`: in-memory
    `WorkerRegistry` (register/heartbeat/list/reclaimStale, lease-based liveness — NO DB/migration)
    + GET/POST /workers, POST /workers/:id/heartbeat. 6 tests. Remote daemons + scheduler
    consumption = GATE-5.
7.3 ☑ CLI auto-update + version status (§infra) — `src/providers/{cliUpdate,cliUpdateRoutes}.ts`:
    `parseSemver`/`needsUpdate` (fail-soft) + `makeCliUpdater` (status/update, NEVER throws) +
    GET /providers/cli-status (sibling to authHealth). 6 tests. Live update exec = GATE-5.
7.4 ☑ Preview environments (§infra) — `src/preview/{preview,previewRoutes}.ts`: URL allocation
    (`run-<id>.<domain>`, fail-closed on empty domain) + lifecycle state machine + idle reaper,
    injectable `Deployer` (`FailClosedDeployer` default) + GET/POST/DELETE /previews. 7 tests.
    Live deploy/reverse-proxy/DNS = GATE-5.
7.5 ☑ CMA provider plugin (§3 managed agents) — `src/providers/cma.ts`: Anthropic Managed
    Agents as an `api` ProviderDriver THROUGH conformance (injectable fetch, model-required-or-
    refuse, key in `x-api-key` header never logged); registered in DRIVER_REGISTRY behind
    `providers.cmaEnabled` (default OFF). Env: CMA_MODEL / CMA_API_KEY / CMA_BASE_URL. 8 tests.
    Live CMA API + conformance = GATE-5.
7.6 ☑ Prompt self-optimization (§3.11 V3 variant) — `src/experiment/promptOptimize.ts`:
    hill-climb over a PROMPT (propose→evaluate→keep-iff-strictly-better→ledger), same crash-safe
    NEVER-STOP discipline as the code experiment engine. 5 tests. Live propose/evaluate = GATE-5.
7.7 ☑ Three-model tiebreaker (§3.10 review) — `src/review/tiebreaker.ts`: when the two tournament
    reviewers disagree (verdict approved vs revise), an injected third model breaks the tie;
    FAIL-CLOSED to the stricter verdict (revise wins) when no tiebreaker; injection-sanitized.
    6 tests. config.tournament.tiebreakerProvider + live third-reviewer spawn = GATE-5.
7.8 ☑ Infra dashboard UI — `web/views/InfraView.tsx` + "Infra" nav (8 tabs): read-only
    workers / preview-envs / CLI-status panels.

Config added (57 leaves total): container/workers/cliUpdate/preview/selfOptimize sections +
providers.cma{Enabled,Model} + tournament.tiebreakerProvider. Per-agent log: docs/PHASE7-PROGRESS.md.

**Phase 7 remaining ☐ — GATE-5 only (physically not validatable on macOS):** real docker/podman
run-spawn integration, remote worker daemons pulling the queue, live CLI update exec, live preview
deploy/reverse-proxy/DNS, live CMA API + conformance, live third-reviewer spawn. Every code-able
surface is built, green, and wired; what remains needs the Linux runtime + real provider/infra surfaces.

## Phase 8 — macOS board UX + readiness fix (DONE ☑ 2026-06-13) → then Linux GATE-5 finish

Owner-driven dev session: ran the server on macOS, added tasks via the UI/API, surfaced two real
issues. Both fixed, verified, and green on macOS.

8.1 ☑ **Board project switcher + task add/delete (UI).** `web/views/BoardView.tsx` was hard-pinned
    to `projects[0]` (any task on another project was invisible). Added a project `<select>`
    dropdown + an inline "Add task" composer; a delete "×" on cards threaded
    TaskCard / DraftColumn → SortableTaskCard / KanbanColumn → `KanbanBoard.handleDelete`;
    `DELETABLE_STATES` mirror added to `web/components/kanban/types.ts` (× shown only for
    draft/backlog/cancelled/done, matching the server). NOTE: create + delete emit NO SSE event
    (only transitions do) → the board refetches explicitly via a `reloadSignal` prop bump (add)
    and `loadTasks()` (delete).
    → verify: typecheck clean; standalone bundle builds (44 modules); live create→appears,
      delete→gone round-trip.

8.2 ☑ **Readiness-recompute bug — a zero-dependency task stuck in `backlog` forever.**
    `backlog→ready` is `systemOnly` (the UI drag is correctly reverted) and is ONLY driven by
    `recomputeReadiness` (`src/tasks/dependencies.ts`), which fired on transition→done /
    dependency add-remove / coder-run-finish / triage — but **never after `promote` (draft→backlog)**,
    and no periodic/boot recompute existed. So a no-dependency task (which should be ready
    immediately) sat in backlog with no path forward. Fix: (a) `src/server/routes.ts` promote
    handler now calls `recomputeReadiness(projectId)` after a successful promote → a no-dep task
    goes draft→backlog→ready at once (mirrors the dependency-endpoint pattern); (b) `src/server/main.ts`
    `onReady` runs a boot-time `recomputeReadiness(handle, events)` across all projects
    (dev/Linux path only, never under test) as a safety net that unsticks already-backlog tasks
    on restart.
    → verify: 124/124 (server + tasks + scheduler + orchestrator), typecheck clean; live
      promote→`ready` + boot recompute unstuck the existing tasks.

**GATE 5 — Linux finish (IN PROGRESS: host deployed 2026-06-14; core seams wired).**
On macOS a `ready` task correctly **PARKS** — it does NOT auto-advance to `coding` — because the
scheduler's host `resolveSpawn` closure (project `repoUrl` → local checkout + prompt build + live
`claude`/coder spawn) is intentionally unwired off-Linux (`main.ts:148-168`, fail-closes → every
ready task is skipped, never a pretend spawn). GATE-5 worklist status:
  - ☑ **Boot-wire core host closures in `main.ts`:** `resolveSpawn` (repo→checkout via
    `NIGHTSHIFT_REPO_DIR` + §3.12.18 reassign + prompt build), `readTranscriptTail` (tmux
    capture-pane), `runActivity` (startedAt baseline), `bootProviderConformance`, auto-merge hook
    (gated on `review.autoMergeEnabled`), V2 loops (cron/notifier/digest via `startV2Loops`),
    `startSchedulerLoop` — all live in `onReady` seam. Service confirmed started: scheduler
    loop + /healthz/readyz up.
  - ☑ **Anti Gravity CLI rename** (`agy`): `gemini.ts`, `antigravity.ts` (now full headless
    `agy` driver, not fail-closed stub), `cliUpdate.ts`, `cliDrivers.test.ts` all updated.
    `agy` v1.0.8 installed at `/home/nightshift/.local/bin/agy`.
  - ☑ **Coder-completion trigger** (closes GATE-2 live): `src/orchestrator/coderCompletionTrigger.ts`
    — subscribes TAIL-ONLY to run.state_changed; on a coder run → succeeded, builds prod coder deps
    (fail-closed on missing GITHUB_TOKEN) and runs `completeCoderRun` (branch-freshness/CI/push/PR →
    task coding→review). prodDeps.ts had NO live caller before this; now wired in `main.ts` onReady.
  - ☑ **Review-round trigger** (closes GATE-3 live): `src/orchestrator/reviewTrigger.ts`
    — subscribes TAIL-ONLY to task.state_changed; on a task → review, assembles live ReviewDeps
    (threadApi + runVerdict + codeReviewJudge + liveSpawn makeGetDiff/makeRunReviewer/makeResumeCoder;
    tournament-aware) and runs `runReviewRound` (approve→approved / revise→resume coder ping-pong).
  - ☑ **Evidence-based routing wrap (6.D2)**: `makeEvidenceResolveSpawn` now wraps `resolveSpawn`
    in `main.ts` (candidates = enabled coder providers, defaultCoder-first for cold-start).
  - ☑ **AGENTS.md upkeep cadence (6.B4/6.D4)**: `src/maintenance/agentsMdCadence.ts` — 6h advisory
    sweep per project (scan → propose → emit `maintenance.agents_md.proposed`; never auto-writes).
  - All three modules built via multi-agent workflow + tested (21 new tests, all green; full suite
    1177 pass / 4 pre-existing bwrap-on-Linux fails; typecheck clean). Service restarted & verified
    live (scheduler loop + 3 triggers running; /healthz + /readyz ok).
  - ☑ **`produceFinder` specialist spawn + §3.4 harness review path (5.6 LIVE)**: `liveSpawn.makeProduceFinder`
    (one captured reviewer one-shot per specialist, fail-soft → "" so the harness's all-fail⇒block
    invariant holds) + `src/orchestrator/harnessReview.ts` `runHarnessReviewRound` (runs the risk-tiered
    parallel finders via `runReviewHarness` → `toVerdictShape`, then persist/apply mirroring
    `runReviewRound`). Selected per new `config.review.specialistHarness` flag (default false; editable
    registry knob added); `reviewTrigger` branches single-judge vs harness. 6 tests (Haiku), all green.
  - ☑ **Experiment-run dispatch seam (6.A4/6.D3)**: `src/orchestrator/experimentDispatcher.ts`
    `dispatchExperiment({routineId, taskId})` — the missing caller for `runExperimentForRun` (which
    had none): looks up the experiment routine, creates an `experiment`-kind run, walks the run
    lifecycle (queued→starting→running→finishing→succeeded|failed), and drives the hill-climb loop.
    FAIL-CLOSED: live side-effects injected via `experimentDeps` (default `makeFailClosedExperimentDeps`
    refuses agent/git/eval → run finalizes failed, never pretends). 5 tests (Haiku), all green.
    REMAINING (runtime/GATE-5): the LIVE experiment deps (produceEdit via agent spawn, commit/reset via
    git, evalRunner on a read-only checkout OUTSIDE target_paths §3.12.8) + an invocation surface
    (HTTP route / cron) — same runtime category as the live coder spawn.
  - ◑ **"fix typo" end-to-end** per `docs/LINUX-DEPLOY.md` (real spawn → push → PR → review ping-pong →
    human merge → dependents unblock). HOST DIAGNOSED READY 2026-06-14: `claude` 2.1.177 authenticated
    (`.credentials.json`), `codex` 0.139.0, `agy` 1.0.8, `bwrap` 0.11.0 works (namespace smoke ok),
    `GITHUB_TOKEN` set, `git`/`tmux` present. The coder-completion + review triggers are wired and inert
    until a live coder run succeeds. GAPS before a full run: (a) nftables egress not yet applied (the
    sandboxed agent needs network to Anthropic); (b) no demo project/task in the DB; (c) `NIGHTSHIFT_REPO_DIR`
    points at the live repo — a real run needs a dedicated target repo. The final push→PR→human-merge is
    outward-facing and needs an explicit target repo + go.
  - ☑ **CLI auto-update cadence (7.3 LIVE)**: `src/providers/cliUpdateCadence.ts` `startCliUpdateCadence`
    — wired in `main.ts` onReady (status() every `cliUpdate.checkIntervalHours`, emits `providers.cli_status`;
    runs updates only when `cliUpdate.enabled` AND a target advertises one). 5 tests (Haiku).
  - ◑ **Container isolation in spawn (7.1)**: `src/runs/containerSpawn.ts` `makeIsolatedSpawn` built + tested
    (6, Haiku) — drop-in for `sandboxCoderCommand`, fail-closed off-Linux/no-docker, passthrough when
    `container.enabled=false`. WIRING PENDING: `spawn.ts` has no `config` in scope; routing the call site
    (`spawn.ts:302`) through it needs threading `config.container` into `spawnRun`/`startCoderTask`. Deferred
    (no docker on host + invasive signature change for an unrunnable-here feature).
  - ◑ **Three-model tiebreaker live spawn (7.7)**: `src/orchestrator/tiebreakerReviewer.ts`
    `makeTiebreakerReviewer` built + tested (12, Haiku) — satisfies `TiebreakDeps.runTiebreaker` (spawns the
    third reviewer one-shot, fail-closed-to-stricter). WIRING PENDING: `resolveWithTiebreak` works on two
    parsed `Verdict`s, but the live tournament path synthesizes at the stdout level — connecting needs a
    Verdict-level review-round restructure (architectural).
  - ☑ **Experiment live deps + invocation route (6.A4/6.D3 LIVE)**: `src/orchestrator/experimentLiveDeps.ts`
    `makeLiveExperimentDeps` — REAL produceEdit (one-shot agent turn editing only target_paths), commit
    (git add+commit, ok:false when nothing changed), evalRunner (§3.12.8: eval runs on a SEPARATE detached
    `git worktree add --detach` checkout of the commit, NOT the agent's editing dir, always removed in
    finally), parseMetric (JSON+regex), reset (git reset --hard + clean). All sub-seams injectable. 7 tests
    (Haiku) incl. an explicit §3.12.8-isolation assertion. Wired via `POST /routines/:id/experiment` in
    routes.ts (synchronous routine/repo guards → fire-and-forget `dispatchExperiment` with the live deps,
    202 Accepted). Chain now complete: route → dispatchExperiment → runExperimentForRun → live deps.
  - ☐ **Remaining runtime surfaces:** bwrap (2.3, works) + nftables egress (2.4 — needs a SEPARATE agent uid:
    control plane + agents share uid 1000, so a uid-scoped DROP would filter the control plane); container
    runtime (docker/podman absent); remote worker daemons (7.2 — needs other machines); live preview
    deploy/reverse-proxy/DNS (7.4); live CMA API + conformance (7.5 — needs key); prompt-optimize
    propose/evaluate (7.6 — needs a dispatcher + persistence-schema decision first); `playwright install`
    + browser verify (6.B5 — package not installed, gate off by default).

---

## How to resume a session (for the operator)
1. Open Claude Code in `…/SOFTWARE FACTORY/nightshift/`.
2. Say: **"Прочети IMPLEMENTATION-PLAN.md и продължи от първия незавършен
   таск"** (or name a phase/task).
3. Everything needed is in-repo: BLUEPRINT (§3.12 binding), the 3 specs,
   REUSE.md, this plan. Mark tasks ☑ + commit as they complete.
