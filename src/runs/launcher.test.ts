/**
 * Launcher tests.
 *
 *   (a) FakeLauncher: launch, isAlive, kill semantics — pure in-memory.
 *   (b) TmuxLauncher: launch a trivial `sleep 1` session, isAlive true, kill,
 *       isAlive false — gated on tmux being on PATH.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { FakeLauncher, TmuxLauncher, type LaunchSpec } from "./launcher.ts";

// ---------------------------------------------------------------------------
// (a) FakeLauncher

describe("FakeLauncher", () => {
	let launcher: FakeLauncher;
	const spec: LaunchSpec = {
		runId: 1,
		cwd: "/tmp",
		command: ["echo", "hello"],
		env: {},
		sessionName: "ns-test-1",
	};

	beforeEach(() => {
		launcher = new FakeLauncher();
	});

	test("launch returns a handle with sessionName", async () => {
		const handle = await launcher.launch(spec);
		expect(handle.sessionName).toBe("ns-test-1");
	});

	test("launched session is alive", async () => {
		const handle = await launcher.launch(spec);
		expect(await launcher.isAlive(handle)).toBe(true);
	});

	test("isAlive returns false for unknown session", async () => {
		expect(await launcher.isAlive({ sessionName: "no-such-session" })).toBe(false);
	});

	test("kill marks session as dead", async () => {
		const handle = await launcher.launch(spec);
		await launcher.kill(handle);
		expect(await launcher.isAlive(handle)).toBe(false);
	});

	test("kill on unknown session is a no-op (does not throw)", async () => {
		await expect(launcher.kill({ sessionName: "gone" })).resolves.toBeUndefined();
	});

	test("wasLaunched and wasKilled helpers", async () => {
		expect(launcher.wasLaunched("ns-test-1")).toBe(false);
		const handle = await launcher.launch(spec);
		expect(launcher.wasLaunched("ns-test-1")).toBe(true);
		expect(launcher.wasKilled("ns-test-1")).toBe(false);
		await launcher.kill(handle);
		expect(launcher.wasKilled("ns-test-1")).toBe(true);
	});

	test("markDead marks session as dead without going through kill()", async () => {
		await launcher.launch(spec);
		launcher.markDead("ns-test-1");
		expect(await launcher.isAlive({ sessionName: "ns-test-1" })).toBe(false);
	});

	test("multiple sessions tracked independently", async () => {
		const spec2: LaunchSpec = { ...spec, sessionName: "ns-test-2" };
		const h1 = await launcher.launch(spec);
		const h2 = await launcher.launch(spec2);
		await launcher.kill(h1);
		expect(await launcher.isAlive(h1)).toBe(false);
		expect(await launcher.isAlive(h2)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (b) TmuxLauncher — gated on tmux being on PATH

const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;

describe("TmuxLauncher (tmux-gated)", () => {
	// Generate a unique session name per test run to avoid collisions.
	const sessionName = `ns-test-launcher-${Date.now()}`;

	test(
		"launch sleep 1 session, isAlive true, kill, isAlive false",
		async () => {
			if (!tmuxAvailable) {
				console.log("skip: tmux not found on PATH");
				return;
			}

			const launcher = new TmuxLauncher();
			const spec: LaunchSpec = {
				runId: 9999,
				cwd: "/tmp",
				command: ["sleep", "10"],
				env: {},
				sessionName,
			};

			const handle = await launcher.launch(spec);
			expect(handle.sessionName).toBe(sessionName);

			// Session should be alive.
			expect(await launcher.isAlive(handle)).toBe(true);

			// Kill the session.
			await launcher.kill(handle);

			// Give tmux a moment to clean up.
			await new Promise<void>((r) => setTimeout(r, 100));

			// Session should now be dead.
			expect(await launcher.isAlive(handle)).toBe(false);
		},
		{ timeout: 10_000 },
	);
});
