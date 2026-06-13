/**
 * Hermetic unit tests for src/sandbox/container.ts.
 *
 * All tests run on macOS (no docker/podman, no root). The pure argv builder
 * and the fail-closed platform gate are verified here; live container
 * execution is LINUX-VERIFY-ONLY at runtime.
 */

import { describe, it, expect } from "bun:test";
import {
	buildContainerArgv,
	makeContainerRunner,
	ContainerUnavailableError,
	type ContainerConfig,
	type ContainerSpec,
	type ExecFn,
} from "./container.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultCfg: ContainerConfig = {
	runtime: "docker",
	image: "ubuntu:22.04",
	network: "none",
	memLimit: "512m",
	cpuLimit: "1",
};

const minimalSpec: ContainerSpec = {
	workdir: "/workspace",
	mounts: [],
	cmd: ["bash", "-c", "echo hi"],
};

// ---------------------------------------------------------------------------
// 1. argv contains --network none for the default config
// ---------------------------------------------------------------------------

describe("buildContainerArgv", () => {
	it("emits --network none when cfg.network is 'none'", () => {
		const argv = buildContainerArgv(defaultCfg, minimalSpec);
		const netIdx = argv.indexOf("--network");
		expect(netIdx).toBeGreaterThan(-1);
		expect(argv[netIdx + 1]).toBe("none");
	});

	// -------------------------------------------------------------------------
	// 2. argv honors a 'bridge' network override
	// -------------------------------------------------------------------------

	it("emits --network bridge when cfg.network is 'bridge'", () => {
		const bridgeCfg: ContainerConfig = { ...defaultCfg, network: "bridge" };
		const argv = buildContainerArgv(bridgeCfg, minimalSpec);
		const netIdx = argv.indexOf("--network");
		expect(netIdx).toBeGreaterThan(-1);
		expect(argv[netIdx + 1]).toBe("bridge");
	});

	// -------------------------------------------------------------------------
	// 3. readonly mount renders source:target:ro
	// -------------------------------------------------------------------------

	it("appends :ro suffix for a readonly mount", () => {
		const spec: ContainerSpec = {
			...minimalSpec,
			mounts: [{ source: "/host/src", target: "/container/src", readonly: true }],
		};
		const argv = buildContainerArgv(defaultCfg, spec);
		const vIdx = argv.indexOf("-v");
		expect(vIdx).toBeGreaterThan(-1);
		expect(argv[vIdx + 1]).toBe("/host/src:/container/src:ro");
	});

	// -------------------------------------------------------------------------
	// 4. spec.env passes through as -e flags; host env is NOT present
	// -------------------------------------------------------------------------

	it("passes spec.env as -e flags and does not include host env", () => {
		const spec: ContainerSpec = {
			...minimalSpec,
			env: { MY_TOKEN: "secret", BUILD_NUM: "42" },
		};
		const argv = buildContainerArgv(defaultCfg, spec);

		// Both spec.env entries appear as -e KEY=VALUE pairs.
		expect(argv).toContain("MY_TOKEN=secret");
		expect(argv).toContain("BUILD_NUM=42");

		// A known host env var (HOME is always set on macOS/Linux) must NOT appear.
		const home = process.env["HOME"];
		if (home) {
			const joined = argv.join(" ");
			expect(joined).not.toContain(`HOME=${home}`);
		}

		// Verify the -e flags surround the values correctly.
		const eIndices = argv.reduce<number[]>((acc, v, i) => {
			if (v === "-e") acc.push(i);
			return acc;
		}, []);
		// One -e per env entry.
		expect(eIndices.length).toBe(2);
		for (const idx of eIndices) {
			const kv = argv[idx + 1] ?? "";
			expect(kv).toMatch(/^[^=]+=.+/);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. runner THROWS ContainerUnavailableError when platform() !== "linux"
// ---------------------------------------------------------------------------

describe("makeContainerRunner", () => {
	it("throws ContainerUnavailableError before exec when platform is not linux", async () => {
		let execCalled = false;
		const fakeExec: ExecFn = async () => {
			execCalled = true;
			return { stdout: "", exitCode: 0 };
		};

		const runner = makeContainerRunner({
			exec: fakeExec,
			platform: () => "darwin",
		});

		await expect(runner.run(defaultCfg, minimalSpec)).rejects.toBeInstanceOf(
			ContainerUnavailableError,
		);
		expect(execCalled).toBe(false);
	});

	// -------------------------------------------------------------------------
	// 6. runner calls exec with the built argv when platform() === "linux"
	// -------------------------------------------------------------------------

	it("calls exec with runtime + built argv when platform is linux", async () => {
		let capturedBin = "";
		let capturedArgs: string[] = [];

		const fakeExec: ExecFn = async (bin, args) => {
			capturedBin = bin;
			capturedArgs = args;
			return { stdout: "hello from container\n", exitCode: 0 };
		};

		const runner = makeContainerRunner({
			exec: fakeExec,
			platform: () => "linux",
		});

		const result = await runner.run(defaultCfg, minimalSpec);

		// Binary is cfg.runtime.
		expect(capturedBin).toBe("docker");

		// argv starts with "run --rm".
		expect(capturedArgs[0]).toBe("run");
		expect(capturedArgs[1]).toBe("--rm");

		// Contains the image.
		expect(capturedArgs).toContain("ubuntu:22.04");

		// Stdout and exitCode are forwarded.
		expect(result.stdout).toBe("hello from container\n");
		expect(result.exitCode).toBe(0);
	});
});
