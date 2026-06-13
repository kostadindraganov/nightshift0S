/**
 * WHY: Evidence-based provider routing scorer (BLUEPRINT §3.7). Pure function —
 * no DB reads, no writes, no side effects. Consumes `ProviderStat[]` (from
 * aggregateProviders) and ranks providers so the scheduler's `resolveSpawn` can
 * make a data-driven choice among the capacity-approved candidates.
 *
 * Scoring model (documented weighting):
 *   score = successWeight * successRate
 *         - durationWeight * normalizedDuration   (lower is better → negate)
 *         - costWeight     * normalizedCost        (lower is better → negate)
 *
 * where:
 *   successWeight  = 1 - costWeight - durationWeight  (residual)
 *   durationWeight = 0.15 (fixed)
 *   costWeight     = opts.costWeight ?? 0.10
 *
 * Normalization: each dimension is min-max scaled across the candidate pool so
 * all three sit in [0,1] and the weights are directly comparable. A provider
 * with < minRuns (default 3) gets a "cold start" score of 0.5 (neutral — above
 * a proven failure, below a proven success) with a note in `reason`.
 *
 * The scorer is deterministic: equal scores sort by provider name (lexicographic).
 * This means the same stats always produce the same ranking, which makes tests
 * reproducible and avoids non-determinism surprises in the scheduler.
 */

import type { ProviderStat } from "./aggregate.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RoutingScore {
	provider: string;
	/** [0,1] — higher is preferred. */
	score: number;
	/** Human-readable explanation of what drove this score. */
	reason: string;
}

export interface ScoringOpts {
	/** Providers with fewer total runs than this are cold-start (neutral score). Default 3. */
	minRuns?: number;
	/** Weight assigned to cost dimension. Must be in [0,0.5]. Default 0.10. */
	costWeight?: number;
}

// ---------------------------------------------------------------------------
// scoreProviders
// ---------------------------------------------------------------------------

const DURATION_WEIGHT = 0.15;
const COLD_START_SCORE = 0.5;

/**
 * Rank providers by evidence. Returns all providers sorted best-first.
 * Cold-start providers (< minRuns) receive a neutral score of 0.5 so they can
 * be tried but never outrank a provider with a proven track record.
 */
export function scoreProviders(stats: ProviderStat[], opts?: ScoringOpts): RoutingScore[] {
	const minRuns = opts?.minRuns ?? 3;
	const costWeight = Math.max(0, Math.min(0.5, opts?.costWeight ?? 0.1));
	const successWeight = 1 - costWeight - DURATION_WEIGHT;

	// Separate into warm (enough data) and cold (insufficient data).
	const warm = stats.filter((s) => s.total >= minRuns);
	const cold = stats.filter((s) => s.total < minRuns);

	// Compute raw scores for warm providers before normalization.
	// We need the range of duration and cost across warm providers to normalize.
	const durations = warm
		.map((s) => s.avgDurationMs ?? 0)
		.filter((d) => d > 0);
	const costs = warm.map((s) => s.totalCostUsd);

	const minDuration = durations.length > 0 ? Math.min(...durations) : 0;
	const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
	const durationRange = maxDuration - minDuration;

	const minCost = costs.length > 0 ? Math.min(...costs) : 0;
	const maxCost = costs.length > 0 ? Math.max(...costs) : 0;
	const costRange = maxCost - minCost;

	/**
	 * Normalize a value into [0,1] relative to the range.
	 * Returns 0 when the range is 0 (all providers equal → no penalty for any).
	 */
	function normalize(value: number, min: number, range: number): number {
		if (range === 0) return 0;
		return (value - min) / range;
	}

	const warmScores: RoutingScore[] = warm.map((s) => {
		const normDuration = normalize(s.avgDurationMs ?? 0, minDuration, durationRange);
		const normCost = normalize(s.totalCostUsd, minCost, costRange);

		const score =
			successWeight * s.successRate - DURATION_WEIGHT * normDuration - costWeight * normCost;

		const parts: string[] = [
			`successRate=${(s.successRate * 100).toFixed(1)}%`,
			`runs=${s.total}`,
		];
		if (s.avgDurationMs !== null) {
			parts.push(`avgDuration=${Math.round(s.avgDurationMs)}ms`);
		}
		if (s.pricedRuns > 0) {
			parts.push(`totalCost=$${s.totalCostUsd.toFixed(4)}`);
		}

		return {
			provider: s.provider,
			score: Math.max(0, Math.min(1, score)),
			reason: `warm: ${parts.join(", ")}`,
		};
	});

	const coldScores: RoutingScore[] = cold.map((s) => ({
		provider: s.provider,
		score: COLD_START_SCORE,
		reason: `cold-start: only ${s.total} run(s), need ${minRuns} for evidence`,
	}));

	// Sort: warm providers (by score desc, then name asc) followed by cold.
	// Cold providers never outrank a warm one, regardless of cold's fixed 0.5.
	// Even if a warm provider scores below 0.5, it has evidence and should rank
	// above a cold start — so we partition rather than merge-sort.
	warmScores.sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider));
	coldScores.sort((a, b) => a.provider.localeCompare(b.provider));

	return [...warmScores, ...coldScores];
}

// ---------------------------------------------------------------------------
// bestProvider
// ---------------------------------------------------------------------------

/**
 * Pick the highest-scoring provider among `candidates`. Candidates are the
 * conformance-proven, capacity-available set the scheduler passes after its own
 * gates. Returns null if no candidate qualifies (has a score entry).
 */
export function bestProvider(
	stats: ProviderStat[],
	candidates: string[],
	opts?: ScoringOpts,
): string | null {
	if (candidates.length === 0) return null;
	const candidateSet = new Set(candidates);
	const scores = scoreProviders(stats, opts).filter((s) => candidateSet.has(s.provider));
	return scores.length > 0 ? (scores[0]!.provider) : null;
}
