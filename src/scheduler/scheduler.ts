/**
 * WHY: The parallel-slot scheduler (BLUEPRINT §3.7.1) is the heart of the
 * unattended overnight loop. It keeps up to `maxParallelSlots` coder runs in
 * flight by repeatedly filling every free slot in ONE pass: take the next ready
 * task (priority order), ask the capacity pool for headroom, then claim+spawn.
 *
 * The never-over-claim invariant lives at the DB layer: the scheduler NEVER
 * writes task/run state itself — the injected `startRun` routes through
 * `claimTaskAndCreateRun` (+ the `one_active_run_per_task` partial unique index),
 * which is the sole arbiter of a claim. A lost race is a logged skip, never a
 * retry inside the same pass, so two scheduler ticks (or a tick racing a manual
 * spawn) can never double-claim a task.
 *
 * FAIL-CLOSED: capacity refusals, null plans, and lost races all SKIP the task
 * (it stays ready for a later tick) — they never force a spawn and never abort
 * the rest of the pass. Capacity is a local structural port (duck-compatible
 * with src/providers/capacity.ts §3.1) so this module builds and tests with
 * fakes even before capacity.ts exists — no live agent spawn, no network.
 */

import { and, eq, notInArray, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import type { AuthLane, RunState } from "../db/columns.ts";
import { RUN_TERMINAL_STATES } from "../db/columns.ts";
import { runs, events } from "../db/schema.ts";
import { listTasks } from "../tasks/tasks.ts";
import { listRuns } from "../runs/runs.ts";

// ---------------------------------------------------------------------------
// Ports & public types
// ---------------------------------------------------------------------------

/** Local structural port — duck-compatible with capacity.ts §3.1 (do NOT import it). */
export interface CapacityPort {
	canSpawn(provider: string, requestedLane: AuthLane): Promise<
		{ ok: true; lane: AuthLane } | { ok: false; reason: string }
	>;
}

export interface SpawnPlan {
	provider: string;
	model: string;
	authLane: AuthLane; // preferred lane; capacity may overflow it (§3.2 step 4)
	prompt: string;
	repoDir: string;
	homeRoot: string;
	/** Blueprint workflow-skill slugs to mount (config.coder.skillsMount). */
	skillsMount?: string[];
}

export interface SchedulerDeps {
	handle: DbHandle;
	log: EventLog;
	maxParallelSlots: number; // config concurrency.maxParallelSlots
	capacity: CapacityPort;
	/**
	 * Routing policy lives HERE (injected): provider/model/prompt per task.
	 * `priorCoderRuns` = this task's coder-run history (most recent last) so the
	 * policy can apply §3.12.18 reassign (avoid the last failed provider — §6.2).
	 * Return null to SKIP the task this tick (no qualified provider → fail-closed
	 * skip, task stays ready).
	 */
	resolveSpawn(task: TaskRow, priorCoderRuns: RunRow[]): Promise<SpawnPlan | null>;
	/**
	 * INJECTED claim+spawn — production wires
	 * `startCoderTask(spawnDeps, { taskId, ...plan, unattended: true, trustedRepo }, probes)`.
	 * Tests pass a fake. The atomic claim inside it (claimTaskAndCreateRun +
	 * one_active_run_per_task) is the ONLY claim path — the scheduler itself
	 * never writes task/run state.
	 */
	startRun(input: SpawnPlan & { taskId: number }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface TickReport {
	activeAtStart: number;
	started: number[]; // task ids spawned this pass
	skipped: { taskId: number; reason: string }[]; // capacity refusal / null plan / lost race
}

export interface SchedulerHooks {
	/**
	 * Awaited BEFORE the fill pass that a run-failure wake triggers.
	 * INTEGRATION wires triageFailedRun here (§6).
	 */
	onRunFailed?(runId: number): Promise<void>;
	/** Awaited on run success wake — INTEGRATION wires capacity.observe({kind:"ok"}). */
	onRunSucceeded?(runId: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// countActiveCoderRuns
// ---------------------------------------------------------------------------

/** Sync helper: runs with kind="coder" AND state NOT IN RUN_TERMINAL_STATES. */
export function countActiveCoderRuns(handle: DbHandle): number {
	const active = handle.db
		.select({ id: runs.id })
		.from(runs)
		.where(
			and(
				eq(runs.kind, "coder"),
				notInArray(runs.state, [...RUN_TERMINAL_STATES] as RunState[]),
			),
		)
		.all();
	return active.length;
}

// ---------------------------------------------------------------------------
// tickOnce — one slot-filling fill pass (§5.2)
// ---------------------------------------------------------------------------

/**
 * ONE fill pass. Never throws on a per-task failure — it records the skip and
 * moves on (one failure must not starve the rest of the pass).
 */
export async function tickOnce(deps: SchedulerDeps): Promise<TickReport> {
	const { handle, log } = deps;

	const activeAtStart = countActiveCoderRuns(handle);
	const started: number[] = [];
	const skipped: { taskId: number; reason: string }[] = [];

	let free = deps.maxParallelSlots - activeAtStart;
	if (free <= 0) {
		return { activeAtStart, started, skipped };
	}

	// Priority-asc, id-asc already. Each task is considered AT MOST ONCE per pass.
	const candidates = listTasks(handle, { state: "ready" });

	for (const task of candidates) {
		if (free === 0) break;

		const decision = await trySpawnOne(deps, task);
		if (decision.ok) {
			started.push(task.id);
			// The new run row is non-terminal, so the next canSpawn count already
			// includes it — the cap cannot be over-shot within this pass.
			free -= 1;
		} else {
			skipped.push({ taskId: task.id, reason: decision.reason });
		}
	}

	// Emit ONE scheduler.tick event — quiet ticks stay out of the log (§5.2 step 4).
	if (started.length + skipped.length > 0) {
		await log.emitEvent({
			kind: "scheduler.tick",
			payload: { activeAtStart, started, skipped },
		});
	}

	return { activeAtStart, started, skipped };
}

/**
 * Attempt to fill ONE slot with `task`. Pure per-task decision — any failure is
 * returned as `{ok:false, reason}` (never thrown), so the caller keeps filling
 * the rest of the pass. Order mirrors §5.2 step 3 exactly.
 */
async function trySpawnOne(
	deps: SchedulerDeps,
	task: TaskRow,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const { handle } = deps;

	try {
		// a. This task's coder-run history (most recent last) for §3.12.18 reassign.
		const priorCoderRuns = listRuns(handle, { taskId: task.id }).filter(
			(r) => r.kind === "coder",
		);

		// b. Routing policy → plan (null = fail-closed skip, task stays ready).
		const plan = await deps.resolveSpawn(task, priorCoderRuns);
		if (plan === null) {
			return { ok: false, reason: "no_plan" };
		}

		// c. Capacity gate BEFORE the claim — refusal leaves the task ready.
		const decision = await deps.capacity.canSpawn(plan.provider, plan.authLane);
		if (!decision.ok) {
			return { ok: false, reason: decision.reason };
		}

		// d. Claim+spawn. The lane comes from the capacity decision — overflow may
		// have swapped subscription→api_key. A lost claim race / egress refusal /
		// spawn error is a logged skip; claimTaskAndCreateRun already rolled back.
		const result = await deps.startRun({
			...plan,
			authLane: decision.lane,
			taskId: task.id,
		});
		if (!result.ok) {
			return { ok: false, reason: result.reason };
		}

		return { ok: true };
	} catch (err) {
		// FAIL-CLOSED: an unexpected throw from any injected seam skips this task
		// (no spawn happened past the throw) rather than aborting the whole pass.
		return { ok: false, reason: errReason(err) };
	}
}

function errReason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// startScheduler — wake-event + poll hybrid (§3.7.2)
// ---------------------------------------------------------------------------

/**
 * Wake-event + poll hybrid (§3.7.2): subscribes to the EventLog (task.state_changed
 * with payload.to==="ready"; run.state_changed with terminal payload.to), debounces,
 * and ALSO ticks on an interval safety net. Returns stop() (closes subscription,
 * clears timers) and kick() (manual debounced wake — also the test surface).
 *
 * Single-flight (§5.3): at most ONE tickOnce runs at a time; any kick/interval/wake
 * during a pass coalesces into AT MOST one follow-up pass (in-flight promise +
 * pending flag — the tank `queue_wake` shape). This is what proves the scheduler
 * cannot over-claim by running two fill passes concurrently.
 */
export function startScheduler(
	deps: SchedulerDeps,
	opts: { intervalMs: number; debounceMs: number; hooks?: SchedulerHooks },
): { stop(): void; kick(): void } {
	const hooks = opts.hooks ?? {};
	let stopped = false;

	// Single-flight state.
	let inFlight = false;
	let pending = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function runPass(): Promise<void> {
		if (stopped) return;
		if (inFlight) {
			// Coalesce — at most one follow-up pass regardless of how many wakes land.
			pending = true;
			return;
		}
		inFlight = true;
		try {
			do {
				pending = false;
				await tickOnce(deps);
			} while (pending && !stopped);
		} finally {
			inFlight = false;
		}
	}

	function kick(): void {
		if (stopped) return;
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void runPass();
		}, opts.debounceMs);
	}

	// Interval safety net — always fires even if no wake event arrives.
	const interval = setInterval(() => {
		void runPass();
	}, opts.intervalMs);

	// Wake subscription: ready tasks + terminal runs trigger a (debounced) fill.
	//
	// TAIL-ONLY (afterSeq = current max seq): without this the subscription
	// defaults to afterSeq=0 and replays the ENTIRE events table through the
	// triage/capacity hooks at every boot — re-demoting tasks under live runs,
	// re-arming week-old cooldowns, and risking buffer drops of live events.
	// Recovery of in-doubt runs at boot is owned by reconcileOrphansAtBoot, not
	// by event replay; the scheduler only acts on events that arrive AFTER it
	// starts watching.
	const startSeq =
		deps.handle.db
			.select({ max: sql<number>`coalesce(max(${events.seq}), 0)` })
			.from(events)
			.get()?.max ?? 0;
	const subscription = deps.log.subscribe({
		afterSeq: startSeq,
		filter: (e) =>
			e.kind === "task.state_changed" || e.kind === "run.state_changed",
	});

	void (async () => {
		for await (const event of subscription) {
			if (stopped) break;
			const payload = parsePayload(event.payloadJson);

			if (event.kind === "task.state_changed" && payload.to === "ready") {
				kick();
				continue;
			}

			if (event.kind === "run.state_changed" && isTerminalState(payload.to)) {
				// Run-terminal wake: fire the matching hook first, then fill the freed
				// slot. Hooks are fail-closed — a hook throw must not stop the loop.
				//
				// Route EXPLICITLY by terminal state. Only `failed` → triage and only
				// `succeeded` → the success/capacity-ok seam. `killed`/`interrupted`
				// carry NO provider-health signal: a budget kill, claim rollback, or
				// boot-reconciled orphan must NOT be mis-reported as a healthy success
				// (which would close a half_open circuit and clear a real cooldown).
				// They still kick() to refill the freed slot.
				const runId = event.runId ?? null;
				const hook =
					payload.to === "failed"
						? hooks.onRunFailed
						: payload.to === "succeeded"
							? hooks.onRunSucceeded
							: undefined;
				if (runId !== null) {
					await safeHook(hook, runId);
				}
				kick();
			}
		}
	})();

	function stop(): void {
		stopped = true;
		clearInterval(interval);
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		subscription.close();
	}

	return { stop, kick };
}

function isTerminalState(to: string | undefined): boolean {
	return to !== undefined && (RUN_TERMINAL_STATES as readonly string[]).includes(to);
}

/**
 * Parse the event row's `payload_json` (a JSON string column, never an object).
 * The state-change payloads carry `{ from, to, trigger }` (transitions.ts); a
 * corrupt/empty payload yields an empty object so the wake loop treats it as a
 * non-actionable event rather than throwing.
 */
function parsePayload(payloadJson: string): { to?: string; trigger?: string } {
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			return parsed as { to?: string; trigger?: string };
		}
	} catch {
		// Fall through to the empty object — a malformed payload is inert.
	}
	return {};
}

async function safeHook(
	hook: ((runId: number) => Promise<void>) | undefined,
	runId: number,
): Promise<void> {
	if (hook === undefined) return;
	try {
		await hook(runId);
	} catch {
		// FAIL-CLOSED: a hook failure must not crash the wake loop. The next
		// interval tick still fills slots; the hook's own audit captured the error.
	}
}
