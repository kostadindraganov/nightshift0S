/**
 * WHY: Pure read-only analytics over the runs + tasks tables for the factory
 * dashboard (BLUEPRINT §3.7 performance/efficiency). No writes, no event emission.
 * `aggregateProviders` groups completed runs by provider to surface success rates,
 * average durations, and cumulative cost so the routing scorer and the /analytics
 * endpoint can make evidence-based decisions. `aggregateOverview` gives a quick
 * factory-wide snapshot for the dashboard top row.
 *
 * All queries are direct reads (WAL; no writer queue needed). The injectable
 * `DbHandle` means these run in test with an in-memory DB — no network, no agent.
 */

import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { RUN_TERMINAL_STATES } from "../db/columns.ts";
import { runs, tasks } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProviderStat {
	provider: string;
	total: number;
	succeeded: number;
	failed: number;
	/** succeeded / (succeeded + failed); 0 when no terminal runs yet. */
	successRate: number;
	/** Mean wall-clock ms for runs where both startedAt + endedAt are set; null when none. */
	avgDurationMs: number | null;
	/** Sum of costUsd where priced=true. */
	totalCostUsd: number;
	/** Count of runs where priced=true. */
	pricedRuns: number;
	/** Top exit reasons by frequency, descending, max 5. */
	topExitReasons: { reason: string; count: number }[];
}

export interface FactoryOverview {
	tasksByState: Record<string, number>;
	runsByState: Record<string, number>;
	totalCostUsd: number;
	activeRuns: number;
}

// ---------------------------------------------------------------------------
// aggregateProviders
// ---------------------------------------------------------------------------

/**
 * Group all runs by provider and compute success/failure/cost/duration metrics.
 * Optional filters: `sinceTs` (ISO8601 startedAt lower bound) and `kind` (run kind).
 * Returns one ProviderStat per provider that has at least one run, sorted by
 * provider name for determinism.
 */
export function aggregateProviders(
	handle: DbHandle,
	opts?: { sinceTs?: string; kind?: string },
): ProviderStat[] {
	// Apply kind filter in the DB query; sinceTs is applied in JS (ISO-string
	// lexicographic comparison on startedAt is simpler to keep here than to
	// express as a drizzle text-gte predicate).
	const allRuns = opts?.kind
		? handle.db
				.select()
				.from(runs)
				.where(eq(runs.kind, opts.kind as (typeof runs.kind)["_"]["data"]))
				.all()
		: handle.db.select().from(runs).all();

	// Apply sinceTs filter in JS (avoids drizzle text-comparison complexity).
	const filtered = opts?.sinceTs
		? allRuns.filter((r) => r.startedAt !== null && r.startedAt >= opts.sinceTs!)
		: allRuns;

	// Group by provider.
	const byProvider = new Map<string, typeof filtered>();
	for (const r of filtered) {
		let bucket = byProvider.get(r.provider);
		if (!bucket) {
			bucket = [];
			byProvider.set(r.provider, bucket);
		}
		bucket.push(r);
	}

	const stats: ProviderStat[] = [];

	for (const [provider, provRuns] of byProvider) {
		let succeeded = 0;
		let failed = 0;
		let totalCostUsd = 0;
		let pricedRuns = 0;
		let durationSum = 0;
		let durationCount = 0;
		const exitReasonCounts = new Map<string, number>();

		for (const r of provRuns) {
			if (r.state === "succeeded") succeeded++;
			if (r.state === "failed") failed++;

			if (r.priced && r.costUsd !== null) {
				totalCostUsd += r.costUsd;
				pricedRuns++;
			}

			if (r.startedAt !== null && r.endedAt !== null) {
				const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt);
				if (!Number.isNaN(ms) && ms >= 0) {
					durationSum += ms;
					durationCount++;
				}
			}

			if (r.exitReason !== null) {
				exitReasonCounts.set(r.exitReason, (exitReasonCounts.get(r.exitReason) ?? 0) + 1);
			}
		}

		const terminal = succeeded + failed;
		const successRate = terminal > 0 ? succeeded / terminal : 0;
		const avgDurationMs = durationCount > 0 ? durationSum / durationCount : null;

		// Top 5 exit reasons, most frequent first.
		const topExitReasons = [...exitReasonCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([reason, count]) => ({ reason, count }));

		stats.push({
			provider,
			total: provRuns.length,
			succeeded,
			failed,
			successRate,
			avgDurationMs,
			totalCostUsd,
			pricedRuns,
			topExitReasons,
		});
	}

	// Deterministic output order.
	stats.sort((a, b) => a.provider.localeCompare(b.provider));
	return stats;
}

// ---------------------------------------------------------------------------
// aggregateOverview
// ---------------------------------------------------------------------------

/**
 * Quick factory-wide dashboard numbers: task counts by state, run counts by
 * state, total cost, and the number of non-terminal (active) runs.
 */
export function aggregateOverview(handle: DbHandle): FactoryOverview {
	const allTasks = handle.db.select({ state: tasks.state }).from(tasks).all();
	const tasksByState: Record<string, number> = {};
	for (const { state } of allTasks) {
		tasksByState[state] = (tasksByState[state] ?? 0) + 1;
	}

	const allRuns = handle.db
		.select({ state: runs.state, priced: runs.priced, costUsd: runs.costUsd })
		.from(runs)
		.all();

	const runsByState: Record<string, number> = {};
	let totalCostUsd = 0;
	let activeRuns = 0;

	const terminalSet = new Set<string>(RUN_TERMINAL_STATES);

	for (const { state, priced, costUsd } of allRuns) {
		runsByState[state] = (runsByState[state] ?? 0) + 1;
		if (priced && costUsd !== null) totalCostUsd += costUsd;
		if (!terminalSet.has(state)) activeRuns++;
	}

	return { tasksByState, runsByState, totalCostUsd, activeRuns };
}
