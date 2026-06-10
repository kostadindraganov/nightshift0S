/**
 * Provider router (BLUEPRINT §3.9 capability-gating).
 *
 * The router is the enforcement point: a driver may NOT be used for a role
 * unless its PROVEN capabilities cover all requirements for that role.
 *
 * Design contract:
 *   - Pure and deterministic — no I/O, no side effects.
 *   - Returns null (REFUSE) rather than throwing when no driver qualifies.
 *   - First-match selection: callers control priority by list order.
 *
 * Role requirements:
 *   reviewer / judge   — REQUIRE structured_output (they emit structured
 *                        verdicts/findings the pipeline parses).
 *   coder              — REQUIRES resume (ping-pong session continuity).
 *   planner / utility /
 *   experiment         — no hard caps beyond role membership and auth.
 */

import type { RunKind } from "../db/columns.ts";
import type { Capabilities, ProviderDriver } from "./types.ts";

/**
 * Return the capability keys that MUST be proven for a driver to serve `role`.
 * Missing any of these → selectDriver returns null (REFUSE).
 */
export function requiredCapabilities(role: RunKind): (keyof Capabilities)[] {
	switch (role) {
		case "reviewer":
		case "judge":
			// Must be able to emit parseable structured output for verdicts/findings.
			return ["structured_output"];

		case "coder":
			// Must be able to resume sessions for iterative ping-pong coding.
			return ["resume"];

		case "planner":
		case "utility":
		case "experiment":
			// No capability hard-requirements beyond role membership.
			return [];

		default: {
			// Exhaustiveness: TypeScript will catch new RunKind values at compile time.
			const _exhaustive: never = role;
			return _exhaustive;
		}
	}
}

/**
 * Select the first driver in `drivers` whose proven capabilities satisfy all
 * requirements for `role`. Returns null if no driver qualifies.
 *
 * A driver qualifies when:
 *   1. proven.roles includes `role` (the driver is registered for this role).
 *   2. Every capability key returned by requiredCapabilities(role) is true in
 *      the driver's proven set (the gate that makes REFUSE possible).
 */
export function selectDriver(
	drivers: { driver: ProviderDriver; proven: Capabilities }[],
	role: RunKind,
): ProviderDriver | null {
	const required = requiredCapabilities(role);

	for (const { driver, proven } of drivers) {
		// Gate 1: driver is registered for this role.
		if (!proven.roles.includes(role)) continue;

		// Gate 2: all required capabilities are proven.
		const allProven = required.every((cap) => {
			const val = proven[cap];
			if (typeof val === "boolean") return val;
			// auth / roles are arrays — not used as required capability keys today,
			// but handle defensively.
			if (Array.isArray(val)) return (val as unknown[]).length > 0;
			return false;
		});
		if (!allProven) continue;

		return driver;
	}

	return null;
}
