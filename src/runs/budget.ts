/**
 * WHY: Run budgets (BLUEPRINT §3.12.15) are the real overnight kill-switch.
 * Hard wall-clock budgets are UNIVERSAL and ENFORCED — a run alive longer than
 * `wallClockSecondsPerRun` is killed unconditionally, which is what keeps an
 * unattended loop from burning a whole night on one stuck agent. Token/$ caps
 * are ADVISORY (warn-only) UNLESS the run has proven telemetry (`run.priced`)
 * AND the operator set a hard cost cap — today's CLI drivers only hydrate
 * tokens/cost at run end, so advisory checks are post-hoc audit warns; the
 * wall-clock kill is the enforcement that matters.
 *
 * FAIL-CLOSED against unproven telemetry: the cost kill NEVER fires when
 * `priced === false` — acting on unconfirmed cost data could kill legitimate
 * work. A missing `started_at` (run never promoted) is treated as zero elapsed.
 *
 * The kill is INJECTED (`deps.kill`, production wires `reapRun(... {reason:
 * "killed"})`): this module NEVER imports reap.ts / launcher.ts / transitions.ts,
 * so it runs on macOS with fakes — no tmux, no real timers, no network. The
 * audit event is emitted BEFORE the kill so the row exists even if the kill
 * path crashes.
 */

import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RunRow } from "../db/schema.ts";
import { RUN_TERMINAL_STATES, type RunState } from "../db/columns.ts";
import { runs } from "../db/schema.ts";
import type { StepTimeout } from "./watchdog.ts"; // reuse the ADR-0001 descriptor

// ---------------------------------------------------------------------------
// Public types (PHASE5A-CONTRACT §4.1 — pinned)
// ---------------------------------------------------------------------------

