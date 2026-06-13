/**
 * WHY: The §3.11 hill-climbing loop. An experiment iterates an agent edit →
 * commit → eval cycle against a target metric, keeping an attempt only when the
 * metric IMPROVED (per the configured direction) and discarding (git reset)
 * otherwise. This is the NEVER-STOP unattended routine: it iterates until a
 * max-iteration count or an until-time, tracking the best kept metric, and a
 * single failed turn is recorded as a `crash` row and stepped over — never
 * thrown out of the loop.
 *
 * FAIL-CLOSED on every axis:
 *   - The eval ALWAYS runs OUTSIDE the agent workspace (§3.12.8): the CALLER's
 *     injected `evalRunner` is contracted to run `eval_command` on a READ-ONLY
 *     checkout of the just-made commit plus a writable output dir OUTSIDE
 *     target_paths, so the agent cannot tamper with its own score. This module
 *     only orchestrates; it never spawns the eval itself.
 *   - A produceEdit / commit / eval failure (returned {ok:false} OR a thrown
 *     error) is a `crash`: the ledger records it, the branch is NOT advanced,
 *     and the loop continues. A crash can never be mistaken for an improvement.
 *   - `eval_command` is immutable config and validated to live OUTSIDE
 *     target_paths so an edit turn can't rewrite the scorer.
 *
 * Every side effect (clock, edit turn, commit, eval, metric parse, git reset)
 * is injected via ExperimentDeps, so this module runs on macOS with fakes — no
 * real agent, git, or eval subprocess. Ledger writes go through ledger.ts (the
 * sole writer of experiment_ledger).
 */

import type { DbHandle } from "../db/client.ts";
import type { ExperimentStatus } from "../db/columns.ts";
import type { ExperimentLedgerRow } from "../db/schema.ts";
import type { EventLog } from "../events/events.ts";
import { appendLedgerEntry, bestEntry, listLedger } from "./ledger.ts";

// ---------------------------------------------------------------------------
// Config (lives in routines.params_json — §3.11)
// ---------------------------------------------------------------------------

export interface ExperimentMetric {
	name: string;
	direction: "lower" | "higher";
}

export interface ExperimentConfig {
	targetPaths: string[];
	/** Immutable; runs OUTSIDE target_paths (§3.12.8). */
	evalCommand: string;
	metric: ExperimentMetric;
	/** Wall-clock budget per eval attempt (e.g. "10m", "90s"). */
	iterationBudget: string;
	maxIterations?: number;
	/** ISO deadline; the loop stops once now() passes it. */
	until?: string;
	keepRule: "improved";
}

// ---------------------------------------------------------------------------
// parseExperimentConfig — validate the params_json blob
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (value.some((v) => typeof v !== "string" || v.length === 0)) return null;
	return value as string[];
}

/**
 * Parse + validate `routines.params_json` into an ExperimentConfig, or return
 * `{ error }`. Validates: target_paths is a non-empty string[]; eval_command is
 * a non-empty string that does NOT live under any target path (§3.12.8 — the
 * scorer must stay outside the agent's writable surface); metric.direction is
 * lower|higher; keep_rule is "improved". iteration_budget defaults to a sane
 * value when absent so a misconfigured routine still bounds each eval.
 */
