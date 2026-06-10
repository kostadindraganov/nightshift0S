/**
 * Conformance harness + router tests (task 2.1).
 *
 * All tests use deterministic FAKE drivers — no real CLI is invoked.
 * Database tests use an in-memory SQLite instance migrated via runMigrations.
 *
 * Test matrix:
 *   (a) Fully-capable fake → all declared caps proven.
 *   (b) Fake whose structured_output returns garbage → structured_output NOT
 *       proven; extractStructured fails closed.
 *   (c) Unavailable fake → all probes skipped, proven all-false.
 *   (d) recordCapabilities writes capabilities_json to :memory: DB and round-trips.
 *   (e) Router: selectDriver REFUSES unproven structured_output for reviewer;
 *       SELECTS when proven.
 *   (f) claudeCode.declared.cost_reporting === true, codex.declared.cost_reporting === false.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { providers } from "../db/schema.ts";
import { claudeCode } from "./claudeCode.ts";
import { codex } from "./codex.ts";
import { PROBES, recordCapabilities, runConformance } from "./conformance.ts";
import { selectDriver } from "./router.ts";
import { extractStructured } from "./schemaRepair.ts";
import type { Capabilities, ProviderDriver } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers — fake drivers
// ---------------------------------------------------------------------------

/** A fully-capable fake driver that honours every probe. */
function makeFakeDriver(overrides?: Partial<ProviderDriver>): ProviderDriver {
	let callCount = 0;
	const base: ProviderDriver = {
		name: "fake-full",
		kind: "cli",
		declared: {
			interactive: true,
			resume: true,
			fork: true,
			structured_output: true,
			cost_reporting: true,
			auth: ["subscription", "api_key"],
			roles: ["coder", "reviewer", "planner", "judge", "utility", "experiment"],
		},
		async isAvailable() {
			return true;
		},
		async runOnce({ prompt: _prompt }) {
			callCount++;
			// Each call returns a distinct "session" and valid telemetry.
			return {
				stdout: `<output>{"ok":true,"call":${callCount}}</output>`,
				sessionId: `session-${callCount}`,
				tokensIn: 10,
				tokensOut: 20,
				costUsd: 0.001,
			};
		},
		async resumeOnce({ sessionId: _sid }) {
			return { stdout: "continuation text from resume" };
		},
	};
	return { ...base, ...overrides };
}

/** A fake whose structured_output probe will fail (no valid <output> block). */
function makeGarbageStructuredDriver(): ProviderDriver {
	return makeFakeDriver({
		name: "fake-garbage-struct",
		async runOnce({ prompt: _prompt }) {
			return {
				// Garbage: no <output> tag, no valid JSON.
				stdout: "Sorry I don't know how to do that. Here is some prose instead.",
				sessionId: "sess-garbage",
				tokensIn: 10,
				tokensOut: 5,
				costUsd: 0.0001,
			};
		},
	});
}

/** A fake that is always unavailable. */
function makeUnavailableDriver(): ProviderDriver {
	return makeFakeDriver({
		name: "fake-unavailable",
		async isAvailable() {
			return false;
		},
	});
}

// ---------------------------------------------------------------------------
// (a) Fully-capable fake → all declared caps proven
// ---------------------------------------------------------------------------

describe("runConformance: fully-capable fake", () => {
	test("resume probe is proven", async () => {
		const driver = makeFakeDriver();
		const report = await runConformance(driver, PROBES);
		const resumeResult = report.results.find((r) => r.capability === "resume");
		expect(resumeResult?.status).toBe("proven");
		expect(report.proven.resume).toBe(true);
	});

	test("structured_output probe is proven", async () => {
		const driver = makeFakeDriver();
		const report = await runConformance(driver, PROBES);
		const soResult = report.results.find((r) => r.capability === "structured_output");
		expect(soResult?.status).toBe("proven");
		expect(report.proven.structured_output).toBe(true);
	});

	test("cost_reporting probe is proven", async () => {
		const driver = makeFakeDriver();
		const report = await runConformance(driver, PROBES);
		const crResult = report.results.find((r) => r.capability === "cost_reporting");
		expect(crResult?.status).toBe("proven");
		expect(report.proven.cost_reporting).toBe(true);
	});

	test("driver name is preserved in report", async () => {
		const driver = makeFakeDriver();
		const report = await runConformance(driver, PROBES);
		expect(report.driver).toBe("fake-full");
	});

	test("infra caps (interactive, fork, auth, roles) are copied from declared", async () => {
		const driver = makeFakeDriver();
		const report = await runConformance(driver, PROBES);
		expect(report.proven.interactive).toBe(true);
		expect(report.proven.fork).toBe(true);
		expect(report.proven.auth).toEqual(["subscription", "api_key"]);
		expect(report.proven.roles).toContain("coder");
	});
});

