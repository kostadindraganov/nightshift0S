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
