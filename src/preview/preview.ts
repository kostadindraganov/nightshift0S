/**
 * WHY: Preview environments (BLUEPRINT §V3) give every run/PR a live URL
 * `run-<id>.<domain>`, auto-reaped when idle. This module owns:
 *
 *   allocateUrl  — pure, fail-closed URL derivation (throws on empty domain).
 *   isIdle       — pure predicate; only "live" envs are eligible for reaping.
 *   makePreviewManager — injectable factory; the deployer interface keeps the
 *     real DNS/reverse-proxy out of this module so it runs on macOS with fakes.
 *   FailClosedDeployer — default for an unwired host; deploy/teardown throw so
 *     create() records status "failed" until a real deployer is injected on Linux.
 *   CommandDeployer — concrete deployer that executes operator-provided commands
 *     through an INJECTED command runner (never shell-interpolates args). Active
 *     only when preview.enabled=true AND a deploy command is configured; otherwise
 *     FailClosedDeployer remains the default.
 *   startPreviewReaper — recurring idle-reap loop; inert when preview is disabled.
 *
 * create() does NOT rethrow a deployer failure — it records status "failed" and
 * returns the env. That is the honest fail-closed result: the caller (route, test)
 * sees the failure without an unhandled rejection.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PreviewStatus = "requested" | "live" | "reaped" | "failed";

export interface PreviewEnv {
	runId: number;
	url: string;
	status: PreviewStatus;
	createdAt: number;
	lastActiveAt: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive the preview URL for a run.
 * FAIL-CLOSED: throws if `domain` is empty or whitespace — the caller must have
 * a valid domain before any URL can be allocated.
 */
export function allocateUrl(runId: number, domain: string): string {
	if (domain.trim().length === 0) {
		throw new Error("preview domain is not configured; cannot allocate URL");
	}
	return `run-${runId}.${domain}`;
}

/**
 * Is `env` considered idle at `now`?
 * Only "live" envs are eligible — requested/reaped/failed cannot be idle.
 * Idle when: now − lastActiveAt > idleReapMinutes * 60_000  (strictly greater).
 */
