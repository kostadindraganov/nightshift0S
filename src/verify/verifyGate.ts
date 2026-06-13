/**
 * WHY: The verify gate (BLUEPRINT §3.10 item 8) wraps the BrowserRunner with
 * the project-level opt-in check. Playwright verification is NEVER a default
 * gate — it must be explicitly opted into per project (web projects only). A
 * project that has not opted in always gets verdict "skipped"; one that has
 * opted in gets "pass" only if every check passed; any runner failure
 * (ok:false, throw) yields "fail" (FAIL-CLOSED: a verification we couldn't run
 * does NOT pass). All dependencies are injected so tests can supply a fake
 * BrowserRunner with no real browser.
 */

import type { BrowserCheck, BrowserResult, BrowserRunner } from "./browser.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifyGateDeps {
	runner: BrowserRunner;
	/** Returns true iff the project has opted into playwright verification. */
	optedIn: (projectId: number) => boolean;
}

export interface VerifyGateInput {
	projectId: number;
	url: string;
	checks: BrowserCheck[];
}

export type VerifyVerdict = "pass" | "fail" | "skipped";

export interface VerifyGateResult {
	verdict: VerifyVerdict;
	result?: BrowserResult;
	reason?: string;
}

// ---------------------------------------------------------------------------
// runVerificationGate
// ---------------------------------------------------------------------------

/**
 * Run the verification gate for a project.
 *
 *   - !optedIn(projectId)  → { verdict:"skipped", reason:"not_opted_in" }
 *     (NEVER a default gate — opt-out is the safe default)
 *   - runner throws or returns ok:false → { verdict:"fail" }
 *   - all checks passed and result.ok → { verdict:"pass", result }
 *   - any check failed → { verdict:"fail", result }
 */
export async function runVerificationGate(
	deps: VerifyGateDeps,
	input: VerifyGateInput,
): Promise<VerifyGateResult> {
	// Opt-in check: verification is explicitly off by default.
	if (!deps.optedIn(input.projectId)) {
		return { verdict: "skipped", reason: "not_opted_in" };
	}

	let result: BrowserResult;

	try {
		result = await deps.runner.run({ url: input.url, checks: input.checks });
	} catch (err) {
		// Runner threw — fail-closed: a verification we couldn't run does NOT pass.
		return {
			verdict: "fail",
			reason: err instanceof Error ? err.message : String(err),
		};
	}

	// Fail-closed: ok:false (e.g. playwright_unavailable) is a fail.
	if (!result.ok) {
		return { verdict: "fail", result };
	}

	// Even if result.ok is true, every individual check must have passed.
	const allPassed = result.checks.length > 0 && result.checks.every((c) => c.passed);
	if (!allPassed) {
		return { verdict: "fail", result };
	}

	return { verdict: "pass", result };
}
