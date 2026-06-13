/**
 * containerSpawn tests (makeIsolatedSpawn factory).
 *
 * Matrix (5 hermetic cases):
 *   1. When containerConfig.enabled is false → delegates to bwrapFallback.
 *   2. When containerConfig.enabled is true and platform is not Linux →
 *      throws ContainerUnavailableError (fail-closed).
 *   3. When containerConfig.enabled is true, platform is Linux, but runtime
 *      is unavailable → throws ContainerUnavailableError (fail-closed).
 *   4. When containerConfig.enabled is true, platform is Linux, and runtime
 *      is available → returns container argv prefix (from buildInteractiveContainerArgv).
 *   5. Missing bwrapFallback when containerConfig.enabled is false →
 *      throws error (fail-closed).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { SandboxProfile } from "../sandbox/profile.ts";
import type { NightshiftConfig } from "../config/config.ts";
import { ContainerUnavailableError, makeIsolatedSpawn } from "./containerSpawn.ts";

// ---------------------------------------------------------------------------
// Fixtures

let baseProfile: SandboxProfile;
let baseContainerConfig: NightshiftConfig["container"];

beforeEach(() => {
	baseProfile = {
		worktreePath: "/tmp/worktree",
		taskHome: "/tmp/task-home",
		providerAuthDir: "/tmp/auth",
		envAllowlist: {
			PATH: "/usr/bin:/bin",
			USER: "testuser",
		},
	};

	baseContainerConfig = {
		enabled: false,
		runtime: "docker",
		image: "nightshift:latest",
		network: "none",
		memLimit: "4g",
		cpuLimit: "2",
	};
});

// ---------------------------------------------------------------------------
// Case 1: containerConfig.enabled is false → delegates to bwrapFallback

test("when container disabled, delegates to bwrapFallback", async () => {
	const innerCommand = ["echo", "hello"];
	let fallbackCalled = false;
	let receivedInner: string[] | null = null;
	let receivedProfile: SandboxProfile | null = null;

	const spawn = makeIsolatedSpawn({
		containerConfig: baseContainerConfig,
		deps: {
			bwrapFallback: async (inner, prof) => {
				fallbackCalled = true;
				receivedInner = inner;
				receivedProfile = prof;
				return ["bwrap", ...inner];
			},
		},
	});

	const result = await spawn(innerCommand, baseProfile);

	expect(fallbackCalled).toBe(true);
	expect(receivedInner!).toEqual(innerCommand);
	expect(receivedProfile!).toEqual(baseProfile);
	expect(result[0]).toBe("bwrap");
});

// ---------------------------------------------------------------------------
// Case 2: Non-Linux + container enabled → ContainerUnavailableError

test("when container enabled on non-Linux platform, throws ContainerUnavailableError", async () => {
	const spawn = makeIsolatedSpawn({
		containerConfig: { ...baseContainerConfig, enabled: true },
		deps: {
			platform: () => "darwin",
		},
	});

	let threw = false;
	let error: Error | null = null;

	try {
		await spawn(["echo", "hi"], baseProfile);
	} catch (e) {
		threw = true;
		error = e as Error;
	}

	expect(threw).toBe(true);
	expect(error).toBeInstanceOf(ContainerUnavailableError);
	expect((error as ContainerUnavailableError).name).toBe("ContainerUnavailableError");
	if (error) {
		expect(error.message).toContain("Linux");
		expect(error.message).toContain("darwin");
	}
});

// ---------------------------------------------------------------------------
// Case 3: Linux + container enabled + runtime unavailable → ContainerUnavailableError

test("when container enabled, platform is Linux, but runtime unavailable, throws ContainerUnavailableError", async () => {
	const spawn = makeIsolatedSpawn({
		containerConfig: { ...baseContainerConfig, enabled: true, runtime: "podman" },
		deps: {
			platform: () => "linux",
			runtimeAvailable: async () => false,
		},
	});

	let threw = false;
	let error: Error | null = null;

	try {
		await spawn(["echo", "hi"], baseProfile);
	} catch (e) {
		threw = true;
		error = e as Error;
	}

	expect(threw).toBe(true);
	expect(error).toBeInstanceOf(ContainerUnavailableError);
	const msg = (error as ContainerUnavailableError).message;
	expect(msg).toContain("podman");
	expect(msg).toContain("not found");
});

// ---------------------------------------------------------------------------
// Case 4: Linux + container enabled + runtime available → returns container argv

test("when container enabled, platform is Linux, and runtime available, returns container argv", async () => {
	const spawn = makeIsolatedSpawn({
		containerConfig: { ...baseContainerConfig, enabled: true },
		deps: {
			platform: () => "linux",
			runtimeAvailable: async () => true,
		},
	});

	const innerCommand = ["python", "script.py"];
	const result = await spawn(innerCommand, baseProfile);

	// Result must start with ["run", "--rm", ...] (runtime prepended by tmux).
	expect(result[0]).toBe("run");
	expect(result[1]).toBe("--rm");

	// Network, memory, CPU limits must be present.
	expect(result).toContain("--network");
	expect(result).toContain("none");
	expect(result).toContain("--memory");
	expect(result).toContain("4g");
	expect(result).toContain("--cpus");
	expect(result).toContain("2");

	// Volume mounts for worktree, taskHome, providerAuthDir.
	const argStr = result.join(" ");
	expect(argStr).toContain("/tmp/worktree:/tmp/worktree");
	expect(argStr).toContain("/tmp/task-home:/tmp/task-home");
	expect(argStr).toContain("/tmp/auth:/tmp/auth:ro");

	// Working directory.
	expect(result).toContain("-w");
	expect(result).toContain("/tmp/worktree");

	// Interactive flag (-i) must be present.
	expect(result).toContain("-i");

	// Image name must be present.
	expect(result).toContain("nightshift:latest");

	// Inner command must be appended at the end.
	const pythonIdx = result.indexOf("python");
	const scriptIdx = result.indexOf("script.py");
	expect(pythonIdx).toBeGreaterThan(-1);
	expect(scriptIdx).toBeGreaterThan(-1);
	expect(scriptIdx).toBeGreaterThan(pythonIdx);
});

// ---------------------------------------------------------------------------
// Case 5: Container disabled + no bwrapFallback → throws error

test("when container disabled but no bwrapFallback provided, throws error", async () => {
	const spawn = makeIsolatedSpawn({
		containerConfig: { ...baseContainerConfig, enabled: false },
		deps: {
			// Intentionally omit bwrapFallback
		},
	});

	let threw = false;
	let error: Error | null = null;

	try {
		await spawn(["echo", "test"], baseProfile);
	} catch (e) {
		threw = true;
		error = e as Error;
	}

	expect(threw).toBe(true);
	if (error) {
		expect(error.message).toContain("bwrapFallback");
		expect(error.message).toContain("enabled is false");
	}
});

// ---------------------------------------------------------------------------
// Bonus: Environment variables are passed through in container argv

test("when container enabled, env allowlist is injected into container argv", async () => {
	const profileWithEnv: SandboxProfile = {
		...baseProfile,
		envAllowlist: {
			DEBUG: "1",
			CUSTOM_VAR: "custom_value",
		},
	};

	const spawn = makeIsolatedSpawn({
		containerConfig: { ...baseContainerConfig, enabled: true },
		deps: {
			platform: () => "linux",
			runtimeAvailable: async () => true,
		},
	});

	const result = await spawn(["ls"], profileWithEnv);

	// Environment variables should appear as -e KEY=VALUE pairs.
	const resultStr = result.join(" ");
	expect(resultStr).toContain("-e");
	expect(resultStr).toContain("DEBUG=1");
	expect(resultStr).toContain("CUSTOM_VAR=custom_value");
});