export interface BudgetDeps {
	handle: DbHandle;
	log: EventLog;
	/** epoch ms — same convention as WatchdogDeps.now */
	now(): number;
	/** config budgets.wallClockSecondsPerRun (3600) */
	wallClockSecondsPerRun: number;
	/** config budgets.advisoryTokensPerRun (200000) */
	advisoryTokensPerRun: number;
	/** config budgets.hardCostUsdPerRun (0 = disabled) */
	hardCostUsdPerRun: number;
	/**
	 * INJECTED kill — production wires `reapRun(reapDeps, runId, {reason:"killed"})`
	 * (tmux kill → 400 ms → run→killed). Tests pass a fake. budget.ts NEVER
	 * imports reap.ts/launcher.ts directly.
	 */
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

// ---------------------------------------------------------------------------
// evaluateRunBudget — pure single-run decision (PHASE5A-CONTRACT §4.2)
// ---------------------------------------------------------------------------

/**
 * Pure single-run evaluation (unit-test surface). Decision order (first match
 * wins): wall-clock (hard, universal) → hard cost (only when proven) → advisory
 * tokens (warn) → none. `alreadyWarned` suppresses a duplicate advisory warn.
 * Does NOT call kill()/emit — returns the decision only.
 */
export function evaluateRunBudget(
	deps: BudgetDeps,
	run: RunRow,
	alreadyWarned: boolean,
): BudgetCheck {
	const runId = run.id;

	// 1. Wall-clock (hard, universal). A missing/corrupt started_at is treated as
	//    zero elapsed — fail-closed: never kill on bad timestamp data.
	const startedMs = run.startedAt === null ? NaN : Date.parse(run.startedAt);
	if (!Number.isNaN(startedMs)) {
		const limitMs = deps.wallClockSecondsPerRun * 1000;
		const elapsedMs = deps.now() - startedMs;
		if (elapsedMs > limitMs) {
			return {
				runId,
				action: "kill_wall_clock",
				timeout: { name: "wall_clock_budget", limitMs, runId },
				reason: `wall_clock_exceeded:${elapsedMs}ms>${limitMs}ms`,
			};
		}
	}

	// 2. Hard cost (ONLY when proven). priced===false NEVER kills (advisory-only,
	//    §3.12.15) — fail-closed against trusting unproven telemetry.
	if (
		deps.hardCostUsdPerRun > 0 &&
		run.priced === true &&
		run.costUsd !== null &&
		run.costUsd >= deps.hardCostUsdPerRun
	) {
		const limitMs = deps.wallClockSecondsPerRun * 1000;
		return {
			runId,
			action: "kill_cost",
			timeout: { name: "cost_budget", limitMs, runId },
			reason: `cost_exceeded:$${run.costUsd}>=$${deps.hardCostUsdPerRun}`,
		};
	}

	// 3. Advisory tokens. Telemetry present and over cap and not already warned.
	if (run.tokensIn !== null && run.tokensOut !== null) {
		const totalTokens = run.tokensIn + run.tokensOut;
		if (totalTokens >= deps.advisoryTokensPerRun && !alreadyWarned) {
			return {
				runId,
				action: "warn_advisory",
				reason: `advisory_tokens:${totalTokens}>=${deps.advisoryTokensPerRun}`,
			};
		}
	}

	// 4. Otherwise nothing to do.
	return { runId, action: "none", reason: "within_budget" };
}

// ---------------------------------------------------------------------------
// makeBudgetEnforcer — stateful sweeper (PHASE5A-CONTRACT §4.2)
// ---------------------------------------------------------------------------

/**
 * Active runs eligible for a budget sweep: state NON-terminal AND started_at
 * non-null (a queued run that never started has no wall-clock to enforce).
 */
function activeStartedRuns(handle: DbHandle): RunRow[] {
	return handle.db
		.select()
		.from(runs)
		.where(
			and(
				notInArray(runs.state, [...RUN_TERMINAL_STATES] as RunState[]),
				isNotNull(runs.startedAt),
			),
		)
		.all();
}

/**
 * Stateful sweeper. Holds the warned-run set so an advisory warn fires at most
 * once per run id. `sweep()` scans active runs, applies each decision (kill via
 * `deps.kill`, events via `deps.log`), and returns what it did.
 *
 * Kill actions emit `run.budget_kill` BEFORE calling `deps.kill(runId)` — the
 * audit row must exist even if the kill path crashes. Advisory emits
 * `run.budget_advisory` once per run id. The watchdog plug point (§4.2):
 * INTEGRATION runs this sweep BEFORE the watchdog pass in the SAME poller tick
 * (budget first), so a blown hard budget kills the run before the idle/
 * completion heuristics get a vote.
 */
export function makeBudgetEnforcer(deps: BudgetDeps): { sweep(): Promise<BudgetCheck[]> } {
	const warned = new Set<number>();

	async function sweep(): Promise<BudgetCheck[]> {
		const results: BudgetCheck[] = [];

		for (const run of activeStartedRuns(deps.handle)) {
			const check = evaluateRunBudget(deps, run, warned.has(run.id));

			if (check.action === "kill_wall_clock" || check.action === "kill_cost") {
				const limitMs = check.timeout?.limitMs ?? 0;
				const startedMs = run.startedAt === null ? NaN : Date.parse(run.startedAt);
				const elapsedMs = Number.isNaN(startedMs) ? 0 : deps.now() - startedMs;
				// Audit BEFORE the kill — the row must survive a crash in deps.kill.
				await deps.log.emitEvent({
					runId: run.id,
					taskId: run.taskId ?? undefined,
					kind: "run.budget_kill",
					payload: {
						runId: run.id,
						taskId: run.taskId ?? null,
						name: check.timeout?.name ?? "budget",
						limitMs,
						elapsedMs,
					},
				});
				await deps.kill(run.id);
			} else if (check.action === "warn_advisory") {
				warned.add(run.id);
				await deps.log.emitEvent({
					runId: run.id,
					taskId: run.taskId ?? undefined,
					kind: "run.budget_advisory",
					payload: {
						runId: run.id,
						taskId: run.taskId ?? null,
						tokensIn: run.tokensIn,
						tokensOut: run.tokensOut,
						cap: deps.advisoryTokensPerRun,
						priced: run.priced,
					},
				});
			}

			if (check.action !== "none") results.push(check);
		}

		return results;
	}

	return { sweep };
}
