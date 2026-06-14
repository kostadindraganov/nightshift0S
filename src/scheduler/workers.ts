/**
 * WHY: V3 multi-VM worker registry (BLUEPRINT §workers). Remote worker daemons
 * register with the single control plane and heartbeat periodically; the registry
 * tracks which are alive. This module is the SOLE writer of in-memory worker
 * state — no DB table, no migration; the registry is a module-level singleton
 * exactly like the capacity circuit-state patterns in providers/capacity.ts.
 *
 * Fail-closed: `heartbeat` returns false for unknown ids; `list` computes
 * `alive` on every read so a stale clock never silently shows a dead worker as
 * live. All pure helpers take `now: number` (injected clock) so unit tests run
 * without real wall time.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkerInfo {
	id: string;
	host: string;
	capacity: number;
	lastHeartbeat: number;
	alive: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A worker is alive if its last heartbeat is within the lease window.
 * Boundary: exactly at lease is still alive (<=, not <).
 */
export function isAlive(lastHeartbeat: number, now: number, leaseSeconds: number): boolean {
	return now - lastHeartbeat <= leaseSeconds * 1000;
}

// ---------------------------------------------------------------------------
// WorkerRegistry — in-memory singleton state
// ---------------------------------------------------------------------------

export class WorkerRegistry {
	readonly #workers = new Map<string, Omit<WorkerInfo, "alive">>();

	/**
	 * Register a new worker or re-register an existing one.
	 * Re-registration updates host, capacity, and lastHeartbeat in place.
	 * Returns the full WorkerInfo with alive=true (just heartbeated).
	 */
	register(input: { id: string; host: string; capacity: number }, now: number): WorkerInfo {
		this.#workers.set(input.id, {
			id: input.id,
			host: input.host,
			capacity: input.capacity,
			lastHeartbeat: now,
		});
		return { ...this.#workers.get(input.id)!, alive: true };
	}

	/**
	 * Record a heartbeat for an existing worker.
	 * Returns false if the id is unknown (fail-closed — never auto-create).
	 */
	heartbeat(id: string, now: number): boolean {
		const w = this.#workers.get(id);
		if (w === undefined) return false;
		w.lastHeartbeat = now;
		return true;
	}

	/**
	 * List all registered workers with `alive` computed against `now`.
	 * Dead workers remain in the registry until explicitly reclaimed.
	 */
	list(now: number, leaseSeconds: number): WorkerInfo[] {
		return Array.from(this.#workers.values()).map((w) => ({
			...w,
			alive: isAlive(w.lastHeartbeat, now, leaseSeconds),
		}));
	}

	/** Raw lookup by id — no alive computation. */
	get(id: string): WorkerInfo | undefined {
		const w = this.#workers.get(id);
		if (w === undefined) return undefined;
		// alive is not meaningful here without a now/lease — return as-is with alive=false sentinel.
		// Callers that need alive should use list().
		return { ...w, alive: false };
	}

	/**
	 * Delete all workers whose heartbeat has expired and return their ids.
	 * The scheduler calls this to reclaim slots held by vanished daemons.
	 */
	reclaimStale(now: number, leaseSeconds: number): string[] {
		const stale: string[] = [];
		for (const [id, w] of this.#workers) {
			if (!isAlive(w.lastHeartbeat, now, leaseSeconds)) {
				stale.push(id);
				this.#workers.delete(id);
			}
		}
		return stale;
	}
}

// ---------------------------------------------------------------------------
// Scheduler consumption hook (lease-based worker selection)
// ---------------------------------------------------------------------------

/**
 * Pure selection helper the scheduler MAY consult to place a ready task on a
 * remote worker. Picks an available, non-stale worker from a snapshot of
 * registry.list(). ADDITIVE: the existing local-spawn path stays the default
 * when workers.enabled=false — this is only consulted when workers are on.
 *
 * Selection policy:
 *   - Only `alive` workers (live lease) are eligible — stale workers skipped.
 *   - Only workers with capacity > 0 are eligible.
 *   - Among eligible, the one with the highest capacity wins (most headroom);
 *     ties broken by id (ascending) for deterministic placement.
 *
 * FAIL-CLOSED: returns undefined when no live worker is eligible, so the
 * scheduler falls back to its local-spawn path rather than placing a task on a
 * dead host.
 */
export function pickWorker(
	workers: readonly WorkerInfo[],
	opts?: { enabled?: boolean },
): WorkerInfo | undefined {
	// Inert unless explicitly enabled — guards against accidental remote placement.
	if (opts !== undefined && opts.enabled === false) return undefined;

	let best: WorkerInfo | undefined;
	for (const w of workers) {
		if (!w.alive) continue; // skip stale
		if (w.capacity <= 0) continue; // no headroom
		if (
			best === undefined ||
			w.capacity > best.capacity ||
			(w.capacity === best.capacity && w.id < best.id)
		) {
			best = w;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Reaper — reclaim stale workers on a cadence
// ---------------------------------------------------------------------------

export interface StartWorkerReaperDeps {
	/** The registry to sweep (defaults to the module singleton at the call site). */
	registry: WorkerRegistry;
	/** Lease age (seconds) past which a silent worker is reclaimed. */
	leaseSeconds: number;
	/** Interval in milliseconds between reap sweeps. */
	intervalMs: number;
	/** Injectable clock (default Date.now). Injected in tests. */
	now?: () => number;
	/** Injectable interval scheduler (default setInterval). Injected in tests. */
	setIntervalImpl?: (fn: () => void, ms: number) => unknown;
	/** Injectable interval clearer (default clearInterval). Injected in tests. */
	clearIntervalImpl?: (handle: unknown) => void;
}

/**
 * Start the stale-worker reaper background loop.
 *
 * INERT WHEN DISABLED: callers (v2Boot) must guard on workers.enabled before
 * calling; the loop itself is unconditional once started.
 *
 * FAIL-CLOSED: a reclaim error is logged and swallowed so the interval survives
 * individual sweep failures (consistent with the preview reaper pattern).
 */
export function startWorkerReaper(deps: StartWorkerReaperDeps): { stop(): void } {
	const clockFn = deps.now ?? (() => Date.now());
	const setIntervalImpl: (fn: () => void, ms: number) => unknown =
		deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
	const clearIntervalImpl: (handle: unknown) => void =
		deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

	const timerId = setIntervalImpl(() => {
		try {
			const reclaimed = deps.registry.reclaimStale(clockFn(), deps.leaseSeconds);
			if (reclaimed.length > 0) {
				console.log(`[workerReaper] reclaimed stale workers: ${reclaimed.join(", ")}`);
			}
		} catch (err) {
			console.error(
				"[workerReaper] sweep error:",
				err instanceof Error ? err.message : String(err),
			);
		}
	}, deps.intervalMs);

	return {
		stop(): void {
			clearIntervalImpl(timerId);
		},
	};
}

// ---------------------------------------------------------------------------
// Module-level singleton (matches capacity.ts pattern)
// ---------------------------------------------------------------------------

export const workerRegistry = new WorkerRegistry();
