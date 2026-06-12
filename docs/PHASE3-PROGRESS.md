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

## Deploy-pending (needs Linux host + live GitHub — out of scope on macOS)
- Live Codex/Gemini **reviewer**-CLI spawn under real tmux (here: injectable scripted reviewer).
- Live Codex/Gemini **planner**-CLI spawn (here: injectable scripted client).
- **xterm.js live-attach** terminal in TaskDetailView (placeholder panel rendered).
- ~~Project bootstrap chat view (paste-a-plan intake UI)~~ — **DONE** (`web/views/IntakeView.tsx`); only live planner-CLI spawn remains.
- Live coder-session `--resume` wiring in `spawn.ts` (today: injectable `resumeCoder` dep; no real CLI resume).
- Live GitHub push/PR + CI Checks API polling (Phase 2 deploy items); nftables egress enforcement.

## Git status (unresolved — owner to decide)
- Commit `6cb4208` on `main` contains **only** `IMPLEMENTATION-PLAN.md` + `docs/PHASE3-SUMMARY.md`.
- **All Phase 3/4 source is still uncommitted** in the working tree.
- Not pushed. The commit message claims "385 tests ✓" (actually 384 + 1 pre-existing flaky).
