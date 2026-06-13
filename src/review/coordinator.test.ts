/**
 * Tests for coordinator (UNIT 5.6a).
 *
 * Hermetic test harness (≤10 meaningful cases):
 *   - Dedup by (file,line,normalized-description).
 *   - Merge near-duplicates keeping highest severity/confidence.
 *   - Adversarial verify low-confidence (<0.6) findings.
 *   - Approval-biased rubric: block IFF critical OR (high AND confidence≥0.6);
 *     else approve_with_comments if any survive, else approve.
 *   - Pure & deterministic given verifyProducer.
 */

import { describe, expect, test } from "bun:test";
import { coordinate, type CoordinatorInput, type CoordinatorResult } from "./coordinator.ts";
import type { FinderFinding } from "./specialists.ts";

// ---------------------------------------------------------------------------
// 1. Dedup by (file,line,normalized-description) + merge highest severity/confidence
// ---------------------------------------------------------------------------

describe("coordinate: dedup + merge", () => {
	test("identical findings deduplicated", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				line: 10,
				severity: "high",
				confidence: 0.9,
				description: "Off-by-one error",
			},
			{
				kind: "security",
				file: "src/foo.ts",
				line: 10,
				severity: "high",
				confidence: 0.85,
				description: "Off-by-one error",
			},
		];
		const result = await coordinate({ findings });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.description).toBe("Off-by-one error");
	});

	test("merge keeps highest severity", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				line: 10,
				severity: "medium",
				confidence: 0.9,
				description: "off-by-one error",
			},
			{
				kind: "security",
				file: "src/foo.ts",
				line: 10,
				severity: "critical",
				confidence: 0.5,
				description: "Off-by-one error", // different casing/whitespace
			},
		];
		const result = await coordinate({ findings });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.severity).toBe("critical");
		expect(result.findings[0]?.confidence).toBe(0.9); // higher confidence preserved
	});

	test("merge keeps highest confidence (severity equal)", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				line: 5,
				severity: "high",
				confidence: 0.7,
				description: "Logic bug",
			},
			{
				kind: "quality",
				file: "src/foo.ts",
				line: 5,
				severity: "high",
				confidence: 0.95,
				description: "logic bug",
			},
		];
		const result = await coordinate({ findings });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.confidence).toBe(0.95);
	});

	test("no line number match respected: file+nil vs file+5 are different", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.9,
				description: "bug here",
			},
			{
				kind: "security",
				file: "src/foo.ts",
				line: 5,
				severity: "high",
				confidence: 0.8,
				description: "bug here",
			},
		];
		const result = await coordinate({ findings });
		expect(result.findings).toHaveLength(2);
	});

	test("whitespace + case collapse in description match", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.9,
				description: "   Off-By-One   Error  ",
			},
			{
				kind: "quality",
				file: "src/foo.ts",
				severity: "medium",
				confidence: 0.8,
				description: "off-by-one error",
			},
		];
		const result = await coordinate({ findings });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.severity).toBe("high");
	});

	test("preserves suggestion from merged findings", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.9,
				description: "bug",
				suggestion: "fix it like this",
			},
			{
				kind: "quality",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.8,
				description: "bug",
			},
		];
		const result = await coordinate({ findings });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.suggestion).toBe("fix it like this");
	});
});

// ---------------------------------------------------------------------------
// 2. Adversarial verification of low-confidence findings (< 0.6)
// ---------------------------------------------------------------------------

