/**
 * WHY: V3 three-model tiebreaker (Phase 7). Extends tournament mode: tournament
 * runs TWO reviewers and takes the STRICTER verdict ("revise" beats "approved").
 * That is correct fail-closed behaviour, but a single overcautious reviewer can
 * block a clean PR forever. The tiebreaker keeps the fail-closed default while
 * adding an escape hatch: when the two reviewers DISAGREE on the binary
 * approve/block decision, a THIRD model is consulted as the deciding vote.
 *
 * Decision field: the real Verdict contract (verdict.ts) uses
 * `verdict: "approved" | "revise"` — "revise" is the BLOCK decision. There is no
 * `decision`/`status`/`approved` field; all logic here keys off `.verdict`.
 *
 * FAIL-CLOSED: the tiebreaker is only ever consulted on a genuine disagreement.
 * If no third reviewer is injected, we fall to `stricter` (block wins) — we
 * NEVER default-approve. The third reviewer is an injected dep returning a
 * Verdict, so this module is deterministic and unit-testable with no real LLM
 * (no Date.now()/Math.random() in the pure path).
 *
 * Synthesis (agree case): tournament.ts exports `synthesize`, but it operates on
 * `{ result: ReviewerRunResult; verdict: Verdict }` pairs and returns a
 * `TournamentResult` envelope — not a `Verdict`. This module works purely on two
 * `Verdict`s and returns a `Verdict`, so reusing it would mean fabricating fake
 * ReviewerRunResult shells. Instead we do the same union-dedup merge at the
 * Verdict level (`mergeAgreed`), preserving the agreed decision.
 *
 * Integration: the orchestrator wires the live third-reviewer spawn (see bottom)
 * via `liveSpawn.ts` + `config.tournament.tiebreakerProvider`; this file only
 * owns the pure decision logic and the injectable seam.
 */

import type { Verdict, VerdictFinding } from "./verdict.ts";
import { sanitizeUntrusted } from "./sanitize.ts";

// ---------------------------------------------------------------------------
// Pure decision predicates
// ---------------------------------------------------------------------------

/** True when the two verdicts differ on the binary approve/block decision. */
export function verdictsDisagree(a: Verdict, b: Verdict): boolean {
	return a.verdict !== b.verdict;
}

/**
 * The fail-closed choice: returns whichever verdict BLOCKS ("revise"). If both
 * block, `a` wins (caller is on the disagree path, so at most one blocks in
 * practice; if both agree-block, either is equivalent for the decision).
 */
export function stricter(a: Verdict, b: Verdict): Verdict {
	if (a.verdict === "revise") return a;
	if (b.verdict === "revise") return b;
	// Neither blocks — they agree-approve; return a (decision identical).
	return a;
}

// ---------------------------------------------------------------------------
// Agree-case synthesis (Verdict-level union-dedup; mirrors tournament.ts)
// ---------------------------------------------------------------------------

/** Same dedup key as tournament.ts: file + first 60 chars of description. */
function findingKey(f: VerdictFinding): string {
	return `${f.file}::${f.description.slice(0, 60).toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Merge two AGREED verdicts: union-dedup their findings and preserve the agreed
 * decision (both share `a.verdict`). Pure — no I/O. Used when the reviewers do
 * NOT disagree, so no third vote is needed.
 */
function mergeAgreed(a: Verdict, b: Verdict): Verdict {
	const seen = new Set<string>();
	const findings: VerdictFinding[] = [];
	for (const f of [...a.findings, ...b.findings]) {
		const key = findingKey(f);
		if (!seen.has(key)) {
			seen.add(key);
			findings.push(f);
		}
	}
	return {
		verdict: a.verdict, // identical to b.verdict on the agree path
		summary: a.summary,
		findings,
		...(a.resolutions !== undefined ? { resolutions: a.resolutions } : {}),
	};
}

// ---------------------------------------------------------------------------
// Injectable seam + resolution
// ---------------------------------------------------------------------------

/**
 * Input handed to the deciding-vote reviewer. Mirrors the reviewer-prompt shape
 * (judge.ts CodeReviewContext): the diff + PR context + round. All free-text
 * fields are sanitized before they reach the third reviewer's prompt path.
 */
export interface TiebreakInput {
	prTitle: string;
	prBody: string;
	diff: string;
	round: number;
}

export interface TiebreakDeps {
	/** The third model. Injected; returns a Verdict. Absent ⇒ fail-closed. */
	runTiebreaker?: (input: TiebreakInput) => Promise<Verdict>;
}

/** Strip XML envelope tags + control chars from every untrusted field. */
function sanitizeInput(input: TiebreakInput): TiebreakInput {
	return {
		prTitle: sanitizeUntrusted(input.prTitle),
		prBody: sanitizeUntrusted(input.prBody),
		diff: sanitizeUntrusted(input.diff),
		round: input.round,
	};
}

/**
 * Resolve two reviewer verdicts into one:
 *  - AGREE        → union-dedup synthesis, agreed decision preserved.
 *  - DISAGREE + tiebreaker → the third model's verdict is the deciding vote.
 *  - DISAGREE + no tiebreaker → `stricter` (FAIL-CLOSED: block wins).
 */
export async function resolveWithTiebreak(
	a: Verdict,
	b: Verdict,
	deps: TiebreakDeps,
	input: TiebreakInput,
): Promise<Verdict> {
	if (!verdictsDisagree(a, b)) {
		return mergeAgreed(a, b);
	}
	if (deps.runTiebreaker) {
		return deps.runTiebreaker(sanitizeInput(input));
	}
	return stricter(a, b);
}
