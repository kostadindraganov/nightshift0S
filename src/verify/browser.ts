/**
 * WHY: Playwright verification (BLUEPRINT §3.10 item 8, §3.1) is opt-in per
 * project, web projects only, and never a default gate. This module provides
 * the check types, result types, and a LAZY playwright adapter that fail-closes
 * when playwright is absent (it is a deploy/Linux concern — the dep is never
 * required for the build or tests). All side effects (browser launch, FS for
 * screenshots) are captured inside makePlaywrightRunner so callers can inject a
 * fake BrowserRunner in tests without touching the real playwright path at all.
 *
 * Three check kinds:
 *   selector_present — CSS selector must exist in the DOM.
 *   text_present     — text string must appear in document.body.innerText.
 *   status_ok        — HTTP status of the initial navigation must be 2xx.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrowserCheck {
	kind: "selector_present" | "text_present" | "status_ok";
	/** Selector string, expected text, or unused for status_ok. */
	value: string;
}

export interface BrowserCheckResult {
	check: BrowserCheck;
	passed: boolean;
	detail?: string;
}

export interface BrowserResult {
	ok: boolean;
	/** Per-check results. Empty when playwright is unavailable. */
	checks: BrowserCheckResult[];
	/** Set to "playwright_unavailable" when the adapter cannot find playwright. */
	detail?: string;
	/** Artifact ref (file path) for the captured screenshot, when taken. */
	screenshotRef?: string;
}

export interface BrowserRunner {
	run(input: { url: string; checks: BrowserCheck[] }): Promise<BrowserResult>;
}

// ---------------------------------------------------------------------------
// Lazy import helper (typed as unknown to avoid static resolution of playwright)
// ---------------------------------------------------------------------------

/**
 * Dynamically load playwright without referencing its type at module level.
 * Returns null when playwright is not installed (FAIL-CLOSED).
 *
 * Using `new Function("s","return import(s)")` prevents tsc from statically
 * resolving the specifier, which would fail when the package is absent.
 */
async function lazyPlaywright(): Promise<{
	chromium: {
		launch(opts: { headless: boolean }): Promise<{
			newPage(): Promise<{
				goto(
					url: string,
					opts: { waitUntil: string },
				): Promise<{ status(): number } | null>;
				$(selector: string): Promise<unknown | null>;
				evaluate<T>(fn: () => T): Promise<T>;
				screenshot(opts: { path: string; fullPage: boolean }): Promise<void>;
			}>;
			close(): Promise<void>;
		}>;
	};
} | null> {
	try {
		// Dynamic specifier via new Function bypasses tsc module resolution so
		// the build and tests never require playwright to be installed.
		// biome-ignore lint/security/noGlobalEval: intentional lazy dep load
		const mod = await (new Function("s", "return import(s)")("playwright") as Promise<unknown>);
		return mod as Awaited<ReturnType<typeof lazyPlaywright>>;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Lazy Playwright adapter
// ---------------------------------------------------------------------------

/**
 * Build a BrowserRunner that LAZILY imports playwright at call time. If
 * playwright is not installed the runner returns
 *   { ok: false, checks: [], detail: "playwright_unavailable" }
 * (FAIL-CLOSED — no throw). When playwright IS present, launches chromium
 * headless, navigates to `url`, evaluates every check, captures a screenshot
 * to screenshotDir when provided, and always closes the browser.
 *
 * NEVER import playwright at module top-level — the lazy import is deliberate.
 */
export function makePlaywrightRunner(deps?: { screenshotDir?: string }): BrowserRunner {
	const { screenshotDir } = deps ?? {};

	return {
		async run(input: { url: string; checks: BrowserCheck[] }): Promise<BrowserResult> {
			const pw = await lazyPlaywright();
			if (pw === null) {
				return { ok: false, checks: [], detail: "playwright_unavailable" };
			}

			const browser = await pw.chromium.launch({ headless: true });
			try {
				const page = await browser.newPage();

				// Navigate; capture HTTP status for status_ok checks.
				let navigationStatus = 0;
				const response = await page.goto(input.url, { waitUntil: "domcontentloaded" });
				if (response !== null) {
					navigationStatus = response.status();
				}

				const checkResults: BrowserCheckResult[] = [];

				for (const check of input.checks) {
					let passed = false;
					let detail: string | undefined;

					try {
						if (check.kind === "status_ok") {
							passed = navigationStatus >= 200 && navigationStatus < 300;
							if (!passed) {
								detail = `HTTP ${navigationStatus}`;
							}
						} else if (check.kind === "selector_present") {
							const element = await page.$(check.value);
							passed = element !== null;
							if (!passed) {
								detail = `selector not found: ${check.value}`;
							}
						} else {
							// text_present
							const bodyText: string = await page.evaluate(
								() =>
									typeof document !== "undefined"
										? (document.body?.innerText ?? "")
										: "",
							);
							passed = bodyText.includes(check.value);
							if (!passed) {
								detail = `text not found: ${check.value}`;
							}
						}
					} catch (err) {
						passed = false;
						detail = err instanceof Error ? err.message : String(err);
					}

					checkResults.push({
						check,
						passed,
						...(detail !== undefined ? { detail } : {}),
					});
				}

				// Screenshot — non-fatal if it fails.
				let screenshotRef: string | undefined;
				if (screenshotDir !== undefined) {
					try {
						mkdirSync(screenshotDir, { recursive: true });
						const fileName = `verify-${Date.now()}.png`;
						const filePath = join(screenshotDir, fileName);
						await page.screenshot({ path: filePath, fullPage: true });
						screenshotRef = filePath;
					} catch {
						// Screenshot failure must not fail the verification result.
					}
				}

				const allPassed = checkResults.length > 0 && checkResults.every((r) => r.passed);
				return {
					ok: allPassed,
					checks: checkResults,
					...(screenshotRef !== undefined ? { screenshotRef } : {}),
				};
			} finally {
				await browser.close();
			}
		},
	};
}
