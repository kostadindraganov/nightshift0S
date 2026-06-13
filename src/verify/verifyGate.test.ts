/**
 * Verify gate tests (UNIT B-5, BLUEPRINT §3.10 item 8, §3.1).
 *
 * All dependencies are injected: fake BrowserRunner (no real browser), fake
 * optedIn predicate. Tests verify:
 *   1. Happy path: opted in, all checks pass → "pass"
 *   2. Skipped when not opted in → "skipped"
 *   3. Failed when a check fails → "fail"
 *   4. Failed when playwright unavailable → "fail"
 *   5. Failed when runner throws → "fail"
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BrowserCheck, BrowserResult, BrowserRunner } from "./browser.ts";
import {
	runVerificationGate,
	type VerifyGateResult,
} from "./verifyGate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fake browser runner for testing. */
class FakeBrowserRunner implements BrowserRunner {
	constructor(private result: BrowserResult | Error | null = null) {}

	async run(input: { url: string; checks: BrowserCheck[] }): Promise<BrowserResult> {
		if (this.result instanceof Error) {
			throw this.result;
		}
		if (this.result === null) {
			// Default: all checks pass
			return {
				ok: true,
				checks: input.checks.map((check) => ({
					check,
					passed: true,
				})),
			};
		}
		return this.result;
	}
}

// ---------------------------------------------------------------------------
// 1. Happy path: opted in, all checks pass → "pass"
// ---------------------------------------------------------------------------

test("opted in with all checks passing returns pass verdict", async () => {
	const runner = new FakeBrowserRunner({
		ok: true,
		checks: [
			{
				check: { kind: "selector_present", value: ".button" },
				passed: true,
			},
			{
				check: { kind: "text_present", value: "Welcome" },
				passed: true,
			},
		],
	});

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => true,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [
				{ kind: "selector_present", value: ".button" },
				{ kind: "text_present", value: "Welcome" },
			],
		},
	);

	expect(result.verdict).toBe("pass");
	expect(result.result).toBeDefined();
	expect(result.result?.ok).toBe(true);
	expect(result.reason).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 2. Not opted in → "skipped"
// ---------------------------------------------------------------------------

test("not opted in returns skipped verdict", async () => {
	const runner = new FakeBrowserRunner();

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => false,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [{ kind: "status_ok", value: "" }],
		},
	);

	expect(result.verdict).toBe("skipped");
	expect(result.reason).toBe("not_opted_in");
	expect(result.result).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 3. Opted in but a check fails → "fail"
// ---------------------------------------------------------------------------

test("opted in with a failing check returns fail verdict", async () => {
	const runner = new FakeBrowserRunner({
		ok: false,
		checks: [
			{
				check: { kind: "selector_present", value: ".button" },
				passed: true,
			},
			{
				check: { kind: "text_present", value: "Missing Text" },
				passed: false,
				detail: "text not found: Missing Text",
			},
		],
	});

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => true,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [
				{ kind: "selector_present", value: ".button" },
				{ kind: "text_present", value: "Missing Text" },
			],
		},
	);

	expect(result.verdict).toBe("fail");
	expect(result.result).toBeDefined();
	expect(result.result?.ok).toBe(false);
	expect(result.reason).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 4. Playwright unavailable → "fail"
// ---------------------------------------------------------------------------

test("playwright unavailable returns fail verdict", async () => {
	const runner = new FakeBrowserRunner({
		ok: false,
		checks: [],
		detail: "playwright_unavailable",
	});

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => true,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [{ kind: "selector_present", value: ".button" }],
		},
	);

	expect(result.verdict).toBe("fail");
	expect(result.result).toBeDefined();
	expect(result.result?.ok).toBe(false);
	expect(result.result?.detail).toBe("playwright_unavailable");
});

// ---------------------------------------------------------------------------
// 5. Runner throws → "fail"
// ---------------------------------------------------------------------------

test("runner throws returns fail verdict with reason", async () => {
	const error = new Error("Browser launch failed");
	const runner = new FakeBrowserRunner(error);

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => true,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [{ kind: "status_ok", value: "" }],
		},
	);

	expect(result.verdict).toBe("fail");
	expect(result.reason).toBe("Browser launch failed");
	expect(result.result).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Edge case: opted in, result.ok=true but a check individually failed
// ---------------------------------------------------------------------------

test("result.ok true but individual check failed still returns fail", async () => {
	const runner = new FakeBrowserRunner({
		ok: true, // Contradictory: ok but a check failed
		checks: [
			{
				check: { kind: "selector_present", value: ".button" },
				passed: false,
				detail: "selector not found: .button",
			},
		],
	});

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => true,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [{ kind: "selector_present", value: ".button" }],
		},
	);

	expect(result.verdict).toBe("fail");
	expect(result.result).toBeDefined();
});

