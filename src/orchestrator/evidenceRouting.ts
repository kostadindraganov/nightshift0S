/**
 * WHY: Evidence-based routing closure (BLUEPRINT §3.7) — a CODE-COMPLETE seam
 * the scheduler's `resolveSpawn` can consult to pick the best-performing provider
 * among the conformance-proven, capacity-available candidates.
 *
 * `chooseProviderByEvidence` reads historical run data via `aggregateProviders`,
 * scores via `scoreProviders`/`bestProvider`, and implements a COLD-START
 * fail-safe: when no candidate has enough evidence, it returns the FIRST candidate
 * rather than null, so the scheduler always has a provider to spawn against when
 * candidates is non-empty.
 *
 * `makeEvidenceResolveSpawn` wraps any base `resolveSpawn` implementation to
 * optionally swap the base plan's provider for the evidence-ranked winner. It is
 * FAIL-CLOSED: any unexpected throw falls back to the base plan unchanged.
 * Pure wrapper — no DB writes, no event emission.
 */

import type { DbHandle } from "../db/client.ts";
import type { TaskRow, RunRow } from "../db/schema.ts";
import type { SpawnPlan } from "../scheduler/scheduler.ts";
import { aggregateProviders } from "../analytics/aggregate.ts";
import { scoreProviders, bestProvider, type RoutingScore } from "../analytics/routing.ts";

// ---------------------------------------------------------------------------
// chooseProviderByEvidence
// ---------------------------------------------------------------------------

export interface EvidenceOpts {
	/** Providers with fewer total runs are treated as cold-start. Default 3. */
	minRuns?: number;
	/** Weight assigned to cost dimension, passed through to scorer. Default 0.10. */
	costWeight?: number;
	/** Only count runs whose startedAt >= sinceTs (ISO8601). */
	sinceTs?: string;
}

export interface EvidenceResult {
	/** Winner, or null only when candidates is empty. */
	provider: string | null;
	/** Full ranked list (all candidates, best-first). */
	scores: RoutingScore[];
	/** Human-readable explanation of the selection. */
	reason: string;
}

/**
 * Pick the best provider among `candidates` using historical run evidence.
 *
 * Flow:
 *   1. `aggregateProviders(handle, { sinceTs })` — DB read (WAL, direct).
 *   2. Filter stats to the candidate set.
 *   3. `scoreProviders` + `bestProvider` over that filtered set.
 *   4. COLD-START fail-safe: if no candidate clears `minRuns`, return
 *      `candidates[0]` with reason "cold_start" (never null for non-empty input).
 *
 * Returns `{ provider: null, scores: [], reason: "no_candidates" }` only when
 * `candidates` is empty.
 */
export function chooseProviderByEvidence(
	handle: DbHandle,
	candidates: string[],
	opts?: EvidenceOpts,
): EvidenceResult {
	if (candidates.length === 0) {
		return { provider: null, scores: [], reason: "no_candidates" };
	}

	const minRuns = opts?.minRuns ?? 3;
	const candidateSet = new Set(candidates);

	// Aggregate all providers, then restrict to the candidate set so scoring
	// is relative within the valid pool (not the global fleet).
	const allStats = aggregateProviders(handle, { sinceTs: opts?.sinceTs });
	const candidateStats = allStats.filter((s) => candidateSet.has(s.provider));

	// Score the candidates. scoreProviders returns best-first.
	const scores = scoreProviders(candidateStats, {
		minRuns,
		costWeight: opts?.costWeight,
	});

	// Filter scores to candidate set (scoreProviders may include extras if stats
	// somehow leaked a non-candidate — defensive).
	const candidateScores = scores.filter((s) => candidateSet.has(s.provider));

	// COLD-START fail-safe: when no candidate has enough evidence, every score is
	// the cold-start neutral 0.5. bestProvider would still return one (the
	// lexicographic first among cold candidates), but we want an explicit reason.
	const warmCandidates = candidateStats.filter((s) => s.total >= minRuns);
	if (warmCandidates.length === 0) {
		// No warm evidence at all — return the first candidate per spec.
		return {
			provider: candidates[0]!,
			scores: candidateScores,
			reason: "cold_start",
		};
	}

	const winner = bestProvider(candidateStats, candidates, {
		minRuns,
		costWeight: opts?.costWeight,
	});

	// bestProvider returns null only when candidateStats is empty (which we
	// already handled above via the warmCandidates.length===0 branch). This
	// branch is a belt-and-braces fallback.
	if (winner === null) {
		return {
			provider: candidates[0]!,
			scores: candidateScores,
			reason: "cold_start",
		};
	}

	const topScore = candidateScores.find((s) => s.provider === winner);
	return {
		provider: winner,
		scores: candidateScores,
		reason: topScore?.reason ?? `evidence: best among ${candidates.join(", ")}`,
	};
}

// ---------------------------------------------------------------------------
// makeEvidenceResolveSpawn
// ---------------------------------------------------------------------------

export interface EvidenceResolveSpawnDeps {
	handle: DbHandle;
	/**
	 * Optional: given a task, return the full candidate set the evidence router
	 * should score. Defaults to `[plan.provider]` (the base plan's own provider)
	 * so the default is a no-op pass-through when only one provider is available.
	 * A host can inject a multi-provider list to enable cross-provider selection.
	 */
	candidatesFor?: (task: TaskRow) => string[];
}

/**
 * Wrap a base `resolveSpawn(task, priorCoderRuns) → SpawnPlan | null` to
 * optionally swap the returned plan's `.provider` for the evidence-ranked winner
 * among `candidatesFor(task)` (default: `[plan.provider]`).
 *
 * Contract:
 * - If base returns null → return null (no plan, scheduler skips as normal).
 * - If base returns a plan → ask `chooseProviderByEvidence` over the candidate set.
 *   - If evidence picks a provider → swap `plan.provider` and return.
 *   - If evidence returns null (empty candidates, shouldn't happen) → return base plan.
 * - FAIL-CLOSED: if ANY step throws → return the base plan unchanged (never propagate).
 *
 * Pure wrapper — no DB writes, no event emission.
 */
export function makeEvidenceResolveSpawn(
	base: (task: TaskRow, priorCoderRuns: RunRow[]) => Promise<SpawnPlan | null>,
	deps: EvidenceResolveSpawnDeps,
): (task: TaskRow, priorCoderRuns: RunRow[]) => Promise<SpawnPlan | null> {
	return async (task: TaskRow, priorCoderRuns: RunRow[]): Promise<SpawnPlan | null> => {
		// Step 1: get the base plan.
		const basePlan = await base(task, priorCoderRuns);
		if (basePlan === null) {
			return null;
		}

		// Step 2: evidence routing — fail-closed on any throw.
		try {
			const candidates = deps.candidatesFor
				? deps.candidatesFor(task)
				: [basePlan.provider];

			const result = chooseProviderByEvidence(deps.handle, candidates);

			if (result.provider === null || result.provider === basePlan.provider) {
				// No change needed (cold_start on single candidate, or same winner).
				return basePlan;
			}

			return { ...basePlan, provider: result.provider };
		} catch {
			// FAIL-CLOSED: any unexpected error → base plan unchanged, never propagate.
			return basePlan;
		}
	};
}
