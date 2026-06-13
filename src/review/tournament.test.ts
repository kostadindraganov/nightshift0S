/**
 * Unit tests for tournament.ts — pure synthesis logic + runner wrapper.
 * No process spawning, no DB, no I/O.
 *
 * Cases:
 *   synthesize():
 *     1. Union deduplication: same file+description prefix → one entry
 *     2. Unique findings from both sides are kept
 *     3. Stricter verdict: revise beats approved
 *     4. Both approved → combined is approved
 *     5. Summary contains both provider names
 *
 *   serializeTournamentOutput():
 *     6. Output is parseable by codeReviewJudge.parse()
 *
 *   makeTournamentRunner():
 *     7. Both runners succeed → synthesized stdout returned
 *     8. Primary fails → challenger result used
 *     9. Challenger fails → primary result used
 *    10. Both fail → primary error rethrown
 */

import { describe, test, expect } from "bun:test";
import { synthesize, serializeTournamentOutput, makeTournamentRunner } from "./tournament.ts";
import { codeReviewJudge } from "./judge.ts";
import type { ReviewDeps, ReviewerRunResult } from "../orchestrator/review.ts";
import type { Verdict, VerdictFinding } from "./verdict.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(provider: string, stdout: string): ReviewerRunResult {
	return { stdout, runId: 1, headSha: "abc123", provider };
}

function makeVerdict(
	verdict: "approved" | "revise",
	findings: VerdictFinding[],
	summary = "Summary",
): Verdict {
	return { verdict, summary, findings };
}

function makeFinding(file: string, description: string, severity: VerdictFinding["severity"] = "medium"): VerdictFinding {
	return { file, description, severity, confidence: 0.9 };
}

function makeStdout(verdict: Verdict): string {
	return `<output>${JSON.stringify(verdict)}</output>`;
}

// ---------------------------------------------------------------------------
// synthesize()
// ---------------------------------------------------------------------------

describe("synthesize", () => {
	const pResult = makeResult("codex", "");
	const cResult = makeResult("claude-code", "");

	test("deduplicates findings with same file + description prefix", () => {
		const f = makeFinding("src/foo.ts", "Missing null check for user input");
		const primary = { result: pResult, verdict: makeVerdict("approved", [f]) };
		const challenger = { result: cResult, verdict: makeVerdict("approved", [f]) };
		const t = synthesize(primary, challenger);
		expect(t.findings).toHaveLength(1);
	});

	test("keeps unique findings from both sides", () => {
		const f1 = makeFinding("src/a.ts", "Issue A in module alpha");
		const f2 = makeFinding("src/b.ts", "Issue B in module beta");
		const primary = { result: pResult, verdict: makeVerdict("approved", [f1]) };
		const challenger = { result: cResult, verdict: makeVerdict("approved", [f2]) };
		const t = synthesize(primary, challenger);
		expect(t.findings).toHaveLength(2);
	});

	test("revise beats approved (stricter verdict)", () => {
		const primary = { result: pResult, verdict: makeVerdict("approved", []) };
		const challenger = { result: cResult, verdict: makeVerdict("revise", [makeFinding("x.ts", "Critical issue")]) };
		const t = synthesize(primary, challenger);
		expect(t.verdict).toBe("revise");
		expect(t.stricterProvider).toBe("claude-code");
	});

	test("both approved → combined is approved", () => {
		const primary = { result: pResult, verdict: makeVerdict("approved", []) };
		const challenger = { result: cResult, verdict: makeVerdict("approved", []) };
		const t = synthesize(primary, challenger);
		expect(t.verdict).toBe("approved");
	});

	test("both revise → combined is revise (primary as stricter)", () => {
		const primary = { result: pResult, verdict: makeVerdict("revise", [makeFinding("a.ts", "A issue")]) };
		const challenger = { result: cResult, verdict: makeVerdict("revise", [makeFinding("b.ts", "B issue")]) };
		const t = synthesize(primary, challenger);
		expect(t.verdict).toBe("revise");
	});

	test("summary contains both provider names", () => {
		const primary = { result: pResult, verdict: makeVerdict("approved", [], "All good") };
		const challenger = { result: cResult, verdict: makeVerdict("approved", [], "Looks fine") };
		const t = synthesize(primary, challenger);
		expect(t.summary).toContain("codex");
		expect(t.summary).toContain("claude-code");
	});

	test("findings sorted: critical before medium", () => {
		const crit = makeFinding("src/a.ts", "Critical security flaw", "critical");
		const med = makeFinding("src/b.ts", "Minor style issue", "medium");
		const primary = { result: pResult, verdict: makeVerdict("revise", [med]) };
		const challenger = { result: cResult, verdict: makeVerdict("revise", [crit]) };
		const t = synthesize(primary, challenger);
		expect(t.findings.length).toBeGreaterThanOrEqual(1);
		expect(t.findings[0]!.severity).toBe("critical");
	});
});

