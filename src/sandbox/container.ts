/**
 * Container sandbox runner (BLUEPRINT §V3, Phase 7).
 *
 * WHY: Provides an opt-in isolation level ABOVE the existing worktree-only
 * sandbox. When enabled, each run executes inside a Docker/podman container
 * with explicit network and filesystem limits. The container runtime is
 * NEVER imported — it is invoked via the injectable `exec` seam so the argv
 * builder and run path are hermetically testable on macOS.
 *
 * FAIL-CLOSED CONTRACT: container execution is Linux-only. On any non-Linux
 * platform `run` throws `ContainerUnavailableError` BEFORE any exec call.
 * There is NO "warn and continue unfiltered" path. This mirrors egress/apply.ts.
 *
 * SECRETS: spec.env entries are passed as individual `-e KEY=VALUE` flags.
 * process.env is NEVER merged into the container environment. Tokens/keys
 * MUST NOT appear in argv, logs, errors, or return values.
 *
 * All side effects (exec, platform) are injectable via `makeContainerRunner`
 * so the pure argv builder and the run sequencing are unit-testable on macOS
 * with fakes — no real docker/podman, no root. Live enforcement is
 * LINUX-VERIFY-ONLY at runtime.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Container runtime configuration — mirrors config.container minus `enabled`.
 * Consumed from config.container by the orchestrator; passed here as a plain
 * value so this module has no config.ts import.
 */
export interface ContainerConfig {
	runtime: string;
	image: string;
	network: string;
	memLimit: string;
	cpuLimit: string;
}

/** A bind-mount from host → container. */
export interface ContainerMount {
	source: string;
	target: string;
	readonly?: boolean;
}

/** Per-run specification: workdir, mounts, env, and the command to run. */
export interface ContainerSpec {
	workdir: string;
	mounts: ContainerMount[];
	/** Only these entries reach the container. Host env is NEVER merged. */
	env?: Record<string, string>;
	cmd: string[];
}

/** Thrown when the container runtime is unavailable or the platform is not Linux. */
export class ContainerUnavailableError extends Error {
	override readonly name = "ContainerUnavailableError";

	constructor(message: string) {
		super(message);
	}
}

/** Injectable exec seam — production binds this to execFile; tests pass a fake. */
export type ExecFn = (
	bin: string,
	args: string[],
	opts: { cwd?: string },
) => Promise<{ stdout: string; exitCode?: number }>;

/** Result of a container run. */
export interface ContainerRunner {
	run(
		cfg: ContainerConfig,
		spec: ContainerSpec,
	): Promise<{ stdout: string; exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Pure argv builder
// ---------------------------------------------------------------------------

/**
 * Pure: build the full runtime argv for a container run.
 *
 * Emitted shape:
 *   <runtime> run --rm
 *     --network <network>
 *     --memory <memLimit>
 *     --cpus <cpuLimit>
 *     [-v source:target[:ro]] ...
 *     -w <workdir>
 *     [-e KEY=VALUE] ...   ← ONLY spec.env; host env is NEVER included
 *     <image>
 *     <cmd...>
 *
 * No Date.now() / Math.random() — fully deterministic.
 */
export function buildContainerArgv(
	cfg: ContainerConfig,
	spec: ContainerSpec,
): string[] {
	const argv: string[] = [
		"run",
		"--rm",
		"--network",
		cfg.network,
		"--memory",
		cfg.memLimit,
		"--cpus",
		cfg.cpuLimit,
	];

	for (const mount of spec.mounts) {
		const flag = mount.readonly
			? `${mount.source}:${mount.target}:ro`
			: `${mount.source}:${mount.target}`;
		argv.push("-v", flag);
	}

	argv.push("-w", spec.workdir);

	if (spec.env) {
		for (const [key, value] of Object.entries(spec.env)) {
			argv.push("-e", `${key}=${value}`);
		}
	}

	argv.push(cfg.image);
	argv.push(...spec.cmd);

	return argv;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a ContainerRunner with injected side effects. The exported
 * `containerRunner` const calls this with the real exec + os.platform.
 */
export function makeContainerRunner(deps: {
	exec: ExecFn;
	platform: () => string;
}): ContainerRunner {
	return {
		async run(cfg, spec) {
			if (deps.platform() !== "linux") {
				throw new ContainerUnavailableError(
					`container sandbox requires Linux; refusing on platform "${deps.platform()}" (fail-closed)`,
				);
			}

			const argv = buildContainerArgv(cfg, spec);
			const result = await deps.exec(cfg.runtime, argv, {
				cwd: spec.workdir,
			});

			return {
				stdout: result.stdout,
				exitCode: result.exitCode ?? 0,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Production wiring — real execFile + os.platform
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const realExec: ExecFn = async (bin, args, opts) => {
	const { stdout } = await execFileAsync(bin, args, {
		cwd: opts.cwd,
		// NEVER merge process.env — the container gets only spec.env via -e flags.
		timeout: 10 * 60 * 1000,
	});
	return { stdout };
};

/** The production container runner (real side effects). */
export const containerRunner: ContainerRunner = makeContainerRunner({
	exec: realExec,
	platform: () => os.platform(),
});
