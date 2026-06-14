/**
 * Preview environment unit tests.
 *
 * Tests are fully deterministic: clocks are injected constants, deployer
 * is a local fake. No DB, no network, no live deps.
 *
 * The new sections cover:
 *   - CommandDeployer: deploy allocates URL + calls command with args as array;
 *     teardown calls its command; non-zero exit throws (recorded as "failed").
 *   - makeDeployer: disabled → FailClosedDeployer; enabled + commands →
 *     CommandDeployer; enabled but no commands → FailClosedDeployer.
 *   - startPreviewReaper: fires reapIdle on the injected manager on interval.
 */

import { describe, it, expect } from "bun:test";
import {
	allocateUrl,
	isIdle,
	makePreviewManager,
	CommandDeployer,
	makeDeployer,
	startPreviewReaper,
	FailClosedDeployer,
	type Deployer,
	type PreviewEnv,
	type CommandRunner,
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

// ---------------------------------------------------------------------------
// Fake CommandRunner helpers
// ---------------------------------------------------------------------------

function makeOkRunner(exitCode = 0): { runner: CommandRunner; calls: string[][] } {
	const calls: string[][] = [];
	const runner: CommandRunner = async (args) => {
		calls.push(args);
		return exitCode;
	};
	return { runner, calls };
}

function makeFailRunner(exitCode = 1): { runner: CommandRunner; calls: string[][] } {
	const calls: string[][] = [];
	const runner: CommandRunner = async (args) => {
		calls.push(args);
		return exitCode;
	};
	return { runner, calls };
}

// ---------------------------------------------------------------------------
// CommandDeployer tests
// ---------------------------------------------------------------------------

describe("CommandDeployer — deploy", () => {
	it("passes deploy command + runId + url as array (no shell interpolation)", async () => {
		const { runner, calls } = makeOkRunner();
		const deployer = new CommandDeployer({
			deployCommand: ["/usr/local/bin/preview-deploy.sh"],
			teardownCommand: ["/usr/local/bin/preview-teardown.sh"],
			run: runner,
		});

		await deployer.deploy(42, "run-42.preview.example.com");

		expect(calls).toHaveLength(1);
		// Args are passed as a plain array — never interpolated into a shell string.
		expect(calls[0]).toEqual([
			"/usr/local/bin/preview-deploy.sh",
			"42",
			"run-42.preview.example.com",
		]);
	});

	it("allocates URL via makePreviewManager + CommandDeployer and status is 'live'", async () => {
		const { runner } = makeOkRunner();
		const deployer = new CommandDeployer({
			deployCommand: ["deploy.sh"],
			teardownCommand: ["teardown.sh"],
			run: runner,
		});
		const mgr = makePreviewManager({ deployer, domain: "p.test" });

		const env = await mgr.create(7, 1000);

		expect(env.status).toBe("live");
		expect(env.url).toBe("run-7.p.test");
	});

	it("throws when command exits non-zero, causing PreviewManager to record 'failed'", async () => {
		const { runner } = makeFailRunner(2);
		const deployer = new CommandDeployer({
			deployCommand: ["deploy.sh"],
			teardownCommand: ["teardown.sh"],
			run: runner,
		});
		const mgr = makePreviewManager({ deployer, domain: "p.test" });

		const env = await mgr.create(9, 1000);

		// Non-zero exit → deployer throws → create() records "failed" (fail-closed).
		expect(env.status).toBe("failed");
	});
});

describe("CommandDeployer — teardown", () => {
	it("passes teardown command + runId as array", async () => {
		const { runner, calls } = makeOkRunner();
		const deployer = new CommandDeployer({
			deployCommand: ["deploy.sh"],
			teardownCommand: ["/usr/local/bin/preview-teardown.sh", "--force"],
			run: runner,
		});

		await deployer.teardown(42);

		// calls[0] is empty (no deploy was called); teardown is the first call here.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["/usr/local/bin/preview-teardown.sh", "--force", "42"]);
	});

	it("teardown runs the command via reap()", async () => {
		const { runner, calls } = makeOkRunner();
		const deployer = new CommandDeployer({
			deployCommand: ["deploy.sh"],
			teardownCommand: ["teardown.sh"],
			run: runner,
		});
		const mgr = makePreviewManager({ deployer, domain: "p.test" });
		await mgr.create(5, 0);

		await mgr.reap(5, 100);

		// calls[0] = deploy, calls[1] = teardown.
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(["teardown.sh", "5"]);
		expect(mgr.get(5)?.status).toBe("reaped");
	});
});

// ---------------------------------------------------------------------------
// makeDeployer — selector tests
// ---------------------------------------------------------------------------

describe("makeDeployer", () => {
	it("returns FailClosedDeployer when preview is disabled", () => {
		const { runner } = makeOkRunner();
		const deployer = makeDeployer({ enabled: false }, runner);
		expect(deployer).toBeInstanceOf(FailClosedDeployer);
	});

	it("returns FailClosedDeployer when enabled but no commands configured", () => {
		const { runner } = makeOkRunner();
		const deployer = makeDeployer(
			{ enabled: true, deployCommand: [], teardownCommand: [] },
			runner,
		);
		expect(deployer).toBeInstanceOf(FailClosedDeployer);
	});

	it("returns FailClosedDeployer when enabled but commands partially absent", () => {
		const { runner } = makeOkRunner();
		// deployCommand set but teardownCommand missing.
		const deployer = makeDeployer(
			{ enabled: true, deployCommand: ["deploy.sh"] },
			runner,
		);
		expect(deployer).toBeInstanceOf(FailClosedDeployer);
	});

	it("returns CommandDeployer when enabled and both commands configured", () => {
		const { runner } = makeOkRunner();
		const deployer = makeDeployer(
			{
				enabled: true,
				deployCommand: ["deploy.sh"],
				teardownCommand: ["teardown.sh"],
			},
			runner,
		);
		expect(deployer).toBeInstanceOf(CommandDeployer);
	});

	it("FailClosedDeployer path: deploy causes 'failed' status (no command run)", async () => {
		const { runner, calls } = makeOkRunner();
		// disabled → FailClosedDeployer regardless of commands.
		const deployer = makeDeployer(
			{
				enabled: false,
				deployCommand: ["deploy.sh"],
				teardownCommand: ["teardown.sh"],
			},
			runner,
		);
		const mgr = makePreviewManager({ deployer, domain: "p.test" });
		const env = await mgr.create(99, 0);

		// FailClosedDeployer throws → status "failed".
		expect(env.status).toBe("failed");
		// The injected runner was never called — FailClosedDeployer doesn't use it.
		expect(calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// startPreviewReaper tests
// ---------------------------------------------------------------------------

describe("startPreviewReaper", () => {
	it("calls reapIdle on each tick with the configured idleReapMinutes", async () => {
		// Fake manager that records reapIdle calls.
		const reapIdleCalls: Array<{ now: number; minutes: number }> = [];
		const fakeManager = {
			create: async () => ({ runId: 0, url: "", status: "live" as const, createdAt: 0, lastActiveAt: 0 }),
			touch: () => true,
			get: () => undefined,
			list: () => [],
			reap: async () => true,
			reapIdle: async (now: number, idleReapMinutes: number) => {
				reapIdleCalls.push({ now, minutes: idleReapMinutes });
				return [];
			},
		};

		let fakeNow = 1000;
		const reaper = startPreviewReaper({
			manager: fakeManager,
			idleReapMinutes: 15,
			intervalMs: 10, // short interval for the test
			now: () => fakeNow,
		});

		// Wait two ticks.
		await new Promise((resolve) => setTimeout(resolve, 35));
		reaper.stop();

		expect(reapIdleCalls.length).toBeGreaterThanOrEqual(2);
		for (const call of reapIdleCalls) {
			expect(call.now).toBe(1000);
			expect(call.minutes).toBe(15);
		}
	});

	it("stop() prevents further reapIdle calls", async () => {
		const reapIdleCalls: number[] = [];
		const fakeManager = {
			create: async () => ({ runId: 0, url: "", status: "live" as const, createdAt: 0, lastActiveAt: 0 }),
			touch: () => true,
			get: () => undefined,
			list: () => [],
			reap: async () => true,
			reapIdle: async (now: number) => {
				reapIdleCalls.push(now);
				return [];
			},
		};

		const reaper = startPreviewReaper({
			manager: fakeManager,
			idleReapMinutes: 30,
			intervalMs: 10,
			now: () => 500,
		});

		// Stop immediately before any tick fires.
		reaper.stop();
		const countAfterStop = reapIdleCalls.length;

		// Wait to confirm no more calls arrive.
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(reapIdleCalls.length).toBe(countAfterStop);
	});
});