// ---------------------------------------------------------------------------
// serializeTournamentOutput()
// ---------------------------------------------------------------------------

describe("serializeTournamentOutput", () => {
	test("serialized output is parseable by codeReviewJudge", () => {
		const primary = { result: makeResult("codex", ""), verdict: makeVerdict("approved", []) };
		const challenger = { result: makeResult("claude-code", ""), verdict: makeVerdict("approved", []) };
		const t = synthesize(primary, challenger);
		const stdout = serializeTournamentOutput(t);
		const parsed = codeReviewJudge.parse(stdout);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.verdict.verdict).toBe("approved");
		}
	});

	test("revise verdict survives round-trip through judge.parse", () => {
		const f = makeFinding("src/x.ts", "Security issue in input validation", "critical");
		const primary = { result: makeResult("codex", ""), verdict: makeVerdict("revise", [f], "Security problem") };
		const challenger = { result: makeResult("claude-code", ""), verdict: makeVerdict("approved", []) };
		const t = synthesize(primary, challenger);
		const stdout = serializeTournamentOutput(t);
		const parsed = codeReviewJudge.parse(stdout);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.verdict.verdict).toBe("revise");
			expect(parsed.verdict.findings.length).toBeGreaterThanOrEqual(1);
		}
	});
});

// ---------------------------------------------------------------------------
// makeTournamentRunner()
// ---------------------------------------------------------------------------

describe("makeTournamentRunner", () => {
	function makeRunner(result: ReviewerRunResult): ReviewDeps["runReviewer"] {
		return async (_input) => result;
	}

	function makeFailingRunner(msg: string): ReviewDeps["runReviewer"] {
		return async (_input) => { throw new Error(msg); };
	}

	const fakeInput = { task: { id: 1 }, round: 1, prompt: "p", attempt: 1 } as unknown as Parameters<ReviewDeps["runReviewer"]>[0];

	test("both succeed → returns synthesized stdout parseable by judge", async () => {
		const primaryVerdict = makeVerdict("approved", []);
		const challengerVerdict = makeVerdict("approved", [makeFinding("x.ts", "Unique finding from challenger")]);
		const pRunner = makeRunner(makeResult("codex", makeStdout(primaryVerdict)));
		const cRunner = makeRunner(makeResult("claude-code", makeStdout(challengerVerdict)));
		const runner = makeTournamentRunner(pRunner, cRunner);
		const result = await runner(fakeInput);
		const parsed = codeReviewJudge.parse(result.stdout);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.verdict.findings).toHaveLength(1);
		}
		expect(result.provider).toContain("tournament");
	});

	test("primary fails → challenger result used directly", async () => {
		const challengerResult = makeResult("claude-code", makeStdout(makeVerdict("approved", [])));
		const runner = makeTournamentRunner(
			makeFailingRunner("primary error"),
			makeRunner(challengerResult),
		);
		const result = await runner(fakeInput);
		expect(result.provider).toBe("claude-code");
	});

	test("challenger fails → primary result used directly", async () => {
		const primaryResult = makeResult("codex", makeStdout(makeVerdict("approved", [])));
		const runner = makeTournamentRunner(
			makeRunner(primaryResult),
			makeFailingRunner("challenger error"),
		);
		const result = await runner(fakeInput);
		expect(result.provider).toBe("codex");
	});

	test("both fail → primary error rethrown", async () => {
		const runner = makeTournamentRunner(
			makeFailingRunner("primary error"),
			makeFailingRunner("challenger error"),
		);
		await expect(runner(fakeInput)).rejects.toThrow("primary error");
	});

	test("one provider outputs unparseable stdout → falls back to the parseable one", async () => {
		const goodResult = makeResult("claude-code", makeStdout(makeVerdict("approved", [])));
		const badResult = makeResult("codex", "not-an-xml-envelope");
		const runner = makeTournamentRunner(
			makeRunner(badResult),
			makeRunner(goodResult),
		);
		const result = await runner(fakeInput);
		// Should return the challenger (claude-code) whose output parsed OK
		expect(result.provider).toBe("claude-code");
	});
});
