/**
 * WHY: The dispatch seam for §3.11 experiments (6.A4/6.D3). `runExperimentForRun`
 * (experimentRun.ts) drives the hill-climb loop but had NO caller — the scheduler
 * is coder-only and knows nothing about experiment routines. `dispatchExperiment`
 * is that caller: given an experiment routine (+ the task it runs against), it
 * creates an `experiment`-kind run, walks it through the standard run lifecycle
 * (queued → starting → running → finishing → succeeded|failed), and drives the
 * loop in between. The experiment_ledger is keyed by this run id.
 *
 * FAIL-CLOSED: the live side-effects (produceEdit via agent spawn, commit/reset
 * via git, evalRunner on a READ-ONLY checkout OUTSIDE target_paths §3.12.8) are
 * injected via `experimentDeps`. The DEFAULT is `makeFailClosedExperimentDeps`,
 * which refuses every agent/git/eval call with "experiment_host_unavailable" — so
 * on an unwired host the run finalizes as failed rather than pretending. A live
 * host (GATE-5) injects real deps. This module never spawns or touches git itself.
 *
 * Inert until called — no timers, no subscriptions; safe to import anywhere.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import { createRun as defaultCreateRun } from "../runs/runs.ts";
import { transitionRun } from "../runs/transitions.ts";
import { getRoutine } from "../triggers/routines.ts";
import {
	runExperimentForRun,
	makeFailClosedExperimentDeps,
	type ExperimentRunDeps,
	type ExperimentRunResult,
} from "./experimentRun.ts";

export interface ExperimentDispatchDeps {
	handle: DbHandle;
	log: EventLog;
	/**
	 * Live experiment side-effects (produceEdit / commit / evalRunner / reset).
	 * Default: makeFailClosedExperimentDeps — refuses every call so an unwired
	 * host finalizes the run as failed instead of pretending. A live host injects
	 * real deps that honour the read-only-checkout-outside-target_paths invariant.
	 */
	experimentDeps?: ExperimentRunDeps;
	/** Injectable run creator (default createRun); tests pass a fake. */
	createRun?: typeof defaultCreateRun;
}

export interface DispatchExperimentInput {
	routineId: number;
	/** The task the experiment run is attributed to (run.taskId). */
	taskId: number;
	maxIterations?: number;
	until?: string;
}

export type DispatchExperimentResult =
	| { ok: true; runId: number; result: ExperimentRunResult }
	| { ok: false; reason: string };

/**
 * Dispatch ONE experiment loop for `routineId` against `taskId`. Returns the run
 * id and the loop result on success, or `{ ok:false, reason }` when the routine
 * is missing / not an experiment. A loop-level config error finalizes the run as
 * failed and is reported via `result.ok === false` (NOT a top-level reject); an
 * unexpected throw from the engine finalizes the run failed and returns ok:false.
 */
export async function dispatchExperiment(
	deps: ExperimentDispatchDeps,
	input: DispatchExperimentInput,
): Promise<DispatchExperimentResult> {
	const { handle, log } = deps;
	const createRunFn = deps.createRun ?? defaultCreateRun;
	const experimentDeps = deps.experimentDeps ?? makeFailClosedExperimentDeps({ handle, log });

	// 1. Routine must exist and be an experiment.
	const routine = getRoutine(handle, input.routineId);
	if (routine === null) {
		return { ok: false, reason: `routine ${input.routineId} not found` };
	}
	if (routine.kind !== "experiment") {
		return {
			ok: false,
			reason: `routine ${input.routineId} is not an experiment (kind=${routine.kind})`,
		};
	}

	// 2. Create the experiment run (the ledger is keyed by this run id).
	const run = await createRunFn(handle, {
		taskId: input.taskId,
		kind: "experiment",
		provider: "experiment",
		model: "n/a",
		authLane: "subscription",
	});

	// 3. queued → starting → running.
	await transitionRun(handle, log, {
		runId: run.id,
		to: "starting",
		expectedFrom: "queued",
		actor: "experiment_dispatcher",
	});
	await transitionRun(handle, log, {
		runId: run.id,
		to: "running",
		expectedFrom: "starting",
		actor: "experiment_dispatcher",
	});

	// 4. Drive the hill-climb loop. Fail-closed deps refuse on an unwired host;
	// the engine absorbs per-iteration crashes, but a top-level throw is caught.
	let result: ExperimentRunResult;
	try {
		result = await runExperimentForRun(experimentDeps, {
			runId: run.id,
			routine,
			...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
			...(input.until !== undefined ? { until: input.until } : {}),
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		await transitionRun(handle, log, {
			runId: run.id,
			to: "finishing",
			expectedFrom: "running",
			actor: "experiment_dispatcher",
		});
		await transitionRun(handle, log, {
			runId: run.id,
			to: "failed",
			expectedFrom: "finishing",
			actor: "experiment_dispatcher",
			extra: { exitReason: reason },
		});
		return { ok: false, reason };
	}

	// 5. Finalize the run by outcome (running → finishing → succeeded|failed).
	await transitionRun(handle, log, {
		runId: run.id,
		to: "finishing",
		expectedFrom: "running",
		actor: "experiment_dispatcher",
	});
	if (result.ok) {
		await transitionRun(handle, log, {
			runId: run.id,
			to: "succeeded",
			expectedFrom: "finishing",
			actor: "experiment_dispatcher",
		});
	} else {
		await transitionRun(handle, log, {
			runId: run.id,
			to: "failed",
			expectedFrom: "finishing",
			actor: "experiment_dispatcher",
			extra: { exitReason: result.reason },
		});
	}

	return { ok: true, runId: run.id, result };
}
