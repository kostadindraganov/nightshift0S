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
// Module-level singleton (matches capacity.ts pattern)
// ---------------------------------------------------------------------------

export const workerRegistry = new WorkerRegistry();
