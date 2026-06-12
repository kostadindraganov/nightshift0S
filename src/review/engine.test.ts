/**
 * WHY: Proves the engine's core invariant — a parse/validation failure can
 * NEVER yield `verdict: "approved"` (PHASE3-CONTRACT §2 invariant 4, §4.6).
 * Scripted producers only; no spawning, no DB.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_REPAIR_RETRIES, runVerdict } from "./engine.ts";
import { codeReviewJudge, type CodeReviewContext } from "./judge.ts";

const ctx: CodeReviewContext = {
	prTitle: "feat: add widget",
	prBody: "Adds the widget.",
	diff: "--- a/src/w.ts\n+++ b/src/w.ts\n@@ -1,1 +1,2 @@\n line\n+added\n",
	round: 1,
	priorFindings: [],
};

describe("runVerdict fail-closed", () => {
	test("malformed stdout → repair prompts issued → exhausted ⇒ {ok:false}, never approved", async () => {
		const calls: { prompt: string; attempt: number }[] = [];
		const result = await runVerdict(codeReviewJudge, ctx, async (prompt, attempt) => {
			calls.push({ prompt, attempt });
			return "no envelope here, just prose";
		});

		expect(result.ok).toBe(false);
		expect((result as { verdict?: unknown }).verdict).toBeUndefined();
		// Exactly 1 initial attempt + DEFAULT_REPAIR_RETRIES repairs.
		expect(calls.length).toBe(1 + DEFAULT_REPAIR_RETRIES);
		expect(calls[0]?.attempt).toBe(0);
		// Repair attempts use the fixed repair template with the judge's tag.
		expect(calls[1]?.prompt).toContain("could not be parsed");
		expect(calls[1]?.prompt).toContain("<output></output>");
	});

	test("valid revise verdict round-trips through a scripted producer", async () => {
		const verdict = {
			verdict: "revise",
			summary: "needs work",
			findings: [
				{
					file: "src/w.ts",
					line: 2,
					severity: "high",
					confidence: 0.9,
					description: "added line is wrong",
					suggestion: "fix it",
				},
			],
			resolutions: [{ finding_id: 1, state: "fixed" }],
		};
		const result = await runVerdict(
			codeReviewJudge,
			ctx,
			async () => `review prose\n<output>${JSON.stringify(verdict)}</output>\n`,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.verdict.verdict).toBe("revise");
		expect(result.verdict.summary).toBe("needs work");
		expect(result.verdict.findings).toHaveLength(1);
		expect(result.verdict.findings[0]?.file).toBe("src/w.ts");
		expect(result.verdict.resolutions).toEqual([{ finding_id: 1, state: "fixed" }]);
	});

	test('schema-invalid "approved" payloads never validate ⇒ never approved', async () => {
		const invalidApprovals = [
			'{"verdict":"approved"}', // missing summary + findings
			'{"verdict":"approved","summary":"","findings":[]}', // empty summary
			'{"verdict":"approved","summary":"ok","findings":[{"file":"","severity":"high","confidence":0.5,"description":"d"}]}', // empty file
			'{"verdict":"approved","summary":"ok","findings":[{"file":"a.ts","severity":"huge","confidence":0.5,"description":"d"}]}', // bad severity
			'{"verdict":"approved","summary":"ok","findings":[],"resolutions":[{"finding_id":1,"state":"open"}]}', // "open" resolution forbidden
		];
		for (const payload of invalidApprovals) {
			const result = await runVerdict(
				codeReviewJudge,
				ctx,
				async () => `<output>${payload}</output>`,
				{ repairRetries: 0 },
			);
			expect(result.ok).toBe(false);
			expect((result as { verdict?: { verdict?: string } }).verdict).toBeUndefined();
		}
	});
});