describe("coordinate: adversarial verify low-confidence", () => {
	test("high-confidence finding (≥0.6) passes through untouched", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.95,
				description: "real bug",
			},
		];
		const verifyProducer = async () => ({
			keep: false, // Should not be called for high-confidence findings
		});
		const result = await coordinate({ findings, verifyProducer });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.description).toBe("real bug");
	});

	test("low-confidence finding verified; keep=true passes through", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.5,
				description: "uncertain bug",
			},
		];
		const verifyProducer = async (f: FinderFinding) => ({
			keep: true,
		});
		const result = await coordinate({ findings, verifyProducer });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.description).toBe("uncertain bug");
	});

	test("low-confidence finding rejected by verifier (keep=false) is dropped", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.3,
				description: "weak guess",
			},
		];
		const verifyProducer = async () => ({ keep: false });
		const result = await coordinate({ findings, verifyProducer });
		expect(result.findings).toHaveLength(0);
	});

	test("verifier can downgrade severity (never escalate)", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "critical",
				confidence: 0.4,
				description: "uncertain critical",
			},
		];
		const verifyProducer = async () => ({
			keep: true,
			severity: "medium" as const,
		});
		const result = await coordinate({ findings, verifyProducer });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.severity).toBe("medium");
	});

	test("verifier upgrade is ignored (no escalation)", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "low",
				confidence: 0.4,
				description: "uncertain low",
			},
		];
		const verifyProducer = async () => ({
			keep: true,
			severity: "critical" as const, // Attempt to escalate
		});
		const result = await coordinate({ findings, verifyProducer });
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.severity).toBe("low"); // Original severity kept
	});

	test("verifier not provided skips verification (all findings pass)", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.3, // Low confidence
				description: "weak guess",
			},
		];
		const result = await coordinate({ findings }); // No verifyProducer
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.description).toBe("weak guess");
	});

	test("mix of verified + unverified: low-confidence tested, high-confidence skipped", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				line: 1,
				severity: "high",
				confidence: 0.95,
				description: "certain",
			},
			{
				kind: "quality",
				file: "src/foo.ts",
				line: 2,
				severity: "high",
				confidence: 0.4,
				description: "uncertain",
			},
		];
		const verifierCalls: FinderFinding[] = [];
		const verifyProducer = async (f: FinderFinding) => {
			verifierCalls.push(f);
			return { keep: true };
		};
		const result = await coordinate({ findings, verifyProducer });
		expect(verifierCalls).toHaveLength(1);
		expect(verifierCalls[0]?.description).toBe("uncertain");
		expect(result.findings).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 3. Approval-biased rubric: verdict decision
// ---------------------------------------------------------------------------

describe("coordinate: approval-biased verdict rubric", () => {
	test("critical finding → block", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "critical",
				confidence: 0.5,
				description: "critical bug",
			},
		];
		const result = await coordinate({ findings });
		expect(result.verdict).toBe("block");
		expect(result.summary).toContain("Blocking");
	});

	test("high finding with confidence ≥0.6 → block", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.6,
				description: "confident high",
			},
		];
		const result = await coordinate({ findings });
		expect(result.verdict).toBe("block");
	});

	test("high finding with confidence <0.6 → approve_with_comments (not block)", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.59,
				description: "uncertain high",
			},
		];
		const result = await coordinate({ findings });
		expect(result.verdict).toBe("approve_with_comments");
	});

	test("medium/low/nit findings → approve_with_comments", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "quality",
				file: "src/foo.ts",
				severity: "medium",
				confidence: 0.9,
				description: "medium issue",
			},
			{
				kind: "quality",
				file: "src/bar.ts",
				severity: "low",
				confidence: 0.8,
				description: "low issue",
			},
			{
				kind: "quality",
				file: "src/baz.ts",
				severity: "nit",
				confidence: 0.7,
				description: "nit",
			},
		];
		const result = await coordinate({ findings });
		expect(result.verdict).toBe("approve_with_comments");
		expect(result.summary).toContain("Approved with comments");
	});

	test("no findings → approve", async () => {
		const result = await coordinate({ findings: [] });
		expect(result.verdict).toBe("approve");
		expect(result.summary).toContain("No findings");
	});

	test("all findings dropped by verifier → approve", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.3,
				description: "weak",
			},
		];
		const verifyProducer = async () => ({ keep: false });
		const result = await coordinate({ findings, verifyProducer });
		expect(result.verdict).toBe("approve");
		expect(result.findings).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 4. Summary generation
// ---------------------------------------------------------------------------

describe("coordinate: summary generation", () => {
	test("empty findings → 'No findings survived'", async () => {
		const result = await coordinate({ findings: [] });
		expect(result.summary).toBe("No findings survived coordination — approved.");
	});

	test("approve_with_comments summary lists severities", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.5,
				description: "one high",
			},
			{
				kind: "quality",
				file: "src/bar.ts",
				severity: "medium",
				confidence: 0.8,
				description: "one medium",
			},
			{
				kind: "quality",
				file: "src/baz.ts",
				severity: "nit",
				confidence: 0.9,
				description: "one nit",
			},
		];
		const result = await coordinate({ findings });
		expect(result.summary).toContain("Approved with comments");
		expect(result.summary).toContain("1 high");
		expect(result.summary).toContain("1 medium");
		expect(result.summary).toContain("1 nit");
	});

	test("block summary lists severities", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "critical",
				confidence: 0.9,
				description: "one critical",
			},
			{
				kind: "security",
				file: "src/bar.ts",
				severity: "high",
				confidence: 0.8,
				description: "one high",
			},
		];
		const result = await coordinate({ findings });
		expect(result.summary).toContain("Blocking");
		expect(result.summary).toContain("1 critical");
		expect(result.summary).toContain("1 high");
	});
});