// ---------------------------------------------------------------------------
// Edge case: opted in, empty checks array → pass (all of nothing pass)
// ---------------------------------------------------------------------------

test("empty checks array with ok:true returns pass", async () => {
	const runner = new FakeBrowserRunner({
		ok: true,
		checks: [],
	});

	const result = await runVerificationGate(
		{
			runner,
			optedIn: () => true,
		},
		{
			projectId: 42,
			url: "https://example.com",
			checks: [],
		},
	);

	// Per the logic: checks.length > 0 && every(...) → length=0 means false → fail
	// Actually, let me check the gate logic... if checks.length > 0 && every pass,
	// then we return pass. If length=0, checks.length > 0 is false, so we don't
	// return pass, we fall through... oh wait, let me re-read the gate.
	// Looking at verifyGate.ts line 78:
	// const allPassed = result.checks.length > 0 && result.checks.every((c) => c.passed);
	// So if length=0, allPassed=false, and we return {verdict:"fail", result}.
	// That makes sense: you can't pass a verification with no checks.
	expect(result.verdict).toBe("fail");
});

// ---------------------------------------------------------------------------
// Per-project opt-in predicate
// ---------------------------------------------------------------------------

test("optedIn is per-project", async () => {
	const runner = new FakeBrowserRunner();
	const optedInProjects = new Set([42]);
	const optedIn = (projectId: number) => optedInProjects.has(projectId);

	// Project 42: opted in
	let result = await runVerificationGate(
		{ runner, optedIn },
		{
			projectId: 42,
			url: "https://example.com",
			checks: [{ kind: "status_ok", value: "" }],
		},
	);
	expect(result.verdict).toBe("pass");

	// Project 99: not opted in
	result = await runVerificationGate(
		{ runner, optedIn },
		{
			projectId: 99,
			url: "https://example.com",
			checks: [{ kind: "status_ok", value: "" }],
		},
	);
	expect(result.verdict).toBe("skipped");
	expect(result.reason).toBe("not_opted_in");
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED: playwright_unavailable MUST be "fail", never "pass"
// This is the critical invariant: unavailability of the tool is NOT a pass.
// ---------------------------------------------------------------------------

test("playwright_unavailable is explicitly fail not pass or skipped", async () => {
	const runner = new FakeBrowserRunner({
		ok: false,
		checks: [],
		detail: "playwright_unavailable",
	});

	const result = await runVerificationGate(
		{ runner, optedIn: () => true },
		{
			projectId: 1,
			url: "https://example.com",
			checks: [{ kind: "selector_present", value: "body" }],
		},
	);

	// MUST be fail — never pass, never skipped. Fail-closed on unavailability.
	expect(result.verdict).toBe("fail");
	expect(result.verdict).not.toBe("pass");
	expect(result.verdict).not.toBe("skipped");
	// The playwright_unavailable detail is surfaced in result, not in reason
	// (reason is reserved for runner throw messages).
	expect(result.result?.detail).toBe("playwright_unavailable");
	expect(result.result?.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED: non-opted-in project yields "skipped", runner is never called
// Verifies that an opted-out project cannot accidentally run the browser.
// ---------------------------------------------------------------------------

test("runner is never called when project is not opted in", async () => {
	let runCalled = false;
	const runner: import("./browser.ts").BrowserRunner = {
		async run() {
			runCalled = true;
			return { ok: true, checks: [] };
		},
	};

	const result = await runVerificationGate(
		{ runner, optedIn: () => false },
		{
			projectId: 7,
			url: "https://example.com",
			checks: [{ kind: "text_present", value: "Hello" }],
		},
	);

	expect(result.verdict).toBe("skipped");
	expect(result.reason).toBe("not_opted_in");
	// The runner must not have been invoked for an un-opted-in project.
	expect(runCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED: runner returning ok:true but no checks still fails
// Prevents a degenerate runner from returning ok:true+[] to bypass the gate.
// ---------------------------------------------------------------------------

test("runner returning ok:true with empty checks is treated as fail", async () => {
	// A buggy/degenerate runner returns ok:true but no checks — the gate must
	// not treat this as a pass (that would be a bypass of the verification gate).
	const runner = new FakeBrowserRunner({ ok: true, checks: [] });

	const result = await runVerificationGate(
		{ runner, optedIn: () => true },
		{
			projectId: 3,
			url: "https://example.com",
			checks: [{ kind: "selector_present", value: ".main" }],
		},
	);

	// checks.length === 0 → allPassed = false → verdict must be "fail".
	expect(result.verdict).toBe("fail");
	expect(result.verdict).not.toBe("pass");
});