export function parseExperimentConfig(
	paramsJson: string | null,
): ExperimentConfig | { error: string } {
	if (paramsJson === null || paramsJson.trim().length === 0) {
		return { error: "params_json is required for an experiment routine" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(paramsJson);
	} catch {
		return { error: "params_json must be valid JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { error: "params_json must be a JSON object" };
	}
	const obj = raw as Record<string, unknown>;

	const targetPaths = asStringArray(obj.target_paths);
	if (targetPaths === null || targetPaths.length === 0) {
		return { error: "target_paths must be a non-empty array of strings" };
	}

	if (typeof obj.eval_command !== "string" || obj.eval_command.trim().length === 0) {
		return { error: "eval_command is required" };
	}
	const evalCommand = obj.eval_command.trim();
	// §3.12.8: the scorer must live OUTSIDE every target path so an edit turn
	// cannot rewrite its own evaluation.
	if (targetPaths.some((p) => evalCommand.includes(p))) {
		return { error: "eval_command must run OUTSIDE target_paths (§3.12.8)" };
	}

	const metricRaw = obj.metric;
	if (typeof metricRaw !== "object" || metricRaw === null || Array.isArray(metricRaw)) {
		return { error: "metric must be an object" };
	}
	const metric = metricRaw as Record<string, unknown>;
	if (typeof metric.name !== "string" || metric.name.length === 0) {
		return { error: "metric.name is required" };
	}
	if (metric.direction !== "lower" && metric.direction !== "higher") {
		return { error: "metric.direction must be 'lower' or 'higher'" };
	}

	if (obj.keep_rule !== "improved") {
		return { error: "keep_rule must be 'improved'" };
	}

	const iterationBudget =
		typeof obj.iteration_budget === "string" && obj.iteration_budget.length > 0
			? obj.iteration_budget
			: "10m";

	const cfg: ExperimentConfig = {
		targetPaths,
		evalCommand,
		metric: { name: metric.name, direction: metric.direction },
		iterationBudget,
		keepRule: "improved",
	};
	if (typeof obj.max_iterations === "number" && Number.isInteger(obj.max_iterations)) {
		cfg.maxIterations = obj.max_iterations;
	}
	if (typeof obj.until === "string" && obj.until.length > 0) {
		cfg.until = obj.until;
	}
	return cfg;
}

// ---------------------------------------------------------------------------
// Duration parsing — iteration_budget string → ms
// ---------------------------------------------------------------------------

/**
 * Parse a wall-clock budget string ("90s", "10m", "1h", or bare seconds "600")
 * into milliseconds. An unparseable value fails closed to a 10-minute budget so
 * an eval is always bounded — an experiment loop must never run an unbounded
 * scorer just because the budget string was malformed.
 */
export function budgetMs(iterationBudget: string): number {
	const FALLBACK_MS = 10 * 60 * 1000;
	const match = /^(\d+)\s*(ms|s|m|h)?$/.exec(iterationBudget.trim());
	if (match === null) return FALLBACK_MS;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return FALLBACK_MS;
	switch (match[2]) {
		case "ms":
			return value;
		case "h":
			return value * 60 * 60 * 1000;
		case "m":
			return value * 60 * 1000;
		case "s":
		case undefined:
		default:
			return value * 1000;
	}
}

// ---------------------------------------------------------------------------
// Injectable side effects
// ---------------------------------------------------------------------------

export interface ExperimentDeps {
	handle: DbHandle;
	log: EventLog;
	/** epoch ms — injectable clock (budget + until-time use this). */
	now(): number;
	/** The agent's edit turn for this iteration. */
	produceEdit(ctx: {
		iteration: number;
		targetPaths: string[];
		lastMetric: number | null;
	}): Promise<{ ok: boolean; reason?: string }>;
	/** Commit the edit; returns the new commit sha on success. */
	commit(ctx: { iteration: number; message: string }): Promise<{ ok: boolean; commitSha?: string }>;
	/**
	 * Run `evalCommand` against the just-made commit under `budgetMs`. §3.12.8:
	 * the caller is contracted to run it on a READ-ONLY checkout of `commitSha`
	 * plus a writable output dir OUTSIDE target_paths — this module never assumes
	 * the workspace and never spawns the eval itself.
	 */
	evalRunner(ctx: {
		commitSha: string | undefined;
		evalCommand: string;
		budgetMs: number;
	}): Promise<{ ok: boolean; stdout: string }>;
	/** Pure metric extraction from eval stdout; null when not found. */
	parseMetric(stdout: string, metricName: string): number | null;
	/** git reset back to the last kept commit on a discard (keep_rule). */
	reset(ctx: { toCommitSha: string | null }): Promise<void>;
}

// ---------------------------------------------------------------------------
// runExperimentIteration — one edit→commit→eval→keep/discard cycle
// ---------------------------------------------------------------------------

export interface IterationResult {
	status: ExperimentStatus;
	metric: number | null;
	commitSha?: string;
	kept: boolean;
}

/**
 * Run exactly one iteration:
 *   produceEdit → commit → evalRunner (under iteration_budget) → parseMetric →
 *   keep (improved vs baseline per direction) advances; else discard (reset to
 *   the baseline commit). Any failure or thrown error in produceEdit / commit /
 *   evalRunner / parseMetric is recorded as `crash` (record-only) and the branch
 *   is NOT advanced. ALWAYS appends exactly one ledger row.
 *
 * `baselineMetric` is the best-kept metric so far (null on the first attempt —
 * the first numeric eval always keeps). `lastKeptCommit` is the sha to reset to
 * on a discard.
 */
export async function runExperimentIteration(
	deps: ExperimentDeps,
	cfg: ExperimentConfig,
	routineRunId: number,
	iteration: number,
	baselineMetric: number | null,
	lastKeptCommit: string | null = null,
): Promise<IterationResult> {
	const direction = cfg.metric.direction;

	// crash helper: record-only, branch reset to the last kept commit, no advance.
	const crash = async (reason: string, commitSha?: string): Promise<IterationResult> => {
		try {
			await deps.reset({ toCommitSha: lastKeptCommit });
		} catch {
			// A failed reset cannot make a crash advance — swallow and record below.
		}
		await appendLedgerEntry(deps.handle, deps.log, {
			routineRunId,
			iteration,
			commitSha: commitSha ?? null,
			metricName: cfg.metric.name,
			metricValue: null,
			status: "crash",
			description: reason,
		});
		return { status: "crash", metric: null, kept: false, ...(commitSha ? { commitSha } : {}) };
	};

	let commitSha: string | undefined;
	let metric: number | null;
	try {
		const edit = await deps.produceEdit({
			iteration,
			targetPaths: cfg.targetPaths,
			lastMetric: baselineMetric,
		});
		if (!edit.ok) return crash(edit.reason ?? "produceEdit failed");

		const committed = await deps.commit({
			iteration,
			message: `experiment iteration ${iteration}`,
		});
		if (!committed.ok) return crash("commit failed");
		commitSha = committed.commitSha;

		const evaluated = await deps.evalRunner({
			commitSha,
			evalCommand: cfg.evalCommand,
			budgetMs: budgetMs(cfg.iterationBudget),
		});
		if (!evaluated.ok) return crash("eval failed", commitSha);

		metric = deps.parseMetric(evaluated.stdout, cfg.metric.name);
		if (metric === null) return crash("metric not found in eval output", commitSha);
	} catch (err) {
		return crash(err instanceof Error ? err.message : String(err), commitSha);
	}

	// Decide keep vs discard against the baseline. First numeric attempt (null
	// baseline) always keeps. Ties do NOT improve → discard.
	const improved =
		baselineMetric === null
			? true
			: direction === "lower"
				? metric < baselineMetric
				: metric > baselineMetric;

	if (improved) {
		await appendLedgerEntry(deps.handle, deps.log, {
			routineRunId,
			iteration,
			commitSha: commitSha ?? null,
			metricName: cfg.metric.name,
			metricValue: metric,
			status: "keep",
			description: `kept: ${cfg.metric.name}=${metric} (${direction})`,
		});
		return { status: "keep", metric, kept: true, ...(commitSha ? { commitSha } : {}) };
	}

	// Discard: reset the branch back to the last kept commit (keep_rule).
	await deps.reset({ toCommitSha: lastKeptCommit });
	await appendLedgerEntry(deps.handle, deps.log, {
		routineRunId,
		iteration,
		commitSha: commitSha ?? null,
		metricName: cfg.metric.name,
		metricValue: metric,
		status: "discard",
		description: `discarded: ${cfg.metric.name}=${metric} not better than ${baselineMetric} (${direction})`,
	});
	return { status: "discard", metric, kept: false, ...(commitSha ? { commitSha } : {}) };
}

// ---------------------------------------------------------------------------
// runExperimentLoop — the NEVER-STOP unattended loop
// ---------------------------------------------------------------------------

export interface ExperimentLoopResult {
	iterations: number;
	best: ExperimentLedgerRow | null;
}

/**
 * Iterate runExperimentIteration until `maxIterations` is reached OR `until`
 * (ISO) has passed (whichever comes first). Tracks the best kept metric as the
 * moving baseline and the reset target. A single crash NEVER throws out of the
 * loop — it is recorded and the next iteration proceeds. Returns the count of
 * iterations attempted and the best kept ledger row.
 *
 * `opts` overrides cfg (the caller may pass an explicit cap/deadline); when both
 * are absent the loop is bounded only by the until-time, so production must
 * supply at least one bound — an experiment with neither would never return.
 */
export async function runExperimentLoop(
	deps: ExperimentDeps,
	cfg: ExperimentConfig,
	routineRunId: number,
	opts: { maxIterations?: number; until?: string } = {},
): Promise<ExperimentLoopResult> {
	const maxIterations = opts.maxIterations ?? cfg.maxIterations;
	const untilMs = (() => {
		const raw = opts.until ?? cfg.until;
		if (raw === undefined) return null;
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? null : parsed;
	})();

	let baselineMetric: number | null = null;
	let lastKeptCommit: string | null = null;
	let iterations = 0;

	for (let iteration = 1; ; iteration++) {
		if (maxIterations !== undefined && iteration > maxIterations) break;
		if (untilMs !== null && deps.now() >= untilMs) break;

		const result = await runExperimentIteration(
			deps,
			cfg,
			routineRunId,
			iteration,
			baselineMetric,
			lastKeptCommit,
		);
		iterations = iteration;

		if (result.kept && result.metric !== null) {
			baselineMetric = result.metric;
			if (result.commitSha !== undefined) lastKeptCommit = result.commitSha;
		}
	}

	// Read the ledger back for the canonical best (matches what the UI shows).
	const rows = listLedger(deps.handle, routineRunId);
	const best = bestEntry(rows, cfg.metric.direction);
	return { iterations, best };
}