export function isIdle(env: PreviewEnv, now: number, idleReapMinutes: number): boolean {
	if (env.status !== "live") return false;
	return now - env.lastActiveAt > idleReapMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Deployer interface
// ---------------------------------------------------------------------------

export interface Deployer {
	deploy(runId: number, url: string): Promise<void>;
	teardown(runId: number): Promise<void>;
}

/**
 * Default deployer for an unwired host. Both methods throw so that
 * PreviewManager.create() records status "failed" (fail-closed) rather than
 * silently pretending the environment is live.
 */
export class FailClosedDeployer implements Deployer {
	async deploy(_runId: number, _url: string): Promise<void> {
		throw new Error("preview deployer not wired on this host");
	}

	async teardown(_runId: number): Promise<void> {
		throw new Error("preview deployer not wired on this host");
	}
}

// ---------------------------------------------------------------------------
// CommandDeployer
// ---------------------------------------------------------------------------

/**
 * A command runner injectable: receives an argument array (never a shell
 * string) and returns the process exit code. Pass args as an array so
 * there is no shell-interpolation risk from runId/url values.
 *
 * The production implementation calls Bun.spawn; tests inject a fake.
 */
export type CommandRunner = (args: string[]) => Promise<number>;

export interface CommandDeployerDeps {
	/**
	 * Command + static args for deploy. The deployer appends [runId, url]
	 * as the final two positional arguments so operator scripts can consume them
	 * as "$1" and "$2" without any string interpolation on this side.
	 *
	 * Example: ["/usr/local/bin/preview-deploy.sh"]
	 */
	deployCommand: string[];
	/**
	 * Command + static args for teardown. The deployer appends [runId] as the
	 * final positional argument.
	 *
	 * Example: ["/usr/local/bin/preview-teardown.sh"]
	 */
	teardownCommand: string[];
	/**
	 * Injectable command runner. Defaults to the Bun.spawn-based production
	 * runner. Tests inject a fake.
	 */
	run: CommandRunner;
}

/**
 * Concrete deployer that executes operator-provided commands via an INJECTED
 * command runner.  Arguments are ALWAYS passed as an array — never interpolated
 * into a shell string — so runId/url values cannot perform injection.
 *
 * Activated only when preview.enabled=true AND deploy/teardown commands are
 * configured (non-empty). Otherwise the factory falls back to FailClosedDeployer.
 *
 * A non-zero exit code causes deploy() / teardown() to throw so
 * PreviewManager.create() records status "failed" (fail-closed).
 */
export class CommandDeployer implements Deployer {
	private readonly deps: CommandDeployerDeps;

	constructor(deps: CommandDeployerDeps) {
		this.deps = deps;
	}

	async deploy(runId: number, url: string): Promise<void> {
		// Pass runId and url as separate positional args — no shell interpolation.
		const args = [...this.deps.deployCommand, String(runId), url];
		const code = await this.deps.run(args);
		if (code !== 0) {
			throw new Error(`preview deploy command exited with code ${code}`);
		}
	}

	async teardown(runId: number): Promise<void> {
		// Pass runId as a separate positional arg.
		const args = [...this.deps.teardownCommand, String(runId)];
		const code = await this.deps.run(args);
		if (code !== 0) {
			throw new Error(`preview teardown command exited with code ${code}`);
		}
	}
}

/**
 * Production CommandRunner: thin wrapper around Bun.spawn. Uses arg-array
 * form — never a shell string — so no injection is possible.
 */
export async function defaultCommandRunner(args: string[]): Promise<number> {
	const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
	return proc.exited;
}

// ---------------------------------------------------------------------------
// makeDeployer — select the right Deployer from config
// ---------------------------------------------------------------------------

export interface PreviewConfig {
	enabled: boolean;
	deployCommand?: string[];
	teardownCommand?: string[];
}

/**
 * Select the correct Deployer for the given config and runner.
 *
 * - preview.enabled=false  → FailClosedDeployer (fail-closed, no commands run).
 * - preview.enabled=true AND both commands configured → CommandDeployer.
 * - preview.enabled=true but commands missing → FailClosedDeployer (fail-closed;
 *   the operator must configure commands to get real previews).
 */
export function makeDeployer(
	config: PreviewConfig,
	run: CommandRunner = defaultCommandRunner,
): Deployer {
	if (
		config.enabled &&
		config.deployCommand &&
		config.deployCommand.length > 0 &&
		config.teardownCommand &&
		config.teardownCommand.length > 0
	) {
		return new CommandDeployer({
			deployCommand: config.deployCommand,
			teardownCommand: config.teardownCommand,
			run,
		});
	}
	return new FailClosedDeployer();
}

// ---------------------------------------------------------------------------
// startPreviewReaper — recurring idle-reap loop
// ---------------------------------------------------------------------------

export interface StartPreviewReaperDeps {
	/** The preview manager whose reapIdle to call. */
	manager: PreviewManager;
	/** Idle threshold in minutes (passed to reapIdle on each tick). */
	idleReapMinutes: number;
	/** Interval in milliseconds between reap sweeps. */
	intervalMs: number;
	/** Injectable clock (default Date.now). Injected in tests. */
	now?: () => number;
}

/**
 * Start the idle-reap background loop for preview environments.
 *
 * INERT WHEN DISABLED: callers must guard on preview.enabled before calling;
 * the loop itself is unconditional once started.
 *
 * Fail-closed: a reapIdle error is logged and swallowed so the interval
 * survives individual sweep failures (consistent with agentsMdCadence pattern).
 *
 * Returns { stop() } to clear the interval.
 */
export function startPreviewReaper(deps: StartPreviewReaperDeps): { stop(): void } {
	const clockFn = deps.now ?? (() => Date.now());

	const timerId = setInterval(() => {
		void (async () => {
			try {
				const reaped = await deps.manager.reapIdle(clockFn(), deps.idleReapMinutes);
				if (reaped.length > 0) {
					console.log(`[previewReaper] reaped idle envs: ${reaped.join(", ")}`);
				}
			} catch (err) {
				console.error(
					"[previewReaper] sweep error:",
					err instanceof Error ? err.message : String(err),
				);
			}
		})();
	}, deps.intervalMs);

	return {
		stop(): void {
			clearInterval(timerId);
		},
	};
}

// ---------------------------------------------------------------------------
// PreviewManager
// ---------------------------------------------------------------------------

export interface PreviewManager {
	/** Allocate URL, register, deploy. Returns env even on deploy failure (status "failed"). */
	create(runId: number, now: number): Promise<PreviewEnv>;
	/** Update lastActiveAt. Returns false if runId is unknown. */
	touch(runId: number, now: number): boolean;
	/** Retrieve an env by runId. */
	get(runId: number): PreviewEnv | undefined;
	/** List all envs. */
	list(): PreviewEnv[];
	/** Teardown (best-effort) and mark "reaped". Returns false if unknown. */
	reap(runId: number, now: number): Promise<boolean>;
	/** Reap every idle "live" env. Returns the reaped runIds. */
	reapIdle(now: number, idleReapMinutes: number): Promise<number[]>;
}

export interface PreviewManagerDeps {
	deployer: Deployer;
	domain: string;
}

export function makePreviewManager(deps: PreviewManagerDeps): PreviewManager {
	const { deployer, domain } = deps;
	const registry = new Map<number, PreviewEnv>();

	return {
		async create(runId, now) {
			// Throws if domain is empty — fail-closed; propagates to caller.
			const url = allocateUrl(runId, domain);

			const env: PreviewEnv = {
				runId,
				url,
				status: "requested",
				createdAt: now,
				lastActiveAt: now,
			};
			registry.set(runId, env);

			try {
				await deployer.deploy(runId, url);
				env.status = "live";
			} catch {
				// Record failure; do NOT rethrow. The env is the honest result.
				env.status = "failed";
			}

			return env;
		},

		touch(runId, now) {
			const env = registry.get(runId);
			if (env === undefined) return false;
			env.lastActiveAt = now;
			return true;
		},

		get(runId) {
			return registry.get(runId);
		},

		list() {
			return [...registry.values()];
		},

		async reap(runId, now) {
			const env = registry.get(runId);
			if (env === undefined) return false;
			// Best-effort teardown — ignore errors.
			try {
				await deployer.teardown(runId);
			} catch {
				// intentional no-op
			}
			env.status = "reaped";
			env.lastActiveAt = now;
			return true;
		},

		async reapIdle(now, idleReapMinutes) {
			const idle = [...registry.values()].filter((e) => isIdle(e, now, idleReapMinutes));
			const reaped: number[] = [];
			for (const env of idle) {
				await this.reap(env.runId, now);
				reaped.push(env.runId);
			}
			return reaped;
		},
	};
}
