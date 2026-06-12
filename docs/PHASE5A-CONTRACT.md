# Phase 5 Batch A Contract — unattended-factory core (toward GATE 5)

Status: BINDING for builders S1–S4. Verified against the real code on 2026-06-13.
Plan items: 5.3 parallel-slot scheduler, 5.5 provider capacity pools, 5.7 run budgets, 5.9 failure auto-triage.
Specs: BLUEPRINT §3.7.1 (slot-filling), §3.7.2 (wake-event + poll hybrid), §3.12.14 (capacity pools), §3.12.15 (budgets), §3.12.18 (failback ≠ routing), §3.12.27 (per-provider caps + kill budgets), §3.4 (cheap-lane failure triage); SPEC-STATE-MACHINES §1 (Task), §2 (Run).

House rules (all builders): TypeScript + ESM + Bun. TABS in `src/`. Every new file opens with a JSDoc `WHY` header (see `src/orchestrator/coder.ts`). ALL side-effects injectable (the `CoderOrchestratorDeps` / `SpawnDeps` pattern) — every module in this batch runs on macOS with fakes: NO live agent spawn, NO tmux, NO network, NO real timers in tests. FAIL-CLOSED on every decision: a missing/unknown signal escalates to human or refuses — never silently retries forever, never over-spawns. ONE `*.test.ts` per module, ≤5 hermetic cases, concurrency-critical paths covered. Test ONLY your own file (commands pinned per builder below). Do NOT run the full suite or project typecheck. Do NOT edit files outside your row in §1 — `config.ts`, `routes.ts`, `main.ts`, `package.json` are INTEGRATION-owned (read them, propose knobs in your return, do not edit).

GATE 5 ("unattended overnight") is the live-on-Linux goal: this batch must be fully exercisable on macOS with fakes; the live loop (real tmux + egress + bwrap) is exercised only on the Linux VM.

No DB migration. Everything this batch needs already exists: `providers.concurrency_cap / cooldown_until / circuit_state / last_error` (src/db/schema.ts:270-283), `runs.exit_reason / tokens_in / tokens_out / cost_usd / priced / started_at` (schema.ts:146-186), partial unique index `one_active_run_per_task`, task edges `coding→failed`, `failed→backlog` (demote), `coding→needs_human`, run edge "any active→killed" (trigger `kill`).

---

## 1. File-ownership table (no two builders touch the same file)

| Builder | Creates | Edits | Test command |
|---|---|---|---|
| **S1 scheduler** | `src/scheduler/scheduler.ts`, `src/scheduler/scheduler.test.ts` | — | `bun test src/scheduler` |
| **S2 capacity** | `src/providers/capacity.ts`, `src/providers/capacity.test.ts` | — | `bun test src/providers/capacity.test.ts` |
| **S3 budget** | `src/runs/budget.ts`, `src/runs/budget.test.ts` | — | `bun test src/runs/budget.test.ts` |
| **S4 triage** | `src/orchestrator/triage.ts`, `src/orchestrator/triage.test.ts` | — | `bun test src/orchestrator/triage.test.ts` |
| **INTEGRATION** (not a builder) | production wiring closures | `src/config/config.ts` (knobs §7), `src/server/main.ts` (drive scheduler + budget sweep + triage hook, seed provider rows), `src/server/routes.ts` (optional capacity/scheduler status routes), `package.json` (test glob += `src/scheduler`) | — |

Parallel-build rule (PHASE3 B3 pattern): S1 and S4 do NOT import `src/providers/capacity.ts` at runtime. They declare **local structural ports** (§5.1, §6.1) that are duck-compatible with S2's pinned exports; their tests run with fakes even if `capacity.ts` does not exist yet. INTEGRATION resolves the ports with the real module.

