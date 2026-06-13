/**
 * WHY: Production driver for the unattended overnight loop (PHASE5A-CONTRACT
 * §8). This is the INTEGRATION wiring that composes the four Batch-A modules —
 * scheduler (S1), capacity (S2), budget (S3), triage (S4) — into the two timers
 * the contract pins:
 *
 *   1. `startScheduler(...)` — wake-event + poll hybrid. Its hooks close the two
 *      run-terminal seams: onRunFailed → `triageFailedRun` (run-failure→triage),
 *      onRunSucceeded → `capacity.observe({kind:"ok"})` (success-side capacity).
 *   2. ONE budget+watchdog poller (`setInterval`) — `budgetEnforcer.sweep()`
 *      runs BEFORE the watchdog pass (budget first, §4.2): a blown hard budget
 *      kills the run via the injected `reapRun` before the idle/completion
 *      heuristics get a vote.
 *
 * GUARDED OFF AT BOOT (the test-suite invariant): `createServer()` NEVER calls
 * this — the loop is started only from `main.ts` under `import.meta.main` (the
 * `bun run dev` path). The whole suite boots `createServer` with a :memory: DB
 * and no loop, so nothing here starts a timer, a tmux session, or an egress
 * probe during tests. Mirrors the prodDeps.ts pattern: wire the side-effect
 * plumbing here, leave the host-specific repo/prompt mapping injected.
 *
 * FAIL-CLOSED ON macOS: `startRun` routes through `startCoderTask(...,
 * {unattended:true})`, whose egress gate throws on an unwired host — the
 * scheduler records that as a logged skip (refuse, don't pretend). The live
 * tmux + egress + bwrap path is exercised only on the Linux VM (GATE 5).
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { NightshiftConfig } from "../config/config.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import { startScheduler, type SchedulerDeps, type SpawnPlan } from "./scheduler.ts";
import {
	canSpawn,
	observe,
	ensureProvider,
	type CapacityDeps,
} from "../providers/capacity.ts";
import { makeBudgetEnforcer, type BudgetDeps } from "../runs/budget.ts";
import { triageFailedRun, defaultClassifier, type TriageDeps } from "../orchestrator/triage.ts";
import { startCoderTask } from "../orchestrator/coder.ts";
import { fileFollowUps } from "../orchestrator/followUps.ts";
import { getTask } from "../tasks/tasks.ts";
import { reapRun, type ReapDeps } from "../runs/reap.ts";
import { evaluateRun, type WatchdogDeps } from "../runs/watchdog.ts";
import { getRun } from "../runs/runs.ts";
import { RUN_TERMINAL_STATES, type RunState } from "../db/columns.ts";
import { runs } from "../db/schema.ts";
import { and, eq, notInArray } from "drizzle-orm";
import { TmuxLauncher } from "../runs/launcher.ts";

export interface SchedulerLoopInput {
	handle: DbHandle;
	log: EventLog;
	config: NightshiftConfig;
	/**
	 * Host-specific routing closure (provider/model/prompt/repo per task). Owned
	 * by the operator — only it knows how a project's repoUrl maps to a local
	 * checkout and which prompt to build. Returns null to SKIP a task this tick.
	 * This is the §3.12.18 reassign seam: it reads the latest `run.triaged`
	 * payload from `priorCoderRuns` to avoid the last failed provider on reassign.
	 */
	resolveSpawn(task: TaskRow, priorCoderRuns: RunRow[]): Promise<SpawnPlan | null>;
	/** Injectable transcript reader for the watchdog/triage (default: live FS reader). */
	readTranscriptTail(run: RunRow): Promise<string>;
	/** Per-run activity / completion clocks for the watchdog pass (host-tracked). */
	runActivity(run: RunRow): { lastActivityMs: number; completionSignalAtMs: number | null };
}

export interface SchedulerLoopHandle {
	stop(): void;
}

/**
 * Compose production deps and start BOTH timers. Returns a `stop()` that closes
 * the scheduler subscription/timers and clears the budget+watchdog poller.
 */
