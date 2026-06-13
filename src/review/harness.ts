/**
 * WHY: The review harness (BLUEPRINT §3.4) is the single conductor that turns a
 * raw diff into a verdict: classify the risk tier, fan the chosen specialist
 * finders out IN PARALLEL, then hand their union to the coordinator. It is the
 * fail-closed seam between the pure classifier/finder/coordinator units and the
 * orchestrator that owns spawning — every side effect (producing finder stdout,
 * verifying findings) is injected via HarnessDeps so this runs on macOS with
 * fakes and no real agent.
 *
 * FAIL-CLOSED INVARIANT: a finder whose stdout doesn't parse contributes NO
 * findings but is NOT fatal — it's recorded in finderStatuses. BUT if EVERY
 * chosen finder failed to parse, we have ZERO signal and MUST NOT approve:
 * the verdict is forced to "block". A review with no evidence is a failed
 * review, never a silent pass.
 *
 * toVerdictShape bridges this harness's {approve|approve_with_comments|block}
 * vocabulary back to the orchestrator's VerdictShape ({approved|revise}) so the
 * existing ping-pong loop (orchestrator/review.ts) consumes it unchanged.
 */

import type { RiskTier } from "../db/columns.ts";
import { classifyRiskTier, coordinatorForTier, reviewersForTier } from "./riskTier.ts";
import { coordinate, type CoordinatorVerdict } from "./coordinator.ts";
import { SPECIALISTS, type FinderFinding, type SpecialistKind } from "./specialists.ts";
import type { Verdict, VerdictFinding } from "./verdict.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessDeps {
	/** Produce one finder's raw stdout for the given prompt. Fake in tests. */
	produceFinder(kind: SpecialistKind, prompt: string): Promise<string>;
	/** Adversarial verifier for low-confidence findings (passed to coordinate). */
	verifyProducer?: (
		f: FinderFinding,
	) => Promise<{ keep: boolean; severity?: import("../db/columns.ts").FindingSeverity }>;
}

export interface HarnessContext {
	prTitle: string;
	prBody: string;
	diff: string;
	round: number; // 1-based
	declaredTier?: RiskTier;
}

export interface FinderStatus {
	kind: SpecialistKind;
	ok: boolean;
	reason?: string;
}

export interface HarnessResult {
	tier: RiskTier;
	verdict: CoordinatorVerdict;
	summary: string;
	findings: FinderFinding[];
	finderStatuses: FinderStatus[];
}

// ---------------------------------------------------------------------------
// runReviewHarness — the pipeline
// ---------------------------------------------------------------------------

/**
 * Pipeline (§3.4): noiseFilter → classifyRiskTier → reviewersForTier → run the
 * chosen finders IN PARALLEL → coordinate. A finder parse-failure is recorded
 * and contributes no findings (not fatal). If ALL chosen finders failed, the
 * verdict is forced to "block" (fail-closed: no evidence ⇒ never approve).
 * The coordinator pass is skipped for trivial tiers, but the SAME approval
 * rubric still runs over the union (coordinate() applies it either way).
 */
export async function runReviewHarness(
	deps: HarnessDeps,
	ctx: HarnessContext,
): Promise<HarnessResult> {
	// classifyRiskTier runs noiseFilter internally, so the tier is sized against
	// the same kept-file view the finders review.
	const classification = classifyRiskTier({ diff: ctx.diff, declaredTier: ctx.declaredTier });
	const tier = classification.tier;
	const kinds = reviewersForTier(tier);

	const finderCtx = {
		prTitle: ctx.prTitle,
		prBody: ctx.prBody,
		diff: ctx.diff,
		round: ctx.round,
	};

	// Fan the chosen finders out in parallel; each parse-failure is captured, not
	// thrown, so one bad finder never sinks the whole review.
	const finderOutcomes = await Promise.all(
		kinds.map(async (kind): Promise<{ status: FinderStatus; findings: FinderFinding[] }> => {
			const judge = SPECIALISTS[kind];
			const prompt = judge.buildPrompt(finderCtx);
			const stdout = await deps.produceFinder(kind, prompt);
			const parsed = judge.parse(stdout);
			if (!parsed.ok) {
				return { status: { kind, ok: false, reason: parsed.reason }, findings: [] };
			}
			return { status: { kind, ok: true }, findings: parsed.findings };
		}),
	);

	const finderStatuses = finderOutcomes.map((o) => o.status);
	const unionFindings = finderOutcomes.flatMap((o) => o.findings);

	// Coordinate (skip the verifier pass for trivial — still applies the rubric
	// over the union inside coordinate()).
	const coordinated = await coordinate({
		findings: unionFindings,
		verifyProducer: coordinatorForTier(tier) ? deps.verifyProducer : undefined,
	});

	// FAIL-CLOSED: every chosen finder failed to parse ⇒ zero evidence ⇒ block.
	const allFailed = finderStatuses.length > 0 && finderStatuses.every((s) => !s.ok);
	if (allFailed) {
		return {
			tier,
			verdict: "block",
			summary: "All specialist reviewers failed to produce parseable output — blocking (no evidence).",
			findings: coordinated.findings,
			finderStatuses,
		};
	}

	return {
		tier,
		verdict: coordinated.verdict,
		summary: coordinated.summary,
		findings: coordinated.findings,
		finderStatuses,
	};
}

// ---------------------------------------------------------------------------
// toVerdictShape — bridge to the orchestrator's verdict vocabulary
// ---------------------------------------------------------------------------

/**
 * Map a HarnessResult to the canonical Verdict shape (verdict.ts) the
 * orchestrator consumes:
 *   approve / approve_with_comments → "approved"
 *   block                          → "revise"
 * Findings are projected to VerdictFinding (drop the specialist `kind`).
 */
export function toVerdictShape(result: HarnessResult): Verdict {
	const verdict: Verdict["verdict"] = result.verdict === "block" ? "revise" : "approved";
	return {
		verdict,
		summary: result.summary,
		findings: result.findings.map((f) => {
			const out: VerdictFinding = {
				file: f.file,
				severity: f.severity,
				confidence: f.confidence,
				description: f.description,
			};
			if (f.line !== undefined) out.line = f.line;
			if (f.suggestion !== undefined) out.suggestion = f.suggestion;
			return out;
		}),
	};
}
