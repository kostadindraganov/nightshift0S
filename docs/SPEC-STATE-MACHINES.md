# Nightshift — State Machines (step-0 gate artifact)

Status: v1.0, 2026-06-10. Per BLUEPRINT §3.12.9. Every transition below is
enforced with a guarded SQL update (`UPDATE … SET state='Y' WHERE id=? AND
state='X'`); a 0-row update means the transition was lost to a concurrent
actor and MUST be treated as a no-op, never retried blindly. Every transition
emits an event to the global event log (write DB first, then notify broker).

## 1. Task

The unit on the kanban board.

```
draft → backlog → ready → coding → review → approved → merging → done
                    ↑        │        │         │
                    │        │        ├──→ needs_human ──→ (coding|merging|cancelled)
                    │        ↓        ↓
                    └──── failed ←────┘
any non-terminal → cancelled
```

| From | To | Guard / trigger |
|---|---|---|
| draft | backlog | manual promote or planner expansion (fills description + acceptance criteria) |
| backlog | ready | ALL dependencies have non-null `merge_sha` (§3.12.29) — recomputed on every dependency merge event |
| ready | coding | **atomic claim**: `UPDATE tasks SET state='coding', claimed_by=:runner WHERE id=:id AND state='ready'`; plus worktree file-lock acquired (BLUEPRINT §3.6); plus partial unique index `one_active_run_per_task` |
| coding | review | coder run `succeeded` AND CI gate green AND branch-freshness gate passed AND forge service opened PR |
| coding | failed | coder run terminal-failed after auto-triage retry policy |
| coding | needs_human | coder run succeeded but a pre-PR gate blocked (secret scan / CI red / stale-base block / forge PR-open failed) — escalate; the work can't auto-advance to review |
| review | coding | review round verdict = `revise` AND round < K — same coder session resumed |
| review | approved | review round verdict = `approved` |
| review | needs_human | round = K without approval; OR deadlock after tiebreaker; OR schema-repair exhausted |
| approved | merging | V1: human clicks merge. V1.5+: auto-merge preflight passed (§3.12.26) |
| merging | done | forge confirms merge; `merge_sha` recorded; dependents' readiness recomputed |
| merging | needs_human | merge conflict / checks went red / preflight failed |
| failed | backlog | demotion: priority bumped past current max (localforge pattern); manual or auto per policy |
| needs_human | coding/merging/cancelled | human verdict (with break-glass rules §3.12.5 for force-merge) |
| * (non-terminal) | cancelled | manual; running runs get killed via Run machine |

Task row carries: `base_sha` (merge-base recorded at claim), `branch`,
`merge_sha` (set only at done), `round` (current review round).

## 2. Run

One agent execution (coder turn, reviewer round, planner, judge, utility,
experiment iteration). A task has many runs; at most one active.

```
queued → starting → running ↔ awaiting_input
                       │  ↘ background_waiting → running
                       ↓
                   finishing → succeeded | failed | killed | interrupted
```

| From | To | Guard / trigger |
|---|---|---|
| queued | starting | spawn semaphore acquired AND provider concurrency cap not exceeded (§3.12.27) AND provider circuit closed |
| starting | running | SessionStart lifecycle hook received (tank bridge) |
| running | awaiting_input | PreToolUse hook with blocking tool (AskUserQuestion/ExitPlanMode) |
| awaiting_input | running | PostToolUse for same tool, or user reply |
| running | background_waiting | interim Stop with `background_tasks[].status=running` (tank §3.6) — keep tmux alive |
| background_waiting | running/finishing | next Stop after all subagents return |
| running | finishing | Stop hook received; OR completion signal detected then completion-timeout (1 min) fired (ADR-0019: force-complete SUCCESSFULLY, warn) |
| running | failed | watchdog: >5 min silent AND transcript tail shows api-error; OR per-step timeout |
| running | succeeded | watchdog: >5 min silent AND transcript tail is normal assistant text (missed hook) |
| finishing | succeeded/failed | exit reason classification; cost/tokens hydrated if provider reports them (`priced` flag) |
| running/awaiting_input/background_waiting | killed | manual stop, kill-budget exceeded (wall-clock), or task cancelled. Reap order: kill tmux → pkill CLI by session id → sleep 400 ms → filesystem/DB (tank §3.6) |
| * (non-terminal) | interrupted | startup reconciliation: process/tmux gone — every non-terminal run whose session vanished across a restart (tank/localforge); distinct from `killed` (we reaped) and `failed` (it errored) |

Startup reconciliation (boot): every run in a non-terminal state whose tmux
session is gone → `interrupted`; its task returns coding→failed→backlog path
or stays in review per round state.

## 3. ReviewRound

One reviewer pass within a task's review state.

```
pending → reviewing → verdict_approved | verdict_revise | error
```

| From | To | Guard / trigger |
|---|---|---|
| pending | reviewing | reviewer run started (different provider than coder by default) |
| reviewing | verdict_approved / verdict_revise | structured verdict parsed AND schema-validated; up to N schema-repair retries (§3.12.13) on malformed output |
| reviewing | error | schema-repair exhausted, reviewer run failed, or timeout → task → needs_human |

Round bookkeeping: round r ≥ 2 is a **delta review** — input = previous
findings (with resolution states) + new diff only. Each finding carries
anchors (§3.12.10): commit SHA, old/new path, hunk context. Resolution
states: `open → fixed | rebutted | withdrawn | accepted_risk`; a `rebutted`
finding MUST be addressed (accept/withdraw/escalate) in the next round.
Optional tiebreaker at round K-1: third provider votes, 2-of-3 wins.

## 4. PR

```
none → open → checks_pending → checks_green | checks_red
                                    │              │
                                 merged ←──────────┘ (after fix round)
              open/checks_* → closed
```

- `open` requires: branch-freshness gate (rebase/merge-base validation
  §3.12.12) AND secret scan of outgoing diff passed (§3.12.25).
- `merged` (V1.5+ auto path) requires preflight §3.12.26: branch protection
  verified, required checks from trusted app IDs, fresh head SHA, no bypass
  perms on bot token.
- PR `closed` without merge → task → needs_human (never silently failed).
- Head SHA recorded on every push; verdicts are bound to the head SHA they
  reviewed — a new push invalidates an `approved` verdict.

## 5. Trigger/Routine dispatch (V1.5)

```
trigger fires → (authz + dedupe + rate limit §3.12.6) → task instance created (backlog or draft for external sources: "dry-run pending approval")
```
Single-flight per trigger; no catch-up on missed cron windows (warren).

## 6. Canonical guarded-SQL patterns

```sql
-- claim
UPDATE tasks SET state='coding', claimed_by=:run_id, updated_at=:now
 WHERE id=:id AND state='ready';
-- finish run (idempotent)
UPDATE runs SET state='succeeded', ended_at=:now
 WHERE id=:id AND state IN ('running','finishing');
-- dependency unblock (recompute on merge event)
UPDATE tasks SET state='ready' WHERE state='backlog' AND id IN (
  SELECT t.id FROM tasks t WHERE NOT EXISTS (
    SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.depends_on_task_id
    WHERE d.task_id=t.id AND dep.merge_sha IS NULL));
```

Invariants (enforced by schema + tests):
1. ≤1 active (non-terminal) run per task (partial unique index).
2. A task in `coding`/`review` always holds its worktree lock.
3. `merge_sha` set ⟺ state=`done`.
4. Verdict rows reference the head SHA they evaluated.
5. Every state change has a corresponding event row (audit completeness test).
