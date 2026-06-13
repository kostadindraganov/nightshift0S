/**
 * Auth health panel tests (BLUEPRINT §3.9, UNIT 5.8c).
 *
 * Pure-read tests over the providers table. No writes, no probes in tests.
 * Each test owns its own in-memory DB so state doesn't leak across cases.
 *
 * Matrix (≤6 meaningful cases):
 *   1. snapshotAuthHealth returns all providers with correct health fields.
 *   2. Status precedence: disabled > circuit_open > cooling_down > unproven > degraded > healthy.
 *   3. cooldownActive logic: null/empty/"bad-date" strings are NOT active; valid future time IS active.
 *   4. capabilitiesProven logic: null/empty/invalid JSON/arrays/empty objects are unproven.
 *   5. probeAuthHealth with no probe arg returns snapshot directly (fail-closed).
 *   6. probeAuthHealth with a probe: augments non-structural-block providers, downgrades to degraded on failure.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import type { ProviderAuthMode, ProviderKind } from "../db/columns.ts";
import { providers } from "../db/schema.ts";
import { probeAuthHealth, snapshotAuthHealth, type ProbeFn } from "./authHealth.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let clock: Date;

function insertProvider(input: {
	name: string;
	kind: ProviderKind;
	authMode: ProviderAuthMode;
	enabled?: boolean;
	circuitState?: "closed" | "open" | "half_open";
	cooldownUntil?: string | null;
	lastError?: string | null;
	capabilitiesJson?: string | null;
}) {
	handle.db
		.insert(providers)
		.values({
			name: input.name,
			kind: input.kind,
			authMode: input.authMode,
			enabled: input.enabled ?? true,
			circuitState: input.circuitState ?? "closed",
			cooldownUntil: input.cooldownUntil ?? null,
			lastError: input.lastError ?? null,
			capabilitiesJson: input.capabilitiesJson ?? null,
		})
		.run();
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	clock = new Date("2026-06-13T00:00:00.000Z");
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// 1. snapshotAuthHealth reads all providers and populates ProviderHealth fields
// ---------------------------------------------------------------------------

test("snapshotAuthHealth returns all providers with basic fields populated", () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		circuitState: "closed",
		cooldownUntil: null,
		lastError: null,
		capabilitiesJson: '{"claude": true}',
	});

	insertProvider({
		name: "codex",
		kind: "api",
		authMode: "api_key",
		enabled: false,
		circuitState: "open",
		cooldownUntil: "2026-06-13T01:00:00.000Z",
		lastError: "connection timeout",
		capabilitiesJson: null,
	});

	const health = snapshotAuthHealth(handle, clock);
	expect(health).toHaveLength(2);

	// Claude: healthy by default
	const claude = health.find((h) => h.name === "claude");
	expect(claude).toBeDefined();
	expect(claude!.name).toBe("claude");
	expect(claude!.kind).toBe("cli");
	expect(claude!.authMode).toBe("subscription");
	expect(claude!.enabled).toBe(true);
	expect(claude!.circuitState).toBe("closed");
	expect(claude!.cooldownUntil).toBeNull();
	expect(claude!.lastError).toBeNull();
	expect(claude!.capabilitiesProven).toBe(true);
	expect(claude!.cooldownActive).toBe(false);
	expect(claude!.status).toBe("healthy");

	// Codex: disabled (takes precedence)
	const codex = health.find((h) => h.name === "codex");
	expect(codex).toBeDefined();
	expect(codex!.enabled).toBe(false);
	expect(codex!.status).toBe("disabled");
});

// ---------------------------------------------------------------------------
// 2. Status precedence: disabled > circuit_open > cooling_down > unproven > degraded > healthy
// ---------------------------------------------------------------------------

test("status precedence: disabled overrides all others", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		enabled: false,
		circuitState: "open",
		cooldownUntil: "2026-06-13T01:00:00.000Z",
		lastError: "some error",
		capabilitiesJson: null,
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("disabled");
});

test("status precedence: circuit_open overrides cooling_down, unproven, degraded, healthy", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		circuitState: "open",
		cooldownUntil: null,
		lastError: null,
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("circuit_open");
});

test("status precedence: cooling_down overrides unproven, degraded, healthy", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		circuitState: "closed",
		cooldownUntil: "2026-06-13T01:00:00.000Z", // future
		lastError: null,
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("cooling_down");
	expect(health.cooldownActive).toBe(true);
});

test("status precedence: unproven overrides degraded and healthy", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		circuitState: "closed",
		cooldownUntil: null,
		lastError: "some error",
		capabilitiesJson: null, // unproven
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("unproven");
	expect(health.capabilitiesProven).toBe(false);
});

test("status precedence: degraded is set when error exists and capabilities proven", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		circuitState: "closed",
		cooldownUntil: null,
		lastError: "connection timeout",
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("degraded");
});

test("status precedence: healthy is set when everything is good", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		circuitState: "closed",
		cooldownUntil: null,
		lastError: null,
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("healthy");
});

// ---------------------------------------------------------------------------
// 3. cooldownActive logic: null/empty/"bad-date" are NOT active; valid future is active
// ---------------------------------------------------------------------------

test("cooldownActive returns false for null cooldownUntil", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		cooldownUntil: null,
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.cooldownActive).toBe(false);
});

test("cooldownActive returns false for empty string cooldownUntil", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		cooldownUntil: "",
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.cooldownActive).toBe(false);
});

test("cooldownActive returns false for unparseable timestamp", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		cooldownUntil: "not-a-date",
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.cooldownActive).toBe(false);
});

test("cooldownActive returns true for valid future timestamp", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		cooldownUntil: "2026-06-13T01:00:00.000Z", // 1 hour in future
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.cooldownActive).toBe(true);
});

test("cooldownActive returns false when cooldown has expired", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		cooldownUntil: "2026-06-13T00:00:00.000Z", // same as clock — NOT in the future
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.cooldownActive).toBe(false);
});

// ---------------------------------------------------------------------------
// 4. capabilitiesProven: null/empty/invalid JSON/arrays/empty objects are unproven
// ---------------------------------------------------------------------------

test("capabilitiesProven returns false for null capabilitiesJson", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: null,
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.capabilitiesProven).toBe(false);
});

test("capabilitiesProven returns false for empty string", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: "",
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.capabilitiesProven).toBe(false);
});

test("capabilitiesProven returns false for invalid JSON", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: "{not valid json}",
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.capabilitiesProven).toBe(false);
});

test("capabilitiesProven returns false for JSON array", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '["a", "b"]',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.capabilitiesProven).toBe(false);
});

test("capabilitiesProven returns false for empty JSON object", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: "{}",
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.capabilitiesProven).toBe(false);
});

test("capabilitiesProven returns true for non-empty JSON object", () => {
	insertProvider({
		name: "test",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"key": "value"}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.capabilitiesProven).toBe(true);
});

// ---------------------------------------------------------------------------
// 5. probeAuthHealth with no probe arg returns snapshot directly (fail-closed)
// ---------------------------------------------------------------------------

test("probeAuthHealth without probe returns snapshot directly", async () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		enabled: true,
		capabilitiesJson: '{"ok": true}',
	});

	const result = await probeAuthHealth(handle, clock, undefined);
	expect(result).toHaveLength(1);
	expect(result[0]!.name).toBe("claude");
	expect(result[0]!.status).toBe("healthy");
});

// ---------------------------------------------------------------------------
// 6. probeAuthHealth with probe: augments only non-structural-block providers
// ---------------------------------------------------------------------------

test("probeAuthHealth skips probe for disabled providers", async () => {
	insertProvider({
		name: "disabled-provider",
		kind: "cli",
		authMode: "subscription",
		enabled: false,
		capabilitiesJson: '{"ok": true}',
	});

	let probeWasCalled = false;
	const probeFn: ProbeFn = async () => {
		probeWasCalled = true;
		return { ok: true };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(probeWasCalled).toBe(false);
	expect(result[0]!.status).toBe("disabled");
});

test("probeAuthHealth skips probe for circuit_open providers", async () => {
	insertProvider({
		name: "open-circuit",
		kind: "cli",
		authMode: "subscription",
		circuitState: "open",
		capabilitiesJson: '{"ok": true}',
	});

	let probeWasCalled = false;
	const probeFn: ProbeFn = async () => {
		probeWasCalled = true;
		return { ok: true };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(probeWasCalled).toBe(false);
	expect(result[0]!.status).toBe("circuit_open");
});

test("probeAuthHealth skips probe for cooling_down providers", async () => {
	insertProvider({
		name: "cooling",
		kind: "cli",
		authMode: "subscription",
		cooldownUntil: "2026-06-13T01:00:00.000Z",
		capabilitiesJson: '{"ok": true}',
	});

	let probeWasCalled = false;
	const probeFn: ProbeFn = async () => {
		probeWasCalled = true;
		return { ok: true };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(probeWasCalled).toBe(false);
	expect(result[0]!.status).toBe("cooling_down");
});

test("probeAuthHealth calls probe for healthy and degraded providers", async () => {
	insertProvider({
		name: "healthy",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	insertProvider({
		name: "degraded",
		kind: "cli",
		authMode: "subscription",
		lastError: "transient",
		capabilitiesJson: '{"ok": true}',
	});

	const probeNames: string[] = [];
	const probeFn: ProbeFn = async (name) => {
		probeNames.push(name);
		return { ok: true };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(probeNames).toContain("healthy");
	expect(probeNames).toContain("degraded");
	// Both still report success since probe returned ok: true
	expect(result.find((h) => h.name === "healthy")!.status).toBe("healthy");
	expect(result.find((h) => h.name === "degraded")!.status).toBe("degraded");
});

test("probeAuthHealth downgrades to degraded when probe fails", async () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	const probeFn: ProbeFn = async () => {
		return { ok: false, detail: "API key invalid" };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(result[0]!.status).toBe("degraded");
	expect(result[0]!.lastError).toBe("API key invalid");
});

test("probeAuthHealth uses default error message when probe detail is absent", async () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	const probeFn: ProbeFn = async () => {
		return { ok: false };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(result[0]!.status).toBe("degraded");
	expect(result[0]!.lastError).toBe("probe failed");
});

test("probeAuthHealth catches probe errors and treats as failure (fail-closed)", async () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	const probeFn: ProbeFn = async () => {
		throw new Error("Network timeout");
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(result[0]!.status).toBe("degraded");
	expect(result[0]!.lastError).toBe("Network timeout");
});

test("probeAuthHealth catches non-Error throws and provides fallback message", async () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	const probeFn: ProbeFn = async () => {
		throw "string error";
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(result[0]!.status).toBe("degraded");
	expect(result[0]!.lastError).toBe("probe threw");
});

test("probeAuthHealth preserves already-degraded status when probe succeeds", async () => {
	insertProvider({
		name: "claude",
		kind: "cli",
		authMode: "subscription",
		lastError: "previous error",
		capabilitiesJson: '{"ok": true}',
	});

	const probeFn: ProbeFn = async () => {
		return { ok: true };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	// Probe success returns health unchanged — the previous error remains.
	expect(result[0]!.status).toBe("degraded");
	expect(result[0]!.lastError).toBe("previous error");
});

test("probeAuthHealth handles multiple providers with mixed probe outcomes", async () => {
	insertProvider({
		name: "healthy",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	insertProvider({
		name: "fails-probe",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: '{"ok": true}',
	});

	insertProvider({
		name: "disabled",
		kind: "cli",
		authMode: "subscription",
		enabled: false,
		capabilitiesJson: '{"ok": true}',
	});

	const probeFn: ProbeFn = async (name) => {
		if (name === "fails-probe") {
			return { ok: false, detail: "Auth failed" };
		}
		return { ok: true };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(result.find((h) => h.name === "healthy")!.status).toBe("healthy");
	expect(result.find((h) => h.name === "fails-probe")!.status).toBe("degraded");
	expect(result.find((h) => h.name === "fails-probe")!.lastError).toBe("Auth failed");
	expect(result.find((h) => h.name === "disabled")!.status).toBe("disabled");
});

// ---------------------------------------------------------------------------
// Extra hardening: fail-closed edge cases
// ---------------------------------------------------------------------------

test("snapshotAuthHealth returns empty array when no providers exist", () => {
	// No rows inserted — must return [] not throw.
	const result = snapshotAuthHealth(handle, clock);
	expect(result).toEqual([]);
});

test("half_open circuit is NOT circuit_open — falls through to unproven/degraded/healthy", () => {
	// half_open means a probe is in-flight; it is NOT the same as "open".
	// The status precedence only maps circuitState==="open" to "circuit_open".
	// A half_open + no cooldown + capabilities proven should yield "healthy".
	insertProvider({
		name: "half-open-provider",
		kind: "cli",
		authMode: "subscription",
		circuitState: "half_open",
		cooldownUntil: null,
		lastError: null,
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.circuitState).toBe("half_open");
	// half_open does NOT map to "circuit_open" — it is treated as closed for status.
	expect(health.status).toBe("healthy");
});

test("half_open circuit with last_error is degraded (not circuit_open)", () => {
	insertProvider({
		name: "half-open-degraded",
		kind: "cli",
		authMode: "subscription",
		circuitState: "half_open",
		lastError: "probe pending",
		capabilitiesJson: '{"ok": true}',
	});

	const health = snapshotAuthHealth(handle, clock)[0]!;
	expect(health.status).toBe("degraded");
});

test("probeAuthHealth calls probe for unproven providers (probe can downgrade)", async () => {
	// An unproven provider (no capabilities) is still probed — the probe may
	// confirm the credential is live even if conformance hasn't run yet.
	insertProvider({
		name: "unproven",
		kind: "cli",
		authMode: "subscription",
		capabilitiesJson: null,
	});

	let probeWasCalled = false;
	const probeFn: ProbeFn = async () => {
		probeWasCalled = true;
		return { ok: false, detail: "bad key" };
	};

	const result = await probeAuthHealth(handle, clock, probeFn);
	expect(probeWasCalled).toBe(true);
	// Downgraded from unproven to degraded because probe failed.
	expect(result[0]!.status).toBe("degraded");
	expect(result[0]!.lastError).toBe("bad key");
});

test("provider isolation: health of one provider does not bleed into another", () => {
	// Verify cross-vendor isolation: an open circuit on provider A must NOT
	// affect provider B's health status.
	insertProvider({
		name: "vendor-a",
		kind: "cli",
		authMode: "subscription",
		circuitState: "open",
		capabilitiesJson: '{"ok": true}',
	});
	insertProvider({
		name: "vendor-b",
		kind: "api",
		authMode: "api_key",
		circuitState: "closed",
		capabilitiesJson: '{"ok": true}',
	});

	const result = snapshotAuthHealth(handle, clock);
	expect(result.find((h) => h.name === "vendor-a")!.status).toBe("circuit_open");
	expect(result.find((h) => h.name === "vendor-b")!.status).toBe("healthy");
});
