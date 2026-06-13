/**
 * WHY: Test the makeTiebreakerReviewer factory and its returned closure.
 * The contract: build a prompt via codeReviewJudge, spawn a one-shot with
 * faked spawner (no real I/O), parse the stdout with codeReviewJudge.parse,
 * and return a Verdict. FAIL-CLOSED: any error (bad provider, spawn failure,
 * parse failure) propagates so tiebreaker.ts falls to stricter (block wins).
 */

import { describe, test, expect } from "bun:test";
import type { TiebreakInput, TiebreakDeps } from "../review/tiebreaker.ts";
import type { Verdict } from "../review/verdict.ts";
import type { OneShotSpec, OneShotResult, OneShotSpawner } from "../runs/liveSpawn.ts";
import { OneShotDisabledError, buildOneShotArgv } from "../runs/liveSpawn.ts";
import { makeTiebreakerReviewer } from "../orchestrator/tiebreakerReviewer.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a verdict in the <output>...</output> tags expected by codeReviewJudge.parse. */
function wrapVerdictOutput(verdict: Verdict): string {
	return `<output>\n${JSON.stringify(verdict)}\n</output>`;
}

/** Fake spawner that returns a fixed verdict JSON wrapped in output tags. */
function makeFixedSpawner(verdict: Verdict): OneShotSpawner {
	return async (_spec: OneShotSpec): Promise<OneShotResult> => {
		return {
			stdout: wrapVerdictOutput(verdict),
			exitCode: 0,
		};
	};
}

/** Fake spawner that captures the last spec and returns a verdict wrapped in output tags. */
function makeCapturingSpawner(verdict: Verdict): { spawner: OneShotSpawner; spec: () => OneShotSpec | null } {
	let lastSpec: OneShotSpec | null = null;
	const spawner: OneShotSpawner = async (spec: OneShotSpec): Promise<OneShotResult> => {
		lastSpec = spec;
		return {
			stdout: wrapVerdictOutput(verdict),
			exitCode: 0,
		};
	};
	return { spawner, spec: () => lastSpec };
}

/** Fake spawner that throws a simulated spawn error. */
function makeFailingSpawner(error: Error): OneShotSpawner {
	return async (_spec: OneShotSpec): Promise<OneShotResult> => {
		throw error;
	};
}