Shared invariants (everyone — identical to Phase 3 §2): all DB writes via `enqueueWrite`; events inside a writer link via `log.emitInWriter`, outside via `log.emitEvent`; task state ONLY via `transitionTask(handle, log, {taskId, to, expectedFrom, actor, extra})`; run state ONLY via `transitionRun(handle, log, {runId, to, expectedFrom, actor, extra})`; a `{ok:false, reason:"lost_race"}` is a tolerated no-op, never thrown, never blindly retried. Do NOT add task/run edges; do NOT edit `src/tasks/transitions.ts` or `src/runs/transitions.ts`.

---

## 2. Reuse map — what already exists (lean on it, do NOT reinvent)

| Need | Existing seam | Exact signature |
|---|---|---|
| Atomic claim (≤1 active run/task) | `src/runs/runs.ts` | `claimTaskAndCreateRun(handle, log, input: CreateRunInput): Promise<ClaimResult>` — guarded `ready→coding` + run insert; partial unique index backstops it. `CreateRunInput = { taskId, kind, provider, model, authLane }` |
| Claim + spawn convenience | `src/orchestrator/coder.ts` | `startCoderTask(deps: SpawnDeps, input: StartCoderTaskInput, probes?): Promise<{ok:true; run} \| {ok:false; reason}>` — includes the egress fail-closed gate (`unattended: true` for scheduler spawns) |
| Spawn (worktree + HOME + tmux) | `src/runs/spawn.ts` | `spawnRun(deps: SpawnDeps, input: SpawnRunInput): Promise<RunRow>`; `SpawnDeps = { handle, log, launcher }` |
| Run lookup | `src/runs/runs.ts` | `getRun(handle, id): RunRow \| null`; `listRuns(handle, filter?: {taskId?, state?}): RunRow[]` |
| Ready-task list (priority order) | `src/tasks/tasks.ts` | `listTasks(handle, {state: "ready"}): TaskRow[]` — sorted priority asc, then id asc |
| Kill a live run | `src/runs/reap.ts` | `reapRun(deps: ReapDeps, runId, {reason:"killed"}): Promise<void>` — tmux kill → 400 ms → run→killed |
| Watchdog plug point | `src/runs/watchdog.ts` | `evaluateRun(deps: WatchdogDeps, run, lastActivityMs, completionSignalAtMs)`; `StepTimeout = { name, limitMs, runId }` ("for future policy enforcement" — S3 uses it); `classifySilentTranscript(tail)` + `API_ERROR_PATTERNS` precedent for S4 keywords |
| Demote / escalate edges | `src/tasks/transitions.ts` | `coding→failed` (coder_failed), `failed→backlog` (demote — bumps priority past project max), `coding→needs_human` (gate_blocked) |
| Readiness recompute | `src/tasks/dependencies.ts` | `recomputeReadiness(handle, log, projectId): Promise<TaskRow[]>` (backlog→ready, systemOnly) |
| Wake events | `src/events/events.ts` | `EventLog.subscribe({afterSeq?, filter?, signal?})` — replay-then-tail, bounded buffer; kinds `task.state_changed` / `run.state_changed` carry `{from, to, trigger}` payloads |
| Provider capability gate | `src/providers/router.ts` | `selectDriver(drivers, role): ProviderDriver \| null` — INTEGRATION's `resolveSpawn` consults it; S1 never does capability logic |
| Config knobs (existing) | `src/config/config.ts` | `concurrency.maxParallelSlots` (default 1), `concurrency.perProviderCap` (default 1), `budgets.wallClockSecondsPerRun` (default 3600), `budgets.advisoryTokensPerRun` (default 200000) |

Capacity-column ownership: **S2 is the ONLY writer** of `providers.cooldown_until / circuit_state / last_error` and the only reader-of-record for `concurrency_cap`. `providers.capabilities_json` stays owned by `src/providers/conformance.ts` (`recordCapabilities`) — S2 must not touch it.

---

## 3. OWNER S2 — `src/providers/capacity.ts` (capacity pools, §3.12.14)

