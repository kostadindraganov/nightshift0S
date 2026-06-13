/**
 * WHY: Lock the V3 three-model tiebreaker decision logic. The critical property
 * is FAIL-CLOSED: a genuine disagreement with no third vote must fall to the
 * stricter ("revise") verdict — never default-approve. The deciding-vote path is
 * driven by an injected fake (deterministic, no real LLM).
 */

import { test, expect } from "bun:test";
import type { Verdict } from "./verdict.ts";
import {
	verdictsDisagree,
	stricter,
	resolveWithTiebreak,
	type TiebreakInput,
} from "./tiebreaker.ts";

const approve = (summary = "looks good"): Verdict => ({
	verdict: "approved",
	summary,
	findings: [],
});

const block = (summary = "needs work"): Verdict => ({
	verdict: "revise",
	summary,
	findings: [
		{ file: "a.ts", severity: "high", confidence: 0.9, description: "unsafe input" },
	],
});

const INPUT: TiebreakInput = { prTitle: "t", prBody: "b", diff: "+x", round: 1 };

test("agree-approve → approved", async () => {
	const out = await resolveWithTiebreak(approve(), approve(), {}, INPUT);
	expect(out.verdict).toBe("approved");
});

test("agree-block → revise", async () => {
	const out = await resolveWithTiebreak(block(), block(), {}, INPUT);
	expect(out.verdict).toBe("revise");
});

test("disagree + tiebreaker returns approve → approved", async () => {
	const deps = { runTiebreaker: async () => approve("third says ship") };
	const out = await resolveWithTiebreak(approve(), block(), deps, INPUT);
	expect(out.verdict).toBe("approved");
	expect(out.summary).toBe("third says ship");
});

test("disagree + tiebreaker returns block → revise", async () => {
	const deps = { runTiebreaker: async () => block("third says no") };
	const out = await resolveWithTiebreak(approve(), block(), deps, INPUT);
	expect(out.verdict).toBe("revise");
	expect(out.summary).toBe("third says no");
});

test("disagree + NO tiebreaker → stricter (fail-closed, block wins)", async () => {
	const out = await resolveWithTiebreak(approve(), block(), {}, INPUT);
	expect(out.verdict).toBe("revise");
});

test("verdictsDisagree + stricter cover the 4 decision combinations", () => {
	expect(verdictsDisagree(approve(), approve())).toBe(false);
	expect(verdictsDisagree(block(), block())).toBe(false);
	expect(verdictsDisagree(approve(), block())).toBe(true);
	expect(verdictsDisagree(block(), approve())).toBe(true);
	// stricter always yields the blocking verdict on disagreement (both orders).
	expect(stricter(approve(), block()).verdict).toBe("revise");
	expect(stricter(block(), approve()).verdict).toBe("revise");
});
