/**
 * WHY: CODE-COMPLETE seam (§3.11) that bridges the run-dispatch layer to the
 * experiment engine. When the scheduler claims a run whose routine has
 * kind="experiment", it hands control here. This module:
 *
 *   1. Parses + validates the routine's params_json via parseExperimentConfig.
 *   2. Translates this hook's injected deps (ExperimentRunDeps) into the
 *      engine's ExperimentDeps shape and calls runExperimentLoop.
 *   3. Returns a typed result: { ok:true, iterations, best } on success or
 *      { ok:false, reason } on a config error (loop-level crashes are absorbed
 *      by the engine and never bubble out here).
 *
 * FAIL-CLOSED DEFAULTS: makeFailClosedExperimentDeps supplies a DEFAULT
 * ExperimentRunDeps whose produceEdit/commit/evalRunner/reset all refuse with
 * "experiment_host_unavailable". This lets the control plane import and
 * reference the hook on any host without a live agent/git/eval surface. A real
 * host (Linux / GATE-5) overrides only the side-effects it can actually supply.
 *
 * NO SECRETS in event payloads or reason strings (§3.12.7). The injected log
 * is passed straight through to the engine; this module emits no events of its
 * own — the engine's ledger writes own that responsibility.
 */

import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RoutineRow } from "../db/schema.ts";
import type { ExperimentLedgerRow } from "../db/schema.ts";
import {
	parseExperimentConfig,
	runExperimentLoop,
	type ExperimentDeps,
} from "../experiment/engine.ts";

// ---------------------------------------------------------------------------
// ExperimentRunDeps — injected side-effects for the live host
// ---------------------------------------------------------------------------

/**
 * The side-effects this hook needs from the host. Shape mirrors ExperimentDeps
 * (engine.ts) but lives here so callers import from one wiring file, not the
 * engine directly. A real host supplies real git / agent / eval; the defaults
 * from makeFailClosedExperimentDeps refuse every call with a clear error.
 */
export interface ExperimentRunDeps {
	handle: DbHandle;
	log: EventLog;
	/** Epoch-ms clock. Injectable so tests control budget/until without sleeping. */
	now(): number;
	/** Ask the coding agent to produce an edit for this iteration. */
	produceEdit(ctx: {
		iteration: number;
		targetPaths: string[];
		lastMetric: number | null;
	}): Promise<{ ok: boolean; reason?: string }>;
	/** Commit the edit; returns the commit sha on success. */
	commit(ctx: { iteration: number; message: string }): Promise<{ ok: boolean; commitSha?: string }>;
	/**
	 * Run eval_command on a READ-ONLY checkout of commitSha, OUTSIDE target_paths
	 * (§3.12.8). The host owns this invariant — this module only passes the call
	 * through to the engine.
	 */
	evalRunner(ctx: {
		commitSha: string | undefined;
		evalCommand: string;
		budgetMs: number;
	}): Promise<{ ok: boolean; stdout: string }>;
	/** Extract the target metric from eval stdout. */
	parseMetric(stdout: string, metricName: string): number | null;
	/** Reset the branch back to toCommitSha after a discard or crash. */
	reset(ctx: { toCommitSha: string | null }): Promise<void>;
}

// ---------------------------------------------------------------------------
// runExperimentForRun — primary entry point
// ---------------------------------------------------------------------------

export type ExperimentRunResult =
	| { ok: true; iterations: number; best: ExperimentLedgerRow | null }
	| { ok: false; reason: string };

/**
 * Parse the routine's params_json and drive the experiment loop for `runId`.
 * Returns `{ ok:false, reason }` immediately on a config validation error so
 * the caller can finishRun with a meaningful failure before the loop starts.
 * On success, returns the iteration count and the best kept ledger row.
 */
export async function runExperimentForRun(
	deps: ExperimentRunDeps,
	input: {
		runId: number;
		routine: RoutineRow;
		maxIterations?: number;
		until?: string;
	},
): Promise<ExperimentRunResult> {
	const cfgOrError = parseExperimentConfig(input.routine.paramsJson ?? null);
	if ("error" in cfgOrError) {
		return { ok: false, reason: cfgOrError.error };
	}
	const cfg = cfgOrError;

	// Build the ExperimentDeps the engine expects from this hook's injected deps.
	const engineDeps: ExperimentDeps = {
		handle: deps.handle,
		log: deps.log,
		now: deps.now,
		produceEdit: deps.produceEdit,
		commit: deps.commit,
		evalRunner: deps.evalRunner,
		parseMetric: deps.parseMetric,
		reset: deps.reset,
	};

	const loopResult = await runExperimentLoop(engineDeps, cfg, input.runId, {
		maxIterations: input.maxIterations,
		until: input.until,
	});

	return { ok: true, iterations: loopResult.iterations, best: loopResult.best };
}

// ---------------------------------------------------------------------------
// makeFailClosedExperimentDeps — safe defaults for unwired hosts
// ---------------------------------------------------------------------------

/**
 * Build an ExperimentRunDeps whose agent/git/eval side-effects all refuse with
 * "experiment_host_unavailable". The control plane can import this hook on any
 * host without a live agent surface; a real host overrides only the deps it can
 * actually fulfill. Fail-closed: no call ever silently succeeds or pretends.
 */
export function makeFailClosedExperimentDeps(base: {
	handle: DbHandle;
	log: EventLog;
	now?: () => number;
}): ExperimentRunDeps {
	return {
		handle: base.handle,
		log: base.log,
		now: base.now ?? (() => Date.now()),

		produceEdit: (_ctx) => {
			// Fail-closed: refuse rather than pretend the edit succeeded.
			return Promise.resolve({ ok: false, reason: "experiment_host_unavailable" });
		},

		commit: (_ctx) => {
			return Promise.reject(
				new Error("experiment_host_unavailable: commit is not wired on this host"),
			);
		},

		evalRunner: (_ctx) => {
			return Promise.reject(
				new Error("experiment_host_unavailable: evalRunner is not wired on this host"),
			);
		},

		parseMetric: (_stdout, _name) => {
			throw new Error("experiment_host_unavailable: parseMetric is not wired on this host");
		},

		reset: (_ctx) => {
			return Promise.reject(
				new Error("experiment_host_unavailable: reset is not wired on this host"),
			);
		},
	};
}