Pools are OPAQUE: no pretend quota API. State is driven by observed 429/auth-limit signals plus operator-configured caps/cooldowns, persisted on the providers row.

### 3.1 Pinned exports

```ts
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { AuthLane, CircuitState, ProviderAuthMode, ProviderKind } from "../db/columns.ts";

export type CapacitySignalKind = "429" | "auth_limit" | "ok" | "error";

export interface CapacitySignal {
	provider: string;          // providers.name
	kind: CapacitySignalKind;
	detail?: string;           // free text → providers.last_error on failure kinds
}

export type CapacityDecision =
	| { ok: true; lane: AuthLane }
	| { ok: false; reason: "unknown_provider" | "disabled" | "circuit_open" | "cooldown" | "at_cap" };

export interface CapacityDeps {
	handle: DbHandle;
	log: EventLog;
	now(): Date;                  // injectable clock
	cooldownSeconds: number;      // config capacity.cooldownSeconds
	overflowToApiKey: boolean;    // config capacity.overflowToApiKey (default false)
}

/** Boot-time seeding (INTEGRATION calls this; upsert by name, never clobbers
 *  capacity state or capabilities_json on an existing row). */
export function ensureProvider(deps: CapacityDeps, input: {
	name: string; kind: ProviderKind; authMode: ProviderAuthMode; concurrencyCap: number;
}): Promise<void>;

/** THE scheduler gate (consulted BEFORE every claim — §5.2 step 3). */
export function canSpawn(deps: CapacityDeps, provider: string, requestedLane: AuthLane): Promise<CapacityDecision>;

/** Signal sink: 429/auth_limit/error from triage + ok from the run-succeeded hook. */
export function observe(deps: CapacityDeps, signal: CapacitySignal): Promise<void>;

/** Maps a runs.exit_reason (+ transcript hints) to a signal kind. "ok" is never
 *  returned here — failure-side classification only; unknown → "error". */
export function signalFromExitReason(exitReason: string | null): Exclude<CapacitySignalKind, "ok">;
```

### 3.2 Pinned semantics

`canSpawn(provider, requestedLane)` evaluates in order, fail-closed:
1. No providers row with that name → `{ok:false, reason:"unknown_provider"}` (refuse, never default-allow).
2. `enabled === false` → `disabled`.
3. Circuit: `open` + `cooldown_until` in the future → `circuit_open`. `open` + cooldown expired → flip `open→half_open` (via `enqueueWrite`) and continue with an effective cap of **1** (single probe run). `half_open` → effective cap 1.
4. Cooldown (circuit `closed`): `cooldown_until` in the future →
   - if `requestedLane === "subscription"` and `overflowToApiKey === true` → return `{ok:true, lane:"api_key"}` (the §3.12.14 subscription→api_key overflow; cooldowns model subscription-quota exhaustion, the api_key lane is metered money and remains open),
   - else → `{ok:false, reason:"cooldown"}`.
5. Cap: count runs with `runs.provider === name AND state NOT IN` `RUN_TERMINAL_STATES`; `count >= effectiveCap` (row `concurrency_cap`, or 1 when half_open) → `at_cap`.
6. Otherwise `{ok:true, lane: requestedLane}`.

`observe(signal)` (all row writes inside one `enqueueWrite` link, event via `emitInWriter`):
- `"429"` / `"auth_limit"` → `cooldown_until = now + cooldownSeconds`, `last_error = detail ?? kind`; if current circuit is `half_open` → back to `open` (probe failed); if `closed` → `open`.
- `"error"` → record `last_error` only (a single generic failure does NOT trip the circuit — only quota/auth signals do; auto-triage owns generic-failure policy).
- `"ok"` → `half_open→closed`, clear `cooldown_until` + `last_error`. (`closed` stays closed; `open` + ok is a stale signal — ignore.)
- Every state-affecting observe emits event kind **`capacity.state_changed`** payload `{ provider, signal: kind, circuitState, cooldownUntil, lastError }`.

