/**
 * WHY: Tournament mode (Phase 7 §tournament flag) runs TWO reviewer one-shots
 * in parallel using different providers, then synthesizes the best combined
 * result. This increases review quality without requiring a human: each model
 * has different blind spots, and their union catches more issues.
 *
 * Synthesis strategy: UNION — findings from both reviews are deduplicated by
 * (file, description prefix) and merged. Verdict is the STRICTER of the two
 * ("revise" beats "approved"). This is fail-closed: a single "revise" from
 * either provider blocks auto-merge.
 *
 * No LLM judge call is needed for union synthesis — deduplication is
 * deterministic. A future "LLM judge" variant could re-rank findings if needed.
 *
 * The returned stdout is a reconstructed JSON envelope that the existing
 * engine.ts verdict parse path can consume unchanged (same tag, same schema).
 *
 * Integration: wire in liveSpawn.ts by calling `makeTournamentRunner` instead
 * of `makeRunReviewer` when `config.tournament.enabled === true`.
 */

import type { ReviewDeps, ReviewerRunResult } from "../orchestrator/review.ts";
import type { VerdictFinding, Verdict } from "./verdict.ts";
import { codeReviewJudge } from "./judge.ts";
import {
	verdictsDisagree,
	resolveWithTiebreak,
	type TiebreakDeps,
} from "./tiebreaker.ts";

// ---------------------------------------------------------------------------
// Deduplication key
// ---------------------------------------------------------------------------

