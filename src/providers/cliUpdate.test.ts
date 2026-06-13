/**
 * Tests for cliUpdate.ts — ≤6 cases, hermetic (no real exec/which).
 *
 * Coverage:
 *  1. parseSemver: valid extraction from noisy --version output
 *  2. parseSemver: returns null for strings with no x.y.z triplet
 *  3. needsUpdate: true when installed < latest (both parseable)
 *  4. needsUpdate: false when either argument is null
 *  5. status: returns installed=null when which→false (binary absent)
 *  6. update: FAIL-SOFT — returns {ok:false} when exec throws, never throws
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_CLI_TARGETS, makeCliUpdater, needsUpdate, parseSemver } from "./cliUpdate.ts";

// ---------------------------------------------------------------------------
// 1. parseSemver — valid
// ---------------------------------------------------------------------------
describe("parseSemver", () => {
	it("extracts first x.y.z from noisy version output", () => {
		expect(parseSemver("claude/1.2.3 darwin-arm64")).toEqual([1, 2, 3]);
		expect(parseSemver("v0.10.5")).toEqual([0, 10, 5]);
		expect(parseSemver("2.0.0")).toEqual([2, 0, 0]);
	});

	// ---------------------------------------------------------------------------
	// 2. parseSemver — invalid
	// ---------------------------------------------------------------------------
	it("returns null when no x.y.z triplet is present", () => {
		expect(parseSemver("not a version")).toBeNull();
		expect(parseSemver("1.2")).toBeNull();
		expect(parseSemver("")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3. needsUpdate — true when installed < latest
// ---------------------------------------------------------------------------
describe("needsUpdate", () => {
	it("returns true when installed is strictly less than latest", () => {
		expect(needsUpdate("1.0.0", "1.0.1")).toBe(true);
		expect(needsUpdate("1.2.3", "2.0.0")).toBe(true);
		expect(needsUpdate("0.9.9", "1.0.0")).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// 4. needsUpdate — false when either null or same/newer
	// ---------------------------------------------------------------------------
	it("returns false when either argument is null or installed >= latest", () => {
		expect(needsUpdate(null, "1.0.0")).toBe(false);
		expect(needsUpdate("1.0.0", null)).toBe(false);
		expect(needsUpdate(null, null)).toBe(false);
		expect(needsUpdate("1.0.0", "1.0.0")).toBe(false);
		expect(needsUpdate("2.0.0", "1.9.9")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. status: installed=null when which→false
// ---------------------------------------------------------------------------
describe("makeCliUpdater", () => {
	it("returns installed=null when the binary is absent (which→false)", async () => {
		const updater = makeCliUpdater({
			which: async () => false,
			exec: async () => { throw new Error("should not be called"); },
		});

		const results = await updater.status([
			{ provider: "claude", bin: "claude", versionArgs: ["--version"] },
		]);

		expect(results).toHaveLength(1);
		expect(results[0]!.installed).toBeNull();
		expect(results[0]!.latest).toBeNull();
		expect(results[0]!.updateAvailable).toBe(false);
		expect(results[0]!.error).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// 6. update FAIL-SOFT: {ok:false} when exec throws, never throws itself
	// -------------------------------------------------------------------------
	it("update() returns {ok:false} when exec throws and does NOT throw itself", async () => {
		const updater = makeCliUpdater({
			which: async () => true,
			exec: async () => { throw new Error("network error"); },
		});

		let result: { ok: boolean; error?: string };
		// Must not throw.
		await expect(
			(async () => {
				result = await updater.update({
					provider: "claude",
					bin: "claude",
					versionArgs: ["--version"],
					updateArgs: ["update"],
				});
			})(),
		).resolves.toBeUndefined();

		// @ts-ignore assigned above
		expect(result.ok).toBe(false);
		// @ts-ignore assigned above
		expect(typeof result.error).toBe("string");
	});
});