// ---------------------------------------------------------------------------
// (b) Garbage structured_output → NOT proven; extractStructured fails closed
// ---------------------------------------------------------------------------

describe("runConformance: garbage structured_output", () => {
	test("structured_output probe status is failed", async () => {
		const driver = makeGarbageStructuredDriver();
		const report = await runConformance(driver, PROBES);
		const soResult = report.results.find((r) => r.capability === "structured_output");
		expect(soResult?.status).toBe("failed");
	});

	test("structured_output is NOT proven in ProvenReport", async () => {
		const driver = makeGarbageStructuredDriver();
		const report = await runConformance(driver, PROBES);
		expect(report.proven.structured_output).toBe(false);
	});

	test("extractStructured returns ok:false on garbage stdout (fail-closed)", () => {
		const garbage = "Sorry I don't know how to do that. Here is some prose instead.";
		const result = extractStructured(garbage, { tag: "output" });
		expect(result.ok).toBe(false);
		expect("reason" in result && result.reason).toMatch(/no <output>/i);
	});

	test("extractStructured returns ok:false on malformed JSON inside tag", () => {
		const malformed = "<output>{ this is not json }</output>";
		const result = extractStructured(malformed, { tag: "output" });
		expect(result.ok).toBe(false);
	});

	test("extractStructured NEVER returns a fabricated default", () => {
		const result = extractStructured("", { tag: "output" });
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (c) Unavailable fake → all probes skipped, proven all-false
// ---------------------------------------------------------------------------

describe("runConformance: unavailable driver", () => {
	test("all probes are skipped", async () => {
		const driver = makeUnavailableDriver();
		const report = await runConformance(driver, PROBES);
		for (const result of report.results) {
			expect(result.status).toBe("skipped");
		}
	});

	test("proven is all-false", async () => {
		const driver = makeUnavailableDriver();
		const report = await runConformance(driver, PROBES);
		expect(report.proven.interactive).toBe(false);
		expect(report.proven.resume).toBe(false);
		expect(report.proven.fork).toBe(false);
		expect(report.proven.structured_output).toBe(false);
		expect(report.proven.cost_reporting).toBe(false);
		expect(report.proven.auth).toEqual([]);
		expect(report.proven.roles).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (d) recordCapabilities round-trips through :memory: DB
// ---------------------------------------------------------------------------

describe("recordCapabilities: DB round-trip", () => {
	let handle: DbHandle;

	beforeEach(() => {
		handle = openDatabase(":memory:");
		runMigrations(handle);
	});

	afterEach(() => {
		handle.sqlite.close();
	});

	test("capabilities_json is written and readable", async () => {
		// Insert a provider row first.
		handle.db.insert(providers).values({
			name: "test-provider",
			kind: "cli",
			authMode: "api_key",
		}).run();

		const driver = makeFakeDriver({ name: "test-provider" });
		const report = await runConformance(driver, PROBES);

		await recordCapabilities(handle, "test-provider", report);

		const row = handle.db.select().from(providers).all().find((r) => r.name === "test-provider");
		expect(row).toBeDefined();
		expect(typeof row!.capabilitiesJson).toBe("string");

		const parsed = JSON.parse(row!.capabilitiesJson!) as typeof report;
		expect(parsed.driver).toBe("test-provider");
		expect(parsed.proven.structured_output).toBe(true);
		expect(parsed.proven.cost_reporting).toBe(true);
		expect(parsed.proven.resume).toBe(true);
		expect(Array.isArray(parsed.results)).toBe(true);
	});

	test("recordCapabilities does not create a new row (UPDATE only)", async () => {
		// No row inserted → UPDATE touches 0 rows; should not throw.
		const driver = makeFakeDriver({ name: "nonexistent" });
		const report = await runConformance(driver, PROBES);
		// Should resolve without error even if no row exists.
		await expect(recordCapabilities(handle, "nonexistent", report)).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// (e) Router: REFUSE unproven structured_output for reviewer; SELECT when proven
// ---------------------------------------------------------------------------

describe("selectDriver: reviewer role gating", () => {
	function makeProven(overrides?: Partial<Capabilities>): Capabilities {
		const base: Capabilities = {
			interactive: true,
			resume: true,
			fork: false,
			structured_output: false, // not proven by default in this helper
			cost_reporting: false,
			auth: ["api_key"],
			roles: ["reviewer", "coder"],
		};
		return { ...base, ...overrides };
	}

	test("REFUSE: driver without proven structured_output for reviewer", () => {
		const driver = makeFakeDriver({ name: "unproven-reviewer" });
		const proven = makeProven({ structured_output: false });
		const result = selectDriver([{ driver, proven }], "reviewer");
		expect(result).toBeNull();
	});

	test("SELECT: driver with proven structured_output for reviewer", () => {
		const driver = makeFakeDriver({ name: "proven-reviewer" });
		const proven = makeProven({ structured_output: true });
		const result = selectDriver([{ driver, proven }], "reviewer");
		expect(result).not.toBeNull();
		expect(result?.name).toBe("proven-reviewer");
	});

	test("REFUSE: driver not in roles list even if caps are met", () => {
		const driver = makeFakeDriver({ name: "no-roles" });
		const proven = makeProven({ structured_output: true, roles: ["coder"] });
		const result = selectDriver([{ driver, proven }], "reviewer");
		expect(result).toBeNull();
	});

	test("SELECT: first qualifying driver is returned (order matters)", () => {
		const d1 = makeFakeDriver({ name: "first" });
		const d2 = makeFakeDriver({ name: "second" });
		const provenGood = makeProven({ structured_output: true });
		const result = selectDriver(
			[
				{ driver: d1, proven: provenGood },
				{ driver: d2, proven: provenGood },
			],
			"reviewer",
		);
		expect(result?.name).toBe("first");
	});

	test("coder role requires resume; REFUSE without it", () => {
		const driver = makeFakeDriver({ name: "no-resume-coder" });
		const proven = makeProven({ resume: false, roles: ["coder"] });
		const result = selectDriver([{ driver, proven }], "coder");
		expect(result).toBeNull();
	});

	test("coder role with proven resume is SELECTED", () => {
		const driver = makeFakeDriver({ name: "coder-ok" });
		const proven = makeProven({ resume: true, roles: ["coder"] });
		const result = selectDriver([{ driver, proven }], "coder");
		expect(result?.name).toBe("coder-ok");
	});

	test("empty driver list returns null", () => {
		expect(selectDriver([], "reviewer")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (f) Declared capability assertions for concrete drivers
// ---------------------------------------------------------------------------

describe("concrete driver declared caps", () => {
	test("claudeCode.declared.cost_reporting === true", () => {
		expect(claudeCode.declared.cost_reporting).toBe(true);
	});

	test("codex.declared.cost_reporting === false", () => {
		expect(codex.declared.cost_reporting).toBe(false);
	});

	test("claudeCode.declared.resume === true", () => {
		expect(claudeCode.declared.resume).toBe(true);
	});

	test("codex.declared.resume === false", () => {
		expect(codex.declared.resume).toBe(false);
	});

	test("claudeCode name is 'claude-code'", () => {
		expect(claudeCode.name).toBe("claude-code");
	});

	test("codex name is 'codex'", () => {
		expect(codex.name).toBe("codex");
	});

	test("claudeCode kind is 'cli'", () => {
		expect(claudeCode.kind).toBe("cli");
	});

	test("codex kind is 'cli'", () => {
		expect(codex.kind).toBe("cli");
	});

	test("claudeCode roles include reviewer and judge", () => {
		expect(claudeCode.declared.roles).toContain("reviewer");
		expect(claudeCode.declared.roles).toContain("judge");
	});

	test("codex roles include reviewer", () => {
		expect(codex.declared.roles).toContain("reviewer");
	});
});