Race note (why this is safe enough): `canSpawn` is only called from inside the scheduler's single-flight tick (§5.2), and the claim that follows immediately inserts the run row (state=queued, counted as active) before the next `canSpawn` count runs — so the active-count in step 5 is monotone within a pass and the cap cannot be over-shot by the scheduler. Manual API spawns bypass capacity by design (operator action).

Tests (≤5): unknown-provider refuses; cooldown blocks subscription but overflows to api_key only when knob on; open→half_open single-probe→closed on ok; 429 sets cooldown+opens circuit; at_cap counts non-terminal runs.

---

## 4. OWNER S3 — `src/runs/budget.ts` (run budgets, §3.12.15)

Hard wall-clock budgets are universal and ENFORCED. Token/$ caps are ADVISORY (warn-only) unless the run has proven telemetry (`run.priced`) AND the operator set a hard cost cap. Honest V1 note: today's CLI drivers hydrate tokens/cost at run end (`finishing→terminal`), so advisory checks are post-hoc audit warns; the wall-clock kill is the real overnight enforcement.

### 4.1 Pinned exports

```ts
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";
import type { StepTimeout } from "./watchdog.ts"; // reuse the ADR-0001 descriptor

export interface BudgetDeps {
	handle: DbHandle;
	log: EventLog;
	now(): number;                      // epoch ms — same convention as WatchdogDeps.now
	wallClockSecondsPerRun: number;     // config budgets.wallClockSecondsPerRun (3600)
	advisoryTokensPerRun: number;       // config budgets.advisoryTokensPerRun (200000)
	hardCostUsdPerRun: number;          // config budgets.hardCostUsdPerRun (0 = disabled)
	/** INJECTED kill — production wires `reapRun(reapDeps, runId, {reason:"killed"})`
	 *  (tmux kill → 400 ms → run→killed). Tests pass a fake. budget.ts NEVER
	 *  imports reap.ts/launcher.ts directly. */
	kill(runId: number): Promise<void>;
}

export type BudgetAction = "none" | "kill_wall_clock" | "kill_cost" | "warn_advisory";

export interface BudgetCheck {
	runId: number;
	action: BudgetAction;
	/** Set for kill actions — the StepTimeout that fired (structured logging). */
	timeout?: StepTimeout;
	reason: string;
}

/** Pure single-run evaluation (unit-test surface). `alreadyWarned` suppresses
 *  duplicate advisory warns. Does NOT call kill()/emit — returns the decision. */
export function evaluateRunBudget(deps: BudgetDeps, run: RunRow, alreadyWarned: boolean): BudgetCheck;

/** Stateful sweeper: holds the warned-run set; sweep() scans active runs
 *  (state non-terminal AND started_at non-null), applies decisions (kill via
 *  deps.kill, events via deps.log), returns what it did. */
export function makeBudgetEnforcer(deps: BudgetDeps): { sweep(): Promise<BudgetCheck[]> };
```

### 4.2 Pinned semantics

`evaluateRunBudget` decision order (first match wins):
1. **Wall-clock (hard, universal)**: `now() - Date.parse(run.startedAt) > wallClockSecondsPerRun * 1000` → `kill_wall_clock`, `timeout = { name: "wall_clock_budget", limitMs: wallClockSecondsPerRun*1000, runId }`. SPEC §2 maps this to the existing "any active → killed" edge ("kill-budget exceeded (wall-clock)") — the injected `kill` (reapRun) performs it.
2. **Hard cost (only when proven)**: `hardCostUsdPerRun > 0 AND run.priced === true AND run.costUsd != null AND run.costUsd >= hardCostUsdPerRun` AND run still active → `kill_cost` with `timeout = { name: "cost_budget", ... }`. When `priced === false` this branch NEVER fires (advisory-only, §3.12.15) — fail-closed against trusting unproven telemetry.
3. **Advisory tokens**: telemetry present (`tokensIn`/`tokensOut` non-null) and `tokensIn + tokensOut >= advisoryTokensPerRun` and not `alreadyWarned` → `warn_advisory`. Never kills.
4. Else `none`.