// ---------------------------------------------------------------------------
// 5. Complex scenario: dedup + verify + verdict combined
// ---------------------------------------------------------------------------

describe("coordinate: verifier threshold + verdict coupling", () => {
	test("confidence exactly 0.6 is NOT verified (threshold is < 0.6, not <=)", async () => {
		const findings: FinderFinding[] = [
			{
				kind: "correctness",
				file: "src/foo.ts",
				severity: "high",
				confidence: 0.6,
				description: "boundary",
			},
		];
		let called = false;
		const verifyProducer = async () => {
			called = true;
			return { keep: false };
		};
		const result = await coordinate({ findings, verifyProducer });
		expect(called).toBe(false); // 0.6 is high-confidence → passes through untouched
		expect(result.findings).toHaveLength(1);
		// high + 0.6 is a blocking finding under the rubric.
		expect(result.verdict).toBe("block");
	});

	test("verifier downgrade of a low-confidence critical FLIPS block → approve_with_comments", async () => {
		// The downgrade must affect the VERDICT, not just the stored severity:
		// a single uncertain 'critical' would block, but once softened to 'low'
		// the rubric must approve_with_comments. Proves the verifier's prune/soften
		// power is wired into decideVerdict.
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "critical",
				confidence: 0.4,
				description: "uncertain critical",
			},
		];
		const verifyProducer = async () => ({ keep: true, severity: "low" as const });
		const result = await coordinate({ findings, verifyProducer });
		expect(result.findings[0]?.severity).toBe("low");
		expect(result.verdict).toBe("approve_with_comments");
	});

	test("approval-bias: a pile of medium+low+nit can NEVER block (only critical/high blocks)", async () => {
		const findings: FinderFinding[] = Array.from({ length: 20 }, (_, i) => ({
			kind: "quality" as const,
			file: `src/f${i}.ts`,
			severity: (i % 3 === 0 ? "medium" : i % 3 === 1 ? "low" : "nit") as
				| "medium"
				| "low"
				| "nit",
			confidence: 0.99,
			description: `issue ${i}`,
		}));
		const result = await coordinate({ findings });
		expect(result.verdict).toBe("approve_with_comments");
	});

	test("a low-confidence CRITICAL survives unverified → still blocks (rubric ignores confidence for critical)", async () => {
		// Without a verifier, a critical at any confidence blocks. This is the
		// fail-closed half of the bias: critical is never softened by low confidence.
		const findings: FinderFinding[] = [
			{
				kind: "security",
				file: "src/foo.ts",
				severity: "critical",
				confidence: 0.1,
				description: "uncertain but critical",
			},
		];
		const result = await coordinate({ findings });
		expect(result.verdict).toBe("block");
	});
});

describe("coordinate: complex scenarios", () => {
	test("dedup then verify then decide in sequence", async () => {
		const findings: FinderFinding[] = [
			// Two low-confidence findings that dedup to one
			{
				kind: "correctness",
				file: "src/foo.ts",
				line: 10,
				severity: "high",
				confidence: 0.4,
				description: "possible bug",
			},
			{
				kind: "quality",
				file: "src/foo.ts",
				line: 10,
				severity: "medium",
				confidence: 0.3,
				description: "possible bug",
			},
			// A high-confidence finding
			{
				kind: "security",
				file: "src/bar.ts",
				severity: "medium",
				confidence: 0.9,
				description: "confirmed issue",
			},
		];

		let verifyCount = 0;
		const verifyProducer = async (f: FinderFinding) => {
			verifyCount++;
			// The deduped low-confidence finding is verified and kept
			if (f.file === "src/foo.ts") {
				return { keep: true };
			}
			throw new Error("should not verify high-confidence");
		};

		const result = await coordinate({ findings, verifyProducer });

		// Should have deduped to 2 findings (foo + bar)
		expect(result.findings).toHaveLength(2);
		expect(verifyCount).toBe(1); // Only the deduped low-confidence one was verified
		expect(result.verdict).toBe("approve_with_comments");
	});
});
