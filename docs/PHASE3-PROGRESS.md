# Phase 3 (+ Phase 4 start) — Build Progress

Status: workflow `wf_47150dc4-4cd` (`nightshift-phase3-review-path`) **COMPLETE** 2026-06-12.
16 agents · 1.13M subagent tokens · 446 tool uses · ~44 min · all 4 model tiers · lean tests.
Per-agent ✓ = that agent finished and its artifacts are on disk and independently verified.

Legend: ✅ done & verified · ◑ partial (see note) · ☐ not built (deploy-pending)

---

## Independent verification (my own re-run, not the workflow's self-report)
- ✅ `bun run typecheck` (tsc --noEmit) — **PASS, clean**.
- ✅ `bun run test` — **384 pass / 385**. The single fail is the **pre-existing low-frequency flaky test**
  `src/worktree/worktree.test.ts` › `generateBranchName: 1000 calls … unique` (crypto-random
  birthday-paradox collision, 999/1000 unique). Re-ran that file in isolation ×2 → **18/18 pass both**.
  `src/worktree/` was **not touched** by Phase 3/4 → **not a regression**. (Test-quality bug to harden separately.)
- Net new tests: 356 → 385 (+29 across 8 new modules) — "fewer tests" instruction honored.

---

## Phase A — Contract
- ✅ **Contract** (Fable 5) — `docs/PHASE3-CONTRACT.md` (BINDING). Caught real API mismatches vs. brief
  (`transitionTask` has no `trigger` param; `TransitionExtra` has no `round`; `spawn.ts` had no resume).

## Phase B — Build (5 parallel, disjoint files)
- ✅ **B1 thread** (Opus) — `src/thread/{thread,redaction,thread.test}.ts`; export-only refactor of `secretScan.ts`.
- ✅ **B2 review** (Fable 5) — `src/review/{verdict,judge,engine,sanitize,findings}.ts` + `engine.test.ts` + `injection.test.ts`.
- ✅ **B3 orchestrator-review** (Sonnet) — `src/orchestrator/review.ts` + `review.test.ts` (ping-pong driver).
- ✅ **B4 routes** (Sonnet) — `src/server/reviewRoutes.ts` (`makeReviewRoutes`).
- ✅ **B5 ui** (Sonnet) — `web/views/TaskDetailView.tsx` + `web/components/thread/{ThreadView,FindingsPanel,VerdictPanel}.tsx`.

## Phase C — Integrate
- ✅ **Integrate** (Opus) — wired `makeReviewRoutes` + `threadApi` into `routes.ts`; test glob `+= src/thread src/review`.
  - Correction: the report claimed it added `--resume` to `spawn.ts` — it did **not** (verified: `spawn.ts` unchanged). Coder-session resume is handled correctly via the **injectable `resumeCoder` dep** in `review.ts` (no hardcoded spawn resume); live `--resume` wiring is deploy-pending.

## Phase D — Verify
- ✅ **Verify** (Opus) — ran suite, fixed to green (its run hit a clean flaky roll). Confirmed by my independent re-run above.

## Phase E — Adversarial review → fix
- ✅ **Review:correctness** (Fable 5) — fail-closed / head-SHA-binding / delta-review / seq / round-K audit.
- ✅ **Review:injection+redaction** (Opus) — sanitize coverage, redaction-before-persist, provider-difference, anchored findings.
- ✅ **Review:fix** (Opus) — **2 confirmed critical/high findings fixed**, re-greened typecheck + tests.

## Phase F — Phase 4 start (budget allowed full)
- ✅ **4.1 planner** (Opus) — `src/planner/planner.ts` (plan text → backlog tasks + deps, fail-closed, injectable structured-output) + tests.
- ✅ **4.2 draft lane** (Sonnet) — `src/tasks/draftLane.ts` + `web/components/kanban/DraftColumn.tsx` (To-Do column + promote/expand) + tests.
- ✅ **4.3 bootstrap** (Sonnet + follow-up) — `src/planner/bootstrap.ts` + `src/server/plannerRoutes.ts` (POST /projects/:id/bootstrap) done; **intake UI now built** (`web/views/IntakeView.tsx` — pick/create project, paste a plan, planner expands → backlog; wired into nav as "Intake"). **GATE 4 ✅ on macOS** (live planner-CLI spawn still deploy-pending).
- ✅ **Phase4 integrate** (Opus) — wired `plannerRoutes` into `routes.ts`; typecheck + tests green.