/** Fake spawner that returns malformed JSON wrapped in output tags (parse failure). */
function makeBadJsonSpawner(): OneShotSpawner {
	return async (_spec: OneShotSpec): Promise<OneShotResult> => {
		return {
			stdout: "<output>\nnot valid json at all\n</output>",
			exitCode: 0,
		};
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeTiebreakerReviewer", () => {
	// -------------------------------------------------------------------------
	// Test 1: Happy path — valid provider, spawns, parses, returns verdict
	// -------------------------------------------------------------------------
	test("happy path: builds prompt, spawns with correct argv, parses verdict", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "Third model approves",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Fix bug",
			prBody: "Closes #123",
			diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,3 @@\n...",
			round: 1,
		};

		const result = await runTiebreaker(input);

		// Assert the verdict is returned.
		expect(result.verdict).toBe("approved");
		expect(result.summary).toBe("Third model approves");
		expect(result.findings).toEqual([]);

		// Assert the spawner was called with correct argv.
		const s = spec();
		expect(s).not.toBeNull();
		if (s) {
			expect(s.argv).toEqual(["claude", "--print"]);
			expect(s.prompt).toContain("You are a rigorous senior code reviewer");
			expect(s.prompt).toContain("Fix bug"); // PR title in data block
			expect(s.cwd).toBe(process.cwd());
		}
	});

	// -------------------------------------------------------------------------
	// Test 2: Revise verdict with findings
	// -------------------------------------------------------------------------
	test("returns revise verdict with findings", async () => {
		const verdict: Verdict = {
			verdict: "revise",
			summary: "Critical security issue found",
			findings: [
				{
					file: "src/auth.ts",
					line: 42,
					severity: "critical",
					confidence: 0.95,
					description: "SQL injection vulnerability in query builder",
					suggestion: "Use parameterized queries instead",
				},
			],
		};

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "codex",
			spawner: makeFixedSpawner(verdict),
		});

		const input: TiebreakInput = {
			prTitle: "Add user search",
			prBody: "Implements new search endpoint",
			diff: "...",
			round: 1,
		};

		const result = await runTiebreaker(input);

		expect(result.verdict).toBe("revise");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.severity).toBe("critical");
		expect(result.findings[0]!.confidence).toBe(0.95);
	});

	// -------------------------------------------------------------------------
	// Test 3: Unknown provider throws OneShotDisabledError at factory time
	// -------------------------------------------------------------------------
	test("unknown provider throws OneShotDisabledError at factory construction", () => {
		expect(() => {
			makeTiebreakerReviewer({
				tiebreakerProvider: "unknown-provider",
			});
		}).toThrow(OneShotDisabledError);
	});

	// -------------------------------------------------------------------------
	// Test 4: Spawn error (non-zero exit) propagates as throw
	// -------------------------------------------------------------------------
	test("spawn failure (non-zero exit) throws, fail-closed", async () => {
		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			spawner: makeFailingSpawner(new OneShotDisabledError("one-shot exited non-zero (1)")),
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		try {
			await runTiebreaker(input);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as Error).message).toContain("one-shot exited non-zero");
		}
	});

	// -------------------------------------------------------------------------
	// Test 5: Parse failure (bad JSON) throws with sanitized error
	// -------------------------------------------------------------------------
	test("parse failure (malformed JSON) throws, fail-closed", async () => {
		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			spawner: makeBadJsonSpawner(),
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		try {
			await runTiebreaker(input);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as Error).message).toContain("[tiebreakerReviewer] tiebreaker parse failed");
			expect((e as Error).message).toContain("provider=claude-code");
		}
	});

	// -------------------------------------------------------------------------
	// Test 6: Custom home and cwd are passed to spawner
	// -------------------------------------------------------------------------
	test("custom home and cwd are propagated to spawner", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "OK",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			home: "/custom/home",
			cwd: "/custom/cwd",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		await runTiebreaker(input);

		const s = spec();
		expect(s?.home).toBe("/custom/home");
		expect(s?.cwd).toBe("/custom/cwd");
	});

	// -------------------------------------------------------------------------
	// Test 7: Provider auth dir is set correctly for "claude-code"
	// -------------------------------------------------------------------------
	test("provider auth dir computed for claude-code is .claude", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "OK",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			home: "/test/home",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		await runTiebreaker(input);

		const s = spec();
		expect(s?.providerAuthDir).toBe("/test/home/.claude");
	});

	// -------------------------------------------------------------------------
	// Test 8: Provider auth dir computed for "codex" is .codex
	// -------------------------------------------------------------------------
	test("provider auth dir computed for codex is .codex", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "OK",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "codex",
			home: "/test/home",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		await runTiebreaker(input);

		const s = spec();
		expect(s?.providerAuthDir).toBe("/test/home/.codex");
	});

	// -------------------------------------------------------------------------
	// Test 9: homeRoot generates default home under .nightshift/homes
	// -------------------------------------------------------------------------
	test("default homeRoot generates /tiebreaker home", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "OK",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			homeRoot: "/custom/root",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		await runTiebreaker(input);

		const s = spec();
		expect(s?.home).toBe("/custom/root/tiebreaker");
	});

	// -------------------------------------------------------------------------
	// Test 10: Prompt includes round number and all input fields
	// -------------------------------------------------------------------------
	test("prompt includes round number and sanitized input fields", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "OK",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Fix critical bug",
			prBody: "This fixes issue #999",
			diff: "+important fix here",
			round: 2,
		};

		await runTiebreaker(input);

		const s = spec();
		expect(s?.prompt).toContain("Fix critical bug");
		expect(s?.prompt).toContain("This fixes issue #999");
		expect(s?.prompt).toContain("+important fix here");
		expect(s?.prompt).toContain("round 2");
	});

	// -------------------------------------------------------------------------
	// Test 11: Invalid verdict JSON (missing required fields) throws
	// -------------------------------------------------------------------------
	test("invalid verdict structure (missing verdict field) throws", async () => {
		const badSpawner: OneShotSpawner = async (_spec: OneShotSpec): Promise<OneShotResult> => {
			return {
				// Missing verdict field — invalid
				stdout: "<output>\n" + JSON.stringify({ summary: "OK", findings: [] }) + "\n</output>",
				exitCode: 0,
			};
		};

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "claude-code",
			spawner: badSpawner,
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		try {
			await runTiebreaker(input);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as Error).message).toContain("[tiebreakerReviewer] tiebreaker parse failed");
		}
	});

	// -------------------------------------------------------------------------
	// Test 12: Codex provider argv
	// -------------------------------------------------------------------------
	test("codex provider uses correct argv", async () => {
		const verdict: Verdict = {
			verdict: "approved",
			summary: "OK",
			findings: [],
		};

		const { spawner, spec } = makeCapturingSpawner(verdict);

		const runTiebreaker = makeTiebreakerReviewer({
			tiebreakerProvider: "codex",
			spawner,
		});

		const input: TiebreakInput = {
			prTitle: "Test",
			prBody: "",
			diff: "...",
			round: 1,
		};

		await runTiebreaker(input);

		const s = spec();
		expect(s?.argv).toEqual(["codex", "exec", "-"]);
	});
});
