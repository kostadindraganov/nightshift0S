/**
 * Preview environment unit tests (≤6 cases).
 *
 * Tests are fully deterministic: clocks are injected constants, deployer
 * is a local fake. No DB, no network, no live deps.
 */

import { describe, it, expect } from "bun:test";
import {
	allocateUrl,
	isIdle,
	makePreviewManager,
	type Deployer,
	type PreviewEnv,
} from "./preview.ts";

// ---------------------------------------------------------------------------
// Fake deployer helpers
// ---------------------------------------------------------------------------

function okDeployer(): Deployer {
	return {
		async deploy(_runId, _url) {},
		async teardown(_runId) {},
	};
}

function throwingDeployer(): Deployer {
	return {
		async deploy(_runId, _url): Promise<void> {
			throw new Error("deploy failed");
		},
		async teardown(_runId) {},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("allocateUrl", () => {
	it("produces run-<id>.<domain> format", () => {
		expect(allocateUrl(42, "preview.example.com")).toBe("run-42.preview.example.com");
	});

	it("throws on empty domain (fail-closed)", () => {
		expect(() => allocateUrl(1, "")).toThrow();
		expect(() => allocateUrl(1, "   ")).toThrow();
	});
});

describe("makePreviewManager — create", () => {
	it("creates env with status 'live' when deployer succeeds", async () => {
		const mgr = makePreviewManager({ deployer: okDeployer(), domain: "p.test" });
		const env = await mgr.create(7, 1000);
		expect(env.status).toBe("live");
		expect(env.url).toBe("run-7.p.test");
		expect(env.runId).toBe(7);
	});

	it("records status 'failed' when deployer throws — does NOT rethrow", async () => {
		const mgr = makePreviewManager({ deployer: throwingDeployer(), domain: "p.test" });
		const env = await mgr.create(8, 1000);
		expect(env.status).toBe("failed");
		// No exception propagated — the test itself confirms no throw.
	});
});

describe("isIdle", () => {
	const base: PreviewEnv = {
		runId: 1,
		url: "run-1.p.test",
		status: "live",
		createdAt: 0,
		lastActiveAt: 0,
	};

	it("returns false for non-live env at same threshold", () => {
		const reaped: PreviewEnv = { ...base, status: "reaped", lastActiveAt: 0 };
		// 30 minutes past lastActiveAt — but not live, so never idle.
		expect(isIdle(reaped, 30 * 60_000, 30)).toBe(false);
	});

	it("returns true only when strictly greater than idle threshold", () => {
		const idleMs = 30 * 60_000;
		// At exactly the threshold: NOT idle (strictly greater required).
		expect(isIdle(base, idleMs, 30)).toBe(false);
		// One ms past: idle.
		expect(isIdle(base, idleMs + 1, 30)).toBe(true);
	});
});

describe("reapIdle", () => {
	it("reaps only idle live envs and returns their runIds", async () => {
		const mgr = makePreviewManager({ deployer: okDeployer(), domain: "p.test" });
		const t0 = 0;
		const idleMin = 30;
		const idleMs = idleMin * 60_000;

		// env 1: live, idle (lastActiveAt = t0, now = t0 + idleMs + 1)
		await mgr.create(1, t0);
		// env 2: live but NOT yet idle (touched recently)
		await mgr.create(2, t0);
		mgr.touch(2, t0 + idleMs); // lastActiveAt = idleMs, now = idleMs+1 → not yet idle

		const now = t0 + idleMs + 1;
		const reaped = await mgr.reapIdle(now, idleMin);

		expect(reaped).toEqual([1]);
		expect(mgr.get(1)?.status).toBe("reaped");
		expect(mgr.get(2)?.status).toBe("live");
	});
});