`sweep()` applies: kill actions emit event **`run.budget_kill`** `{ runId, taskId, name, limitMs, elapsedMs }` BEFORE calling `deps.kill(runId)` (the audit row must exist even if the kill path crashes); advisory emits **`run.budget_advisory`** once per run id.

Watchdog plug point (pinned): the budget enforcer runs in the SAME poller tick as `evaluateRun` (watchdog), **budget first** — a blown hard budget kills the run before idle/completion heuristics get a vote, and a killed run is then skipped by the watchdog (it is terminal). INTEGRATION owns the poller (one `setInterval` in `main.ts` per §8); neither S3 nor the watchdog starts timers.

Tests (≤5): wall-clock kill fires exactly past the limit (fake clock) and calls injected kill; priced=false never cost-kills even over cap; priced=true + knob kills; advisory warns once (second sweep silent); fresh run → none.

---

## 5. OWNER S1 — `src/scheduler/scheduler.ts` (parallel slots, §3.7.1)

A slot-filling tick: count active coder runs; while `active < maxParallelSlots`, take the next ready task (priority order), ask capacity for headroom, claim+spawn via the injected `startRun`. Fill ALL free slots in ONE pass (localforge #70). The module is testable without a live loop: `tickOnce(deps)` is one pure fill pass with everything injected.

### 5.1 Pinned exports

```ts
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import type { AuthLane } from "../db/columns.ts";

/** Local structural port — duck-compatible with capacity.ts §3.1 (do NOT import it). */
export interface CapacityPort {
	canSpawn(provider: string, requestedLane: AuthLane): Promise<
		{ ok: true; lane: AuthLane } | { ok: false; reason: string }
	>;
}

export interface SpawnPlan {
	provider: string;
	model: string;
	authLane: AuthLane;   // preferred lane; capacity may overflow it (§3.2 step 4)
	prompt: string;
	repoDir: string;
	homeRoot: string;
}

export interface SchedulerDeps {
	handle: DbHandle;
	log: EventLog;
	maxParallelSlots: number;            // config concurrency.maxParallelSlots
	capacity: CapacityPort;
	/** Routing policy lives HERE (injected): provider/model/prompt per task.
	 *  `priorCoderRuns` = this task's coder-run history (most recent last) so the
	 *  policy can apply §3.12.18 reassign (avoid the last failed provider — §6.2).
	 *  Return null to SKIP the task this tick (no qualified provider → fail-closed
	 *  skip, task stays ready). */
	resolveSpawn(task: TaskRow, priorCoderRuns: RunRow[]): Promise<SpawnPlan | null>;
	/** INJECTED claim+spawn — production wires
	 *  `startCoderTask(spawnDeps, { taskId, ...plan, unattended: true, trustedRepo }, probes)`.
	 *  Tests pass a fake. The atomic claim inside it (claimTaskAndCreateRun +
	 *  one_active_run_per_task) is the ONLY claim path — the scheduler itself
	 *  never writes task/run state. */
	startRun(input: SpawnPlan & { taskId: number }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface TickReport {
	activeAtStart: number;
	started: number[];                              // task ids spawned this pass
	skipped: { taskId: number; reason: string }[];  // capacity refusal / null plan / lost race
}

/** Sync helper: runs with kind="coder" AND state NOT IN RUN_TERMINAL_STATES. */
export function countActiveCoderRuns(handle: DbHandle): number;

/** ONE fill pass. Never throws on a per-task failure — it records the skip and
 *  moves on (one failure must not starve the rest of the pass). */
export function tickOnce(deps: SchedulerDeps): Promise<TickReport>;

export interface SchedulerHooks {
	/** Awaited BEFORE the fill pass that a run-failure wake triggers.
	 *  INTEGRATION wires triageFailedRun here (§6). */
	onRunFailed?(runId: number): Promise<void>;
	/** Awaited on run success wake — INTEGRATION wires capacity.observe({kind:"ok"}). */
	onRunSucceeded?(runId: number): Promise<void>;
}

/** Wake-event + poll hybrid (§3.7.2): subscribes to the EventLog (task.state_changed
 *  with payload.to==="ready"; run.state_changed with terminal payload.to), debounces,
 *  and ALSO ticks on an interval safety net. Returns stop() (closes subscription,
 *  clears timers) and kick() (manual debounced wake — also the test surface). */
export function startScheduler(
	deps: SchedulerDeps,
	opts: { intervalMs: number; debounceMs: number; hooks?: SchedulerHooks },
): { stop(): void; kick(): void };
```

### 5.2 Pinned tick algorithm (`tickOnce`)

1. `active = countActiveCoderRuns(handle)`; `free = maxParallelSlots - active`; if `free <= 0` return.
2. Candidates: `listTasks(handle, { state: "ready" })` — already priority-asc, id-asc. Each task is considered AT MOST ONCE per pass (no spinning on a refused task; it stays ready for the next tick).
3. Per candidate, in order, until `free === 0`:
   a. `priorCoderRuns = listRuns(handle, { taskId }).filter(r => r.kind === "coder")`.
   b. `plan = await resolveSpawn(task, priorCoderRuns)`; `null` → skip `no_plan`.
   c. `decision = await capacity.canSpawn(plan.provider, plan.authLane)`; `!ok` → skip with the reason (task remains ready).
   d. `await startRun({ taskId, ...plan, authLane: decision.lane })` — note the lane comes from the capacity decision (overflow may have swapped subscription→api_key). `{ok:false}` (lost claim race / egress refusal / spawn error) → skip with reason; the run-row rollback inside `claimTaskAndCreateRun` already handled cleanup.
   e. `{ok:true}` → `started.push(taskId)`; `free -= 1`. (The new run row is non-terminal, so the next `canSpawn` count already includes it.)
4. Emit ONE event **`scheduler.tick`** `{ activeAtStart, started, skipped }` only when `started.length + skipped.length > 0` (quiet ticks stay out of the log).

### 5.3 Concurrency rules (the never-over-claim invariants)

- **Single-flight**: `startScheduler` guarantees at most ONE `tickOnce` in flight; `kick()`/interval/wake during a pass coalesce into at most one follow-up pass. (In-flight promise + pending flag — same shape as tank `queue_wake`.)
- The scheduler NEVER calls `transitionTask`/`transitionRun`/`createRun` itself — `startRun` (→ `claimTaskAndCreateRun`) is the only claim path, so the DB-level partial unique index is always the final arbiter. A lost race is a logged skip, never a retry inside the same pass.
- `maxParallelSlots` is read once per construction from config (no hot reload in V1).

Tests (≤5, fake everything): fills ALL free slots in one pass; respects `maxParallelSlots`; capacity refusal skips that task but still fills with the next; `startRun` lost-race skip doesn't abort the pass; concurrent `kick()`s coalesce (startRun invocation count proves no over-claim).

---

## 6. OWNER S4 — `src/orchestrator/triage.ts` (failure auto-triage, 5.9)

Classify a terminal-FAILED coder run (exit_reason + transcript tail) → `retry | reassign | human` → apply via existing task edges. The classifier is INJECTED (haiku-class LLM later; a deterministic keyword classifier ships as the default so unattended V1 works with no network). FAIL-CLOSED: unknown signal, classifier crash, or exhausted retries → human. Never an infinite retry loop.

### 6.1 Pinned exports

```ts
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";

export type TriageAction = "retry" | "reassign" | "human";

export interface TriageInput {
	runId: number;
	taskId: number;
	provider: string;
	exitReason: string | null;
	transcriptTail: string;
	attempt: number;      // failed coder runs so far for this task (incl. this one)
	maxRetries: number;
}

export interface TriageDecision { action: TriageAction; reason: string; }

export type TriageClassifier = (input: TriageInput) => Promise<TriageDecision>;

/** Default deterministic classifier (no network — keyword tier, mirrors
 *  watchdog API_ERROR_PATTERNS): rate-limit/overloaded/5xx/connection → retry
 *  (transient, same provider); authentication/invalid_api_key → reassign (this
 *  provider's lane is dead — §3.12.18 within-vendor failback first, different
 *  provider at task re-start); anything unrecognized → human. */
export const defaultClassifier: TriageClassifier;

export interface TriageDeps {
	handle: DbHandle;
	log: EventLog;
	classifier: TriageClassifier;
	/** Same contract as WatchdogDeps.readTranscriptTail — never throws, "" on error. */
	readTranscriptTail(run: RunRow): Promise<string>;
	/** Local structural port to capacity.observe (§3.1) — do NOT import capacity.ts. */
	capacity: { observe(signal: { provider: string; kind: "429" | "auth_limit" | "error"; detail?: string }): Promise<void> };
	maxRetries: number;   // config triage.maxRetries
}

export interface TriageOutcome {
	applied: "requeued" | "needs_human" | "noop";
	decision: TriageDecision;
	attempts: number;
}

export function triageFailedRun(deps: TriageDeps, runId: number): Promise<TriageOutcome>;
```

### 6.2 Pinned algorithm

1. **Preconditions** (any miss → `noop`, fail-closed — never force state): run exists, `run.state === "failed"`, `run.taskId` non-null, task exists, `task.state === "coding"` (the claim is still held; if another actor already moved the task, triage stands down).
2. `attempts` = count of `kind==="coder" && state==="failed"` runs for the task (this run included).
3. **Capacity feedback** (always, before deciding): `kind = signalFromExitReason`-equivalent keyword mapping over `exitReason + tail` → `await deps.capacity.observe({ provider: run.provider, kind, detail: run.exitReason ?? undefined })`. This is the run-failure→capacity seam: quota/auth failures open the pool's circuit even when the task itself retries elsewhere.
4. **Decide**: if `attempts > maxRetries` → forced `{action:"human", reason:"retries_exhausted"}` (classifier not consulted). Else `decision = await classifier(input)` wrapped in try/catch — a throw OR an action outside the three literals → `{action:"human", reason:"classifier_failed"}`.
5. **Apply** (all via existing edges, actor `"triage"`):
   - `retry` / `reassign` → requeue: `transitionTask coding→failed` (coder_failed) → `transitionTask failed→backlog` (demote — bumps priority past the project max so siblings go first) → `recomputeReadiness(handle, log, task.projectId)` (backlog→ready; deps were already merged for it to have been claimed). The SCHEDULER re-claims it on the next wake — triage never spawns. The retry/reassign distinction is realized in routing: `resolveSpawn(task, priorCoderRuns)` (§5.1, INTEGRATION closure) must avoid `priorCoderRuns`'s most recent failed provider when the latest `run.triaged` event says `reassign` (failback ≠ routing, §3.12.18: cross-provider moves happen only at task re-start, never mid-task).
   - `human` → `transitionTask coding→needs_human` (the existing gate_blocked edge; payload actor `"triage"` disambiguates in the audit log).
   - Any lost race during apply → `applied: "noop"` (tolerated, logged via the event below).
6. **Audit**: always emit event **`run.triaged`** `{ runId, taskId, provider, action, reason, attempts, applied }` — this is also what `resolveSpawn` reads for the reassign hint.

Tests (≤5, fake classifier/capacity/transcript): transient failure requeues (failed→backlog→ready) within maxRetries; exhausted attempts → needs_human, classifier never called; classifier throw → needs_human (fail-closed); auth failure calls `capacity.observe` with `auth_limit`; task-already-moved → noop.

---

## 7. Config knobs — INTEGRATION adds to `src/config/config.ts` (builders read by injection only)

| Knob | Default | Consumer |
|---|---|---|
| `concurrency.schedulerIntervalSeconds` | `30` | S1 `startScheduler` intervalMs |
| `concurrency.schedulerDebounceMs` | `250` | S1 `startScheduler` debounceMs |
| `capacity.cooldownSeconds` | `300` | S2 `CapacityDeps` |
| `capacity.overflowToApiKey` | `false` (fail-closed: no silent paid overflow) | S2 |
| `triage.maxRetries` | `2` | S4 |
| `budgets.hardCostUsdPerRun` | `0` (disabled) | S3 |

Existing knobs reused as-is: `concurrency.maxParallelSlots` (S1), `concurrency.perProviderCap` (S2 `ensureProvider` seed cap), `budgets.wallClockSecondsPerRun` + `budgets.advisoryTokensPerRun` (S3).

---

## 8. INTEGRATION wiring (after S1–S4 land; owns main.ts/routes.ts/config.ts/package.json)

1. `package.json` test glob += `src/scheduler`.
2. Boot (`src/server/main.ts`): seed provider rows via `ensureProvider` for each config-enabled provider (`claude-code`, `codex`) with `concurrencyCap: config.concurrency.perProviderCap` — required because `canSpawn` fail-closes on unknown rows.
3. Compose production deps: `capacity` = real `capacity.ts` bound to `{handle, log, now, cooldownSeconds, overflowToApiKey}`; `startRun` = closure over `startCoderTask(spawnDeps /* TmuxLauncher */, { ..., unattended: true, trustedRepo: cfg.sandbox.unattendedUntrustedRepos })` — the egress fail-closed gate stays in the chokepoint; `resolveSpawn` = routing closure (router `selectDriver` + prompt build + `run.triaged` reassign hint per §6.2).
4. Drive: `startScheduler(deps, { intervalMs, debounceMs, hooks: { onRunFailed: (id) => triageFailedRun(triageDeps, id).then(() => {}), onRunSucceeded: (id) => capacity.observe({ provider: getRun(handle,id)!.provider, kind: "ok" }) } })`. ONE additional `setInterval` runs `budgetEnforcer.sweep()` then the watchdog pass (budget first, §4.2) — both intervals live in main.ts only; no module starts its own timer.
5. Optional read-only routes (`GET /scheduler/status`, `GET /providers/capacity`) — INTEGRATION's call; not required for GATE 5.
6. macOS note: all of the above wires real tmux/egress only on Linux; `bun run dev` on macOS keeps the scheduler constructed but `startRun` fail-closes at the sandbox/egress gates by existing design (SandboxDisabledError / EgressInactiveError) — which is exactly the contract: refuse, don't pretend.

## 9. Cross-seam summary (the four interfaces builders code against in parallel)

| Seam | Producer → Consumer | Pinned shape |
|---|---|---|
| scheduler↔capacity | S2 → S1 | `canSpawn(provider, requestedLane) → {ok:true, lane} \| {ok:false, reason}` (§3.1; S1 duck-types it §5.1) |
| run-failure→triage | S1 hook → S4 | `SchedulerHooks.onRunFailed(runId)` → `triageFailedRun(deps, runId)` (§5.1/§6.2) |
| triage→capacity | S4 → S2 | `observe({provider, kind: "429"\|"auth_limit"\|"error", detail?})` (§6.2 step 3); success-side `"ok"` comes from `onRunSucceeded` |
| watchdog→budget | S3 alongside watchdog | same poller tick, budget first; kills via injected `reapRun`; `StepTimeout` reused for the audit payload (§4.2) |