function findingKey(f: VerdictFinding): string {
	// Same file + first 60 chars of description = likely duplicate
	return `${f.file}::${f.description.slice(0, 60).toLowerCase().replace(/\s+/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface TournamentResult {
	/** Combined verdict ("revise" if either reviewer said so). */
	verdict: "approved" | "revise";
	/** Union of deduplicated findings, sorted by severity then confidence. */
	findings: VerdictFinding[];
	/** Narrative summary from the stricter reviewer + a tournament note. */
	summary: string;
	/** Which provider produced the winning (stricter) verdict. */
	stricterProvider: string;
	/** Both individual results for logging. */
	primary: ReviewerRunResult;
	challenger: ReviewerRunResult;
}

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0, high: 1, medium: 2, low: 3, nit: 4,
};

function sortFindings(findings: VerdictFinding[]): VerdictFinding[] {
	return [...findings].sort((a, b) => {
		const sa = SEVERITY_ORDER[a.severity] ?? 5;
		const sb = SEVERITY_ORDER[b.severity] ?? 5;
		if (sa !== sb) return sa - sb;
		return b.confidence - a.confidence;
	});
}

/**
 * Merges two parsed verdicts into one synthesized result.
 * Pure — no I/O.
 */
export function synthesize(
	primary: { result: ReviewerRunResult; verdict: Verdict },
	challenger: { result: ReviewerRunResult; verdict: Verdict },
): TournamentResult {
	// Union-dedup findings
	const seen = new Set<string>();
	const merged: VerdictFinding[] = [];
	for (const f of [...primary.verdict.findings, ...challenger.verdict.findings]) {
		const key = findingKey(f);
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(f);
		}
	}
	const findings = sortFindings(merged);

	// Stricter verdict wins
	const combinedVerdict: "approved" | "revise" =
		primary.verdict.verdict === "revise" || challenger.verdict.verdict === "revise"
			? "revise"
			: "approved";

	// Summary from the stricter side; fallback to primary
	const stricterProvider =
		primary.verdict.verdict === "revise"
			? primary.result.provider
			: challenger.verdict.verdict === "revise"
				? challenger.result.provider
				: primary.result.provider;

	const stricterSummary =
		primary.verdict.verdict === "revise"
			? primary.verdict.summary
			: challenger.verdict.verdict === "revise"
				? challenger.verdict.summary
				: primary.verdict.summary;

	const summary =
		`[Tournament: ${primary.result.provider} + ${challenger.result.provider}] ` +
		`${stricterSummary} ` +
		`(${findings.length} combined findings, verdict from ${stricterProvider})`;

	return {
		verdict: combinedVerdict,
		findings,
		summary,
		stricterProvider,
		primary: primary.result,
		challenger: challenger.result,
	};
}

/**
 * Serialise a TournamentResult back to the JSON envelope the engine expects
 * so it can be parsed by `codeReviewJudge.parse(stdout)` downstream.
 */
export function serializeTournamentOutput(t: TournamentResult): string {
	const obj: Verdict = {
		verdict: t.verdict,
		summary: t.summary,
		findings: t.findings,
	};
	const json = JSON.stringify(obj);
	return `<${codeReviewJudge.tag}>${json}</${codeReviewJudge.tag}>`;
}

// ---------------------------------------------------------------------------
// Runner wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps two `runReviewer` callables (primary + challenger) into one that
 * runs them in parallel and returns the synthesized result.
 *
 * If one runner fails, the other's result is used directly (fail-soft per
 * individual runner; tournament does not amplify failures).
 *
 * `primaryRunner` and `challengerRunner` are the closures produced by
 * `makeRunReviewer` with different `reviewerProvider` deps.
 */
export function makeTournamentRunner(
	primaryRunner: ReviewDeps["runReviewer"],
	challengerRunner: ReviewDeps["runReviewer"],
	tiebreakerDeps?: TiebreakDeps,
): ReviewDeps["runReviewer"] {
	return async (input): Promise<ReviewerRunResult> => {
		const [primarySettled, challengerSettled] = await Promise.allSettled([
			primaryRunner(input),
			challengerRunner(input),
		]);

		// Both failed → rethrow primary error (fail-closed)
		if (primarySettled.status === "rejected" && challengerSettled.status === "rejected") {
			throw primarySettled.reason;
		}

		// One failed → use the other's result directly
		if (primarySettled.status === "rejected") {
			return (challengerSettled as PromiseFulfilledResult<ReviewerRunResult>).value;
		}
		if (challengerSettled.status === "rejected") {
			return primarySettled.value;
		}

		const primaryResult = primarySettled.value;
		const challengerResult = challengerSettled.value;

		// Parse both outputs
		const primaryParsed = codeReviewJudge.parse(primaryResult.stdout);
		const challengerParsed = codeReviewJudge.parse(challengerResult.stdout);

		// If one parse failed, fall back to the other
		if (!primaryParsed.ok && !challengerParsed.ok) {
			// Neither parsed — return primary as-is (engine will handle parse failure)
			return primaryResult;
		}
		if (!primaryParsed.ok) return challengerResult;
		if (!challengerParsed.ok) return primaryResult;

		// THREE-MODEL TIEBREAKER (§7.7): when a tiebreaker seam is injected AND the
		// two reviewers disagree on the binary approve/block decision, consult the
		// third model as the deciding vote. resolveWithTiebreak is FAIL-CLOSED: if
		// no runTiebreaker is present (or it throws) it falls to `stricter` (block
		// wins). On AGREE it never runs (we synthesize below as before).
		if (
			tiebreakerDeps &&
			verdictsDisagree(primaryParsed.verdict, challengerParsed.verdict)
		) {
			const resolved = await resolveWithTiebreak(
				primaryParsed.verdict,
				challengerParsed.verdict,
				tiebreakerDeps,
				{
					prTitle: `[ns#${input.task.id}] ${input.task.title}`,
					prBody: input.task.description ?? "",
					diff: input.prompt,
					round: input.round,
				},
			);
			const tbStdout = serializeTournamentOutput({
				verdict: resolved.verdict,
				findings: resolved.findings,
				summary: `[tiebreaker] ${resolved.summary}`,
				stricterProvider: "tiebreaker",
				primary: primaryResult,
				challenger: challengerResult,
			});
			return {
				...primaryResult,
				stdout: tbStdout,
				provider: `tournament(${primaryResult.provider}+${challengerResult.provider}+tiebreaker)`,
			};
		}

		// Both parsed — synthesize
		const t = synthesize(
			{ result: primaryResult, verdict: primaryParsed.verdict },
			{ result: challengerResult, verdict: challengerParsed.verdict },
		);

		const combinedStdout = serializeTournamentOutput(t);

		// Use primaryResult as the base (runId, headSha) — the primary provider
		// "owns" the run row; challenger is a parallel shadow run.
		return {
			...primaryResult,
			stdout: combinedStdout,
			provider: `tournament(${primaryResult.provider}+${challengerResult.provider})`,
		};
	};
}