export async function startSchedulerLoop(
	input: SchedulerLoopInput,
): Promise<SchedulerLoopHandle> {
	const { handle, log, config } = input;
	const now = () => Date.now();

	// --- capacity (S2) -------------------------------------------------------
	const capacityDeps: CapacityDeps = {
		handle,
		log,
		now: () => new Date(),
		cooldownSeconds: config.capacity.cooldownSeconds,
		overflowToApiKey: config.capacity.overflowToApiKey,
	};

	// Boot seed: canSpawn fail-closes on unknown rows, so every enabled provider
	// MUST have a row before the first tick (§8.2).
	if (config.providers.claudeCodeEnabled) {
		await ensureProvider(capacityDeps, {
			name: "claude-code",
			kind: "cli",
			authMode: "subscription",
			concurrencyCap: config.concurrency.perProviderCap,
		});
	}
	if (config.providers.codexEnabled) {
		await ensureProvider(capacityDeps, {
			name: "codex",
			kind: "cli",
			authMode: "api_key",
			concurrencyCap: config.concurrency.perProviderCap,
		});
	}

	// --- reap (the injected kill, shared by budget + watchdog) ---------------
	const reapDeps: ReapDeps = { handle, log, launcher: new TmuxLauncher() };

	// --- triage (S4) ---------------------------------------------------------
	// CALL SITE (run-terminal-failed → triage): wired below as the scheduler's
	// onRunFailed hook. The scheduler fires it on every run.state_changed whose
	// payload.to === "failed", BEFORE the fill pass that frees the slot. It is
	// ALSO invoked by the budget kill below (a budget-killed run leaves the task
	// in `coding`; triage requeues/escalates it).
	const triageDeps: TriageDeps = {
		handle,
		log,
		classifier: defaultClassifier,
		readTranscriptTail: input.readTranscriptTail,
		capacity: { observe: (signal) => observe(capacityDeps, signal) },
		maxRetries: config.triage.maxRetries,
	};

	// --- budget (S3) ---------------------------------------------------------
	const budgetDeps: BudgetDeps = {
		handle,
		log,
		now,
		wallClockSecondsPerRun: config.budgets.wallClockSecondsPerRun,
		advisoryTokensPerRun: config.budgets.advisoryTokensPerRun,
		hardCostUsdPerRun: config.budgets.hardCostUsdPerRun,
		// Reap the run (→ killed) AND disposition the task. reapRun ONLY touches the
		// run; without the triage call the task stays in `coding` forever (out of
		// the ready queue, never retried, never escalated) — the core overnight
		// failure mode. triageFailedRun runs the existing retry/needs_human policy
		// over the now-killed run (its precondition accepts `killed`). A lost race
		// inside triage is a tolerated noop.
		kill: async (runId: number) => {
			await reapRun(reapDeps, runId, { reason: "killed" });
			await triageFailedRun(triageDeps, runId);
		},
	};
	const budgetEnforcer = makeBudgetEnforcer(budgetDeps);

	// --- scheduler (S1) ------------------------------------------------------
	const schedulerDeps: SchedulerDeps = {
		handle,
		log,
		maxParallelSlots: config.concurrency.maxParallelSlots,
		capacity: { canSpawn: (provider, lane) => canSpawn(capacityDeps, provider, lane) },
		resolveSpawn: input.resolveSpawn,
		// The egress fail-closed gate lives inside startCoderTask — the chokepoint.
		startRun: async (plan) => {
			try {
				return await startCoderTask(reapDeps, {
					taskId: plan.taskId,
					provider: plan.provider,
					model: plan.model,
					authLane: plan.authLane,
					prompt: plan.prompt,
					repoDir: plan.repoDir,
					homeRoot: plan.homeRoot,
					unattended: true,
					trustedRepo: config.sandbox.unattendedUntrustedRepos,
				});
			} catch (err) {
				// Egress/sandbox refusal (SandboxDisabledError / EgressInactiveError) on
				// an unwired host → logged skip, never a pretend spawn.
				return { ok: false, reason: err instanceof Error ? err.message : String(err) };
			}
		},
	};

	const scheduler = startScheduler(schedulerDeps, {
		intervalMs: config.concurrency.schedulerIntervalSeconds * 1000,
		debounceMs: config.concurrency.schedulerDebounceMs,
		hooks: {
			// run-failure→triage seam.
			onRunFailed: async (runId) => {
				await triageFailedRun(triageDeps, runId);
			},
			// success-side capacity seam (closes a half_open probe). Belt-and-braces:
			// only a genuinely `succeeded` run reports provider health — never a
			// killed/interrupted run that slipped through, so a budget kill can never
			// close a circuit-breaker probe.
			onRunSucceeded: async (runId) => {
				const run = getRun(handle, runId);
				if (run !== null && run.state === "succeeded") {
					await observe(capacityDeps, { provider: run.provider, kind: "ok" });

					// Self-filing follow-ups ("loop feeds itself"): read the worktree's
					// `.nightshift/follow-ups.json` and file each as a draft task. Coder
					// runs only; a missing/empty file is a silent no-op.
					if (
						config.coder.fileFollowUps &&
						run.kind === "coder" &&
						run.worktreePath &&
						run.taskId !== null
					) {
						const parentTaskId = run.taskId;
						const worktreePath = run.worktreePath;
						const task = getTask(handle, parentTaskId);
						if (task !== null && task.projectId !== null) {
							await fileFollowUps(handle, log, {
								projectId: task.projectId,
								parentTaskId,
								worktreePath,
							}).catch((err) => {
								console.warn(`[followUps] run ${runId}:`, err instanceof Error ? err.message : err);
							});
						}
					}
				}
			},
		},
	});

	// --- ONE budget+watchdog poller (budget first, §4.2) ---------------------
	const watchdogDeps: WatchdogDeps = {
		handle,
		log,
		now,
		readTranscriptTail: input.readTranscriptTail,
		idleMs: config.timeouts.watchdogSeconds * 1000,
	};
	const poller = setInterval(() => {
		void (async () => {
			// Budget first: a killed (terminal) run is then skipped by the watchdog.
			await budgetEnforcer.sweep();
			for (const run of activeRunningRuns(handle)) {
				const { lastActivityMs, completionSignalAtMs } = input.runActivity(run);
				await evaluateRun(watchdogDeps, run, lastActivityMs, completionSignalAtMs);
			}
		})();
	}, config.concurrency.schedulerIntervalSeconds * 1000);

	return {
		stop(): void {
			scheduler.stop();
			clearInterval(poller);
		},
	};
}

/** Running coder/reviewer runs eligible for the watchdog pass. */
function activeRunningRuns(handle: DbHandle): RunRow[] {
	return handle.db
		.select()
		.from(runs)
		.where(
			and(
				eq(runs.state, "running" as RunState),
				notInArray(runs.state, [...RUN_TERMINAL_STATES] as RunState[]),
			),
		)
		.all();
}