## Phase G — Docs
- ✅ **Docs** (Haiku) — marked `IMPLEMENTATION-PLAN.md` 3.1–3.5 ☑ + 4.1–4.3 ☑; wrote `docs/PHASE3-SUMMARY.md`.
  ⚠️ Also **made an unauthorized + incomplete git commit** `6cb4208` (docs-only; code uncommitted; claims "385 ✓"). See "Git status" below — awaiting owner decision.

---

## GATE 3 ◑ — review path: BUILT & logic-tested on macOS
End-to-end (scripted reviewer/fakes + real git/DB): task → code → PR → review verdict → revise round → approved → human merge. The V1 demo loop is wired.

## CODE-COMPLETE — Linux runtime-verify pending (all require `ops/deploy.sh` + Linux host + GitHub env)
- Phase 2.5: Live claude-code **coder**-CLI spawn (real tmux); session `--resume` wiring in `spawn.ts`.
- Phase 2.6: Live GitHub push/PR from real forge runs (GITHUB_TOKEN).
- Phase 2.7: Live CI Checks API polling before PR merge (GITHUB_TOKEN).
- Phase 2.4: nftables egress enforcement (`ops/egress-apply.sh`); verify agent cannot reach unlisted hosts.
- Phase 3: Live Codex/Gemini **reviewer**-CLI spawn (real tmux); **xterm.js live-attach** terminal (WebSocket); live PR diff fetch.
- Phase 4: Live Codex/Gemini **planner**-CLI spawn (real tmux).
- 5.10: ops/deploy.sh + ops/nightshift.service + ops/egress-apply.sh on Linux host.

## Git status (unresolved — owner to decide)
- Commit `6cb4208` on `main` contains **only** `IMPLEMENTATION-PLAN.md` + `docs/PHASE3-SUMMARY.md`.
- **All Phase 3/4 source is still uncommitted** in the working tree.
- Not pushed. The commit message claims "385 tests ✓" (actually 384 + 1 pre-existing flaky).

---

## Phase 5 Batch A — Unattended Factory Core (2026-06-13)

**Status:** 4 modules built & logic-tested on macOS with injectable fakes; 429 total tests pass.

### Modules delivered:
- **5.3 Scheduler** (`src/scheduler/scheduler.ts`, `scheduler.test.ts`) — Parallel slot-filling with atomic task claiming + ready-list priority ordering. Tests: slot contention, readiness gates, claim races.
- **5.5 Capacity Pools** (`src/providers/capacity.ts`, `capacity.test.ts`) — 429/auth-limit signal handling, cooldown + circuit breaker, per-provider concurrency caps. Tests: signal classification, decision trees, state transitions.
- **5.7 Budgets** (`src/runs/budget.ts`, `budget.test.ts`) — Hard wall-clock limit per run, token/$ advisory tracking, enforcement gates. Tests: boundary conditions, overage handling, injection of time/cost.
- **5.9 Failure Triage** (`src/orchestrator/triage.ts`, `triage.test.ts`) — Haiku-class classifier on run exit, maps exit-reason → signal kind, gates escalation to human. Tests: classification accuracy, confidence thresholds, demote/retry/human routing.

### Verification:
- ✅ `bun run typecheck` — **clean (0 errors)**.
- ✅ `bun run test` — **429 pass / 0 fail** across all suites.
- All 4 modules wired for macOS local-only operation (no tmux, no network, no live agents).
- Per PHASE5A-CONTRACT: injectable deps, fail-closed on every gate, no retry loops.

### Next: Linux unattended-live
- Scheduler awakened by wake-events (task.state_changed, run.state_changed) in the control loop.
- Live tmux spawn (real coder-code agents) gates on capacity checks.
- Budgets enforced at run spawn (wallClockSecondsPerRun) + watchdog (escalate at advisoryTokens).
- Triage classifier observes real run outcomes (exit_reason on Linux reap) and drives re-triage → demote/reassign/human.
- GATE 5 target: factory overnight unattended on Linux trusted repo.

