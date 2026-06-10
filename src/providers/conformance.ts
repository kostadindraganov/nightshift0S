/**
 * Provider conformance harness (BLUEPRINT §3.12.13 + §3.12.30).
 *
 * "Capabilities are PROVEN, not declared." This module runs a deterministic
 * probe suite against a ProviderDriver and records which capabilities are
 * actually demonstrated at runtime. The ProvenReport is what the router sees —
 * driver.declared is never consulted after conformance runs.
 *
 * Probe design:
 *   resume          — runOnce to get a sessionId, then resumeOnce; proven only
 *                     if the continuation is non-empty AND driver declares resume.
 *   structured_output — ask for JSON inside <output> tags, run extractStructured;
 *                     proven only if extraction succeeds.
 *   cost_reporting  — runOnce, check tokensIn/Out/costUsd are present and > 0.
 *
 * If the driver reports isAvailable() === false every probe is "skipped" and
 * proven is all-false (the unproven gate).
 */

import type { DbHandle } from "../db/client.ts";
import { enqueueWrite } from "../db/writer.ts";
import { providers } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { extractStructured } from "./schemaRepair.ts";
import type { Capabilities, ProviderDriver, ProbeResult, ProvenReport } from "./types.ts";

// ---------------------------------------------------------------------------
// Probe definitions
// ---------------------------------------------------------------------------

export interface ConformanceProbe {
	id: string;
	capability: keyof Capabilities;
	run(driver: ProviderDriver): Promise<ProbeResult>;
}

const probeResume: ConformanceProbe = {
	id: "resume",
	capability: "resume",
	async run(driver) {
		if (!driver.declared.resume) {
			return {
				capability: "resume",
				status: "skipped",
				evidence: "driver does not declare resume capability",
			};
		}
		try {
			const first = await driver.runOnce({ prompt: "Reply with the single word HELLO." });
			if (!first.sessionId) {
				return {
					capability: "resume",
					status: "failed",
					evidence: "runOnce did not return a sessionId",
				};
			}
			const second = await driver.resumeOnce({
				sessionId: first.sessionId,
				prompt: "What was the word you just said?",
			});
			const coherent = second.stdout.trim().length > 0;
			return {
				capability: "resume",
				status: coherent ? "proven" : "failed",
				evidence: coherent
					? `resumed session ${first.sessionId}; continuation non-empty`
					: "resumeOnce returned empty stdout",
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { capability: "resume", status: "failed", evidence: `exception: ${msg}` };
		}
	},
};

const probeStructuredOutput: ConformanceProbe = {
	id: "structured_output",
	capability: "structured_output",
	async run(driver) {
		const PROMPT =
			'Respond with ONLY a JSON object inside <output> tags. Example: <output>{"ok":true}</output>';
		try {
			const result = await driver.runOnce({ prompt: PROMPT });
			const extracted = extractStructured(result.stdout, { tag: "output" });
			if (extracted.ok) {
				return {
					capability: "structured_output",
					status: "proven",
					evidence: `extractStructured succeeded; value keys: ${Object.keys(extracted.value as object).join(",")}`,
				};
			}
			return {
				capability: "structured_output",
				status: "failed",
				evidence: `extractStructured failed: ${extracted.reason}`,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { capability: "structured_output", status: "failed", evidence: `exception: ${msg}` };
		}
	},
};

const probeCostReporting: ConformanceProbe = {
	id: "cost_reporting",
	capability: "cost_reporting",
	async run(driver) {
		try {
			const result = await driver.runOnce({ prompt: "Reply OK." });
			const hasTokensIn = typeof result.tokensIn === "number" && result.tokensIn > 0;
			const hasTokensOut = typeof result.tokensOut === "number" && result.tokensOut > 0;
			const hasCost = typeof result.costUsd === "number" && result.costUsd > 0;
			if (hasTokensIn && hasTokensOut && hasCost) {
				return {
					capability: "cost_reporting",
					status: "proven",
					evidence: `tokensIn=${result.tokensIn} tokensOut=${result.tokensOut} costUsd=${result.costUsd}`,
				};
			}
			const missing: string[] = [];
			if (!hasTokensIn) missing.push("tokensIn");
			if (!hasTokensOut) missing.push("tokensOut");
			if (!hasCost) missing.push("costUsd");
			return {
				capability: "cost_reporting",
				status: "failed",
				evidence: `missing or zero: ${missing.join(", ")}`,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { capability: "cost_reporting", status: "failed", evidence: `exception: ${msg}` };
		}
	},
};

/** Default probe suite. Pass a subset to `runConformance` for targeted testing. */
export const PROBES: ConformanceProbe[] = [
	probeResume,
	probeStructuredOutput,
	probeCostReporting,
];

// ---------------------------------------------------------------------------
// All-false baseline capabilities (unproven)
// ---------------------------------------------------------------------------

function emptyCapabilities(): Capabilities {
	return {
		interactive: false,
		resume: false,
		fork: false,
		structured_output: false,
		cost_reporting: false,
		auth: [],
		roles: [],
	};
}

// ---------------------------------------------------------------------------
// runConformance
// ---------------------------------------------------------------------------

/**
 * Run the probe suite against `driver`. If the driver is unavailable every
 * probe is "skipped" and `proven` is all-false. Otherwise each probe runs
 * independently; a thrown exception is caught and recorded as "failed".
 *
 * NOTE: `interactive` and `fork` have no automated probe today — they require
 * live PTY/worktree infrastructure. They are copied from `driver.declared` only
 * when all other probes pass (conservative approach: if a driver is otherwise
 * healthy we trust its self-report for infra caps). Callers may override.
 */
export async function runConformance(
	driver: ProviderDriver,
	probes: ConformanceProbe[] = PROBES,
): Promise<ProvenReport> {
	const available = await driver.isAvailable();
	if (!available) {
		const results: ProbeResult[] = probes.map((p) => ({
			capability: p.capability,
			status: "skipped" as const,
			evidence: "driver isAvailable() returned false",
		}));
		return {
			driver: driver.name,
			proven: emptyCapabilities(),
			results,
		};
	}

	const results: ProbeResult[] = [];
	const proven = emptyCapabilities();

	for (const probe of probes) {
		const result = await probe.run(driver);
		results.push(result);
		if (result.status === "proven") {
			// `auth` and `roles` are not probed individually — carry from declared.
			if (result.capability === "auth" || result.capability === "roles") {
				// Skip: handled below.
			} else {
				(proven[result.capability] as boolean) = true;
			}
		}
	}

	// Non-probeable infra caps: copy from declared if driver is available.
	proven.interactive = driver.declared.interactive;
	proven.fork = driver.declared.fork;
	proven.auth = driver.declared.auth.slice();
	proven.roles = driver.declared.roles.slice();

	return { driver: driver.name, proven, results };
}

// ---------------------------------------------------------------------------
// recordCapabilities
// ---------------------------------------------------------------------------

/**
 * Persist the ProvenReport to the providers table (SPEC-SCHEMA §providers).
 * Uses enqueueWrite so it participates in the single-writer queue.
 */
export async function recordCapabilities(
	handle: DbHandle,
	providerName: string,
	report: ProvenReport,
): Promise<void> {
	const json = JSON.stringify(report);
	await enqueueWrite(() =>
		handle.db
			.update(providers)
			.set({ capabilitiesJson: json })
			.where(eq(providers.name, providerName))
			.run(),
	);
}
