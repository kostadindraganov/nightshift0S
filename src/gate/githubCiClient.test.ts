/**
 * Hermetic tests for githubCiClient.ts.
 *
 * No network calls — all cases feed canned JSON payloads to the pure mapper
 * (mapCheckRuns / mapConclusion) and verify the CheckRun[] output and
 * green/red/pending/missing classification via ciGate().
 */

import { describe, it, expect } from "bun:test";
import {
	mapCheckRuns,
	type GitHubCheckRunsResponse,
} from "./githubCiClient.ts";
import { ciGate } from "./ci.ts";

// ---------------------------------------------------------------------------
// Helper — build a minimal canned API response
// ---------------------------------------------------------------------------

function payload(
	runs: Array<{ name: string; status: string; conclusion: string | null }>,
): GitHubCheckRunsResponse {
	return { check_runs: runs };
}

// ---------------------------------------------------------------------------
// Case 1: All checks finished green (success) → ciGate reports green
// ---------------------------------------------------------------------------

describe("githubCiClient — response mapping + gate classification", () => {
	it("(1) all conclusions success → CheckRun[] with status success, gate green", () => {
		const data = payload([
			{ name: "lint", status: "completed", conclusion: "success" },
			{ name: "build", status: "completed", conclusion: "success" },
			{ name: "typecheck", status: "completed", conclusion: "neutral" },
		]);

		const checks = mapCheckRuns(data);
		expect(checks).toEqual([
			{ name: "lint", status: "success" },
			{ name: "build", status: "success" },
			{ name: "typecheck", status: "neutral" },
		]);

		const gate = ciGate({ requiredChecks: ["lint", "build", "typecheck"], checks });
		expect(gate.green).toBe(true);
		expect(gate.blocking).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// Case 2: One run failed → gate reports red
	// -----------------------------------------------------------------------

	it("(2) one failure conclusion → status failure, gate red with correct label", () => {
		const data = payload([
			{ name: "lint", status: "completed", conclusion: "failure" },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		const checks = mapCheckRuns(data);
		expect(checks).toEqual([
			{ name: "lint", status: "failure" },
			{ name: "build", status: "success" },
		]);

		const gate = ciGate({ requiredChecks: ["lint", "build"], checks });
		expect(gate.green).toBe(false);
		expect(gate.blocking).toContain("lint(failure)");
		expect(gate.blocking).not.toContain("build");
	});

	// -----------------------------------------------------------------------
	// Case 3: Run still in_progress (conclusion null) → status pending, gate red
	// -----------------------------------------------------------------------

	it("(3) conclusion null (in_progress) → status pending, gate red", () => {
		const data = payload([
			{ name: "tests", status: "in_progress", conclusion: null },
		]);

		const checks = mapCheckRuns(data);
		expect(checks).toEqual([{ name: "tests", status: "pending" }]);

		const gate = ciGate({ requiredChecks: ["tests"], checks });
		expect(gate.green).toBe(false);
		expect(gate.blocking).toContain("tests(pending)");
	});

	// -----------------------------------------------------------------------
	// Case 4: Required check absent from response → gate reports (missing)
	// -----------------------------------------------------------------------

	it("(4) required check absent from response → gate reports it as missing", () => {
		const data = payload([
			{ name: "lint", status: "completed", conclusion: "success" },
		]);

		const checks = mapCheckRuns(data);
		// "deploy" was never returned by the API
		const gate = ciGate({ requiredChecks: ["lint", "deploy"], checks });
		expect(gate.green).toBe(false);
		expect(gate.blocking).toContain("deploy(missing)");
		expect(gate.blocking).not.toContain("lint");
	});
});
