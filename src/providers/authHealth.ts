/**
 * WHY: Auth health panel (BLUEPRINT §3.9) surfaces subscription login state,
 * key validity, and circuit/cooldown status BEFORE runs break. This is a
 * pure read over the providers table — no writes, no side effects — so
 * the panel is always safe to query at any time without disturbing capacity
 * pool state. An optional live probe hook lets integrations add an active
 * key-ping layer on top of the stored-state snapshot, but probes are
 * fail-closed: never run in tests, never block the snapshot path.
 *
 * Status precedence (fail-closed ordering — most restrictive first):
 *   disabled       → enabled flag is false
 *   circuit_open   → circuit_state = "open"
 *   cooling_down   → cooldown_until is in the future
 *   unproven       → capabilities_json absent or parses to an empty object
 *   degraded       → last_error set (circuit closed, no active cooldown)
 *   healthy        → everything looks good
 */

import { providers, type ProviderRow } from "../db/schema.ts";
import type { DbHandle } from "../db/client.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProviderHealth {
	name: string;
	kind: string;
	authMode: string;
	enabled: boolean;
	circuitState: string;
	cooldownUntil: string | null;
	/** True when cooldownUntil is a valid future timestamp relative to `now`. */
	cooldownActive: boolean;
	lastError: string | null;
	/** True when capabilitiesJson parses to a non-empty object. */
	capabilitiesProven: boolean;
	status: "healthy" | "degraded" | "cooling_down" | "circuit_open" | "disabled" | "unproven";
}

/**
 * Optional live-probe hook. Injected by integrations; never called in tests.
 * Fail-closed: if the hook throws, the caller catches and treats it as
 * { ok: false, detail: error.message }.
 */
export type ProbeFn = (name: string) => Promise<{ ok: boolean; detail?: string }>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Is `cooldownUntil` a valid timestamp strictly in the future relative to
 * `now`? Mirrors the logic in capacity.ts (cooldownActive helper) so the
 * two surfaces agree on what "active cooldown" means. A null, empty, or
 * unparseable value is treated as NOT cooling down (fail-open for this
 * secondary block — the circuit gate above it is the real guard).
 */
function isCooldownActive(cooldownUntil: string | null, now: Date): boolean {
	if (cooldownUntil === null || cooldownUntil === "") return false;
	const until = Date.parse(cooldownUntil);
	if (Number.isNaN(until)) return false;
	return until > now.getTime();
}

/**
 * Does capabilitiesJson parse to a non-empty object?
 * Absent / null / empty string / invalid JSON → false.
 * Parsed value must be a non-null object with at least one key.
 */
function isCapabilitiesProven(capabilitiesJson: string | null | undefined): boolean {
	if (!capabilitiesJson) return false;
	try {
		const parsed = JSON.parse(capabilitiesJson);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
		return Object.keys(parsed).length > 0;
	} catch {
		return false;
	}
}

/**
 * Derive a ProviderHealth from a raw ProviderRow and a reference timestamp.
 * Status precedence is fail-closed (most restrictive first).
 */
function deriveHealth(row: ProviderRow, now: Date): ProviderHealth {
	const cooldownActive = isCooldownActive(row.cooldownUntil, now);
	const capabilitiesProven = isCapabilitiesProven(row.capabilitiesJson);

	// Determine status in fail-closed precedence order.
	let status: ProviderHealth["status"];
	if (!row.enabled) {
		status = "disabled";
	} else if (row.circuitState === "open") {
		status = "circuit_open";
	} else if (cooldownActive) {
		status = "cooling_down";
	} else if (!capabilitiesProven) {
		status = "unproven";
	} else if (row.lastError !== null && row.lastError !== "") {
		status = "degraded";
	} else {
		status = "healthy";
	}

	return {
		name: row.name,
		kind: row.kind,
		authMode: row.authMode,
		enabled: row.enabled,
		circuitState: row.circuitState,
		cooldownUntil: row.cooldownUntil ?? null,
		cooldownActive,
		lastError: row.lastError ?? null,
		capabilitiesProven,
		status,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all provider rows and derive a ProviderHealth for each.
 * Pure read — no writes, no side effects, always safe to call.
 */
export function snapshotAuthHealth(handle: DbHandle, now: Date): ProviderHealth[] {
	const rows = handle.db.select().from(providers).all();
	return rows.map((row) => deriveHealth(row, now));
}

/**
 * Like snapshotAuthHealth but with an optional live probe.
 *
 * When `probe` is provided, each provider's result is augmented: if the
 * stored status is "healthy" or "degraded" but the live probe fails, the
 * status is downgraded to "degraded" and lastError is set to the probe's
 * detail (or "probe failed"). Probe errors are caught and treated as
 * { ok: false, detail: error.message } — fail-closed, never throws.
 *
 * When `probe` is absent, this is identical to snapshotAuthHealth.
 *
 * IMPORTANT: probe is NEVER called in tests (tests pass no probe argument).
 */
export async function probeAuthHealth(
	handle: DbHandle,
	now: Date,
	probe?: ProbeFn,
): Promise<ProviderHealth[]> {
	const snapshot = snapshotAuthHealth(handle, now);

	// No probe → return the stored-state snapshot directly.
	if (probe === undefined) return snapshot;

	// With probe: augment each health record. Only probe providers that are
	// not already disabled/circuit_open/cooling_down (no point probing
	// a provider we've already refused for structural reasons).
	return Promise.all(
		snapshot.map(async (health) => {
			if (
				health.status === "disabled" ||
				health.status === "circuit_open" ||
				health.status === "cooling_down"
			) {
				return health;
			}
			// Probe this provider — fail-closed: catch all errors.
			let probeResult: { ok: boolean; detail?: string };
			try {
				probeResult = await probe(health.name);
			} catch (err) {
				probeResult = {
					ok: false,
					detail: err instanceof Error ? err.message : "probe threw",
				};
			}
			if (probeResult.ok) return health;
			// Probe failed — downgrade to degraded.
			return {
				...health,
				status: "degraded" as const,
				lastError: probeResult.detail ?? "probe failed",
			};
		}),
	);
}
