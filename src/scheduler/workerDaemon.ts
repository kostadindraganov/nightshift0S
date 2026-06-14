/**
 * WHY: V3 multi-VM worker daemon (BLUEPRINT §workers / §7.2). A remote host runs
 * this daemon so a second physical machine can join the pool: it registers with
 * the single control plane, then heartbeats on an interval so the control-plane
 * WorkerRegistry keeps the worker "alive". A physical 2nd machine is still an
 * operator step — this module makes the *code* real and unit-testable.
 *
 * Design constraints (mirroring v2Boot / preview reaper patterns):
 *   - ALL IO INJECTED: fetch + clock + setInterval are taken from deps so the
 *     daemon runs in unit tests with zero real network/wall-time. Production
 *     defaults are global fetch / Date.now / setInterval.
 *   - FAIL-CLOSED: a transient control-plane error (network blip, 5xx, bad
 *     JSON) NEVER throws out of the loop — it is logged and retried on the next
 *     tick. register() also never throws; it returns false and the heartbeat
 *     loop keeps trying to (re-)register until the control plane answers.
 *   - SECRETS: the bearer token is read by ref and sent in the Authorization
 *     header only; it never appears in any log line or error string.
 *   - REMOTE-RUNNABLE: the import.meta.main entrypoint reads identity + token
 *     from env so a remote box can `bun run workerDaemon.ts` directly. Behind
 *     workers.enabled — the entrypoint is inert (exits 0) when disabled.
 */

import { loadConfig } from "../config/config.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal fetch shape — enough for the daemon, easy to fake in tests. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	},
) => Promise<{ ok: boolean; status: number }>;

export interface WorkerIdentity {
	id: string;
	host: string;
	capacity: number;
}

export interface WorkerDaemonDeps {
	/** Control-plane base URL, e.g. "https://control.example:8080". No trailing slash required. */
	baseUrl: string;
	/**
	 * Late-bound bearer token. A function so token rotation takes effect without
	 * a restart. SECURITY: the returned value is sent only in the Authorization
	 * header and never logged.
	 */
	tokenRef: () => string | undefined;
	/** This worker's identity (id/host/capacity). */
	identity: WorkerIdentity;
	/** Heartbeat cadence in milliseconds. */
	heartbeatMs: number;
	/** Injectable fetch. Defaults to global fetch. */
	fetchImpl?: FetchLike;
	/** Injectable interval scheduler. Defaults to setInterval. */
	setIntervalImpl?: (fn: () => void, ms: number) => IntervalHandle;
	/** Injectable interval clearer. Defaults to clearInterval. */
	clearIntervalImpl?: (handle: IntervalHandle) => void;
}

/** Opaque handle returned by the injectable interval scheduler. */
export type IntervalHandle = unknown;

export interface WorkerDaemonHandle {
	/** Register once with the control plane. Resolves false on transient failure (never throws). */
	register(): Promise<boolean>;
	/** Send one heartbeat. Resolves false on transient failure or unknown id (never throws). */
	heartbeat(): Promise<boolean>;
	/** Start the heartbeat interval. Idempotent — a second call is a no-op. */
	start(): void;
	/** Stop the heartbeat interval. Safe to call when never started. */
	stop(): void;
	/** True while the heartbeat interval is running. */
	readonly running: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Join a base URL and a path with exactly one slash, tolerating a trailing slash on base. */
export function joinUrl(baseUrl: string, path: string): string {
	const b = baseUrl.replace(/\/+$/, "");
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${b}${p}`;
}

// ---------------------------------------------------------------------------
// makeWorkerDaemon
// ---------------------------------------------------------------------------

/**
 * Construct a worker daemon. Construction does NO IO — call register()/start()
 * to begin talking to the control plane.
 */
export function makeWorkerDaemon(deps: WorkerDaemonDeps): WorkerDaemonHandle {
	const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const setIntervalImpl: (fn: () => void, ms: number) => IntervalHandle =
		deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
	const clearIntervalImpl: (handle: IntervalHandle) => void =
		deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

	let timer: IntervalHandle | null = null;

	function authHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const token = deps.tokenRef();
		// SECURITY: token used only here; never logged. Omit header entirely when
		// absent so the control plane returns 401 (fail-closed) rather than us
		// sending an empty bearer.
		if (token) headers["authorization"] = `Bearer ${token}`;
		return headers;
	}

	async function register(): Promise<boolean> {
		try {
			const res = await fetchImpl(joinUrl(deps.baseUrl, "/workers"), {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({
					id: deps.identity.id,
					host: deps.identity.host,
					capacity: deps.identity.capacity,
				}),
			});
			return res.ok;
		} catch (err) {
			// Fail-closed: transient error → false, retried on the next tick.
			// SECURITY: log the message only — never the headers/token.
			console.error(
				"[workerDaemon] register failed (will retry):",
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}
	}

	async function heartbeat(): Promise<boolean> {
		try {
			const res = await fetchImpl(
				joinUrl(deps.baseUrl, `/workers/${encodeURIComponent(deps.identity.id)}/heartbeat`),
				{ method: "POST", headers: authHeaders() },
			);
			if (res.ok) return true;
			// 404 ⇒ control plane forgot us (reclaimed as stale, or restarted).
			// Re-register so the next heartbeat lands. Still fail-closed: any
			// failure here is swallowed and retried next tick.
			if (res.status === 404) {
				await register();
			}
			return false;
		} catch (err) {
			console.error(
				"[workerDaemon] heartbeat failed (will retry):",
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}
	}

	return {
		register,
		heartbeat,
		start(): void {
			if (timer !== null) return; // idempotent
			// Register eagerly; the result is intentionally not awaited so start()
			// stays synchronous. A failed register is retried by the heartbeat
			// loop (404 → re-register) and the next interval tick.
			void register();
			timer = setIntervalImpl(() => {
				void heartbeat();
			}, deps.heartbeatMs);
		},
		stop(): void {
			if (timer !== null) {
				clearIntervalImpl(timer);
				timer = null;
			}
		},
		get running(): boolean {
			return timer !== null;
		},
	};
}

// ---------------------------------------------------------------------------
// Entrypoint — remote host runs this directly (guarded by import.meta.main)
// ---------------------------------------------------------------------------

/**
 * Build a daemon from env + config for the standalone entrypoint.
 * Returns null (inert) when workers.enabled=false or required identity/token
 * env is missing (fail-closed: a misconfigured remote box does nothing harmful).
 *
 * Env:
 *   NIGHTSHIFT_CONTROL_PLANE_URL  control-plane base URL (required)
 *   NIGHTSHIFT_WORKER_TOKEN       bearer token (required)
 *   NIGHTSHIFT_WORKER_ID          worker id (required)
 *   NIGHTSHIFT_WORKER_HOST        host label (default: hostname or "unknown")
 *   NIGHTSHIFT_WORKER_CAPACITY    integer capacity (default: 1)
 */
export function daemonFromEnv(
	env: Record<string, string | undefined> = process.env,
): WorkerDaemonHandle | null {
	const cfg = loadConfig().workers;
	if (!cfg.enabled) return null;

	const baseUrl = env["NIGHTSHIFT_CONTROL_PLANE_URL"];
	const id = env["NIGHTSHIFT_WORKER_ID"];
	const token = env["NIGHTSHIFT_WORKER_TOKEN"];
	// Fail-closed: without a control-plane URL, id, and token there is nothing
	// to register against — stay inert rather than spin a useless loop.
	if (!baseUrl || !id || !token) return null;

	const host = env["NIGHTSHIFT_WORKER_HOST"] || "unknown";
	const capacityRaw = Number(env["NIGHTSHIFT_WORKER_CAPACITY"]);
	const capacity = Number.isFinite(capacityRaw) && capacityRaw > 0 ? capacityRaw : 1;

	return makeWorkerDaemon({
		baseUrl,
		tokenRef: () => env["NIGHTSHIFT_WORKER_TOKEN"],
		identity: { id, host, capacity },
		heartbeatMs: cfg.heartbeatSeconds * 1000,
	});
}

// istanbul ignore next — entrypoint, exercised only when run as a script.
if (import.meta.main) {
	const daemon = daemonFromEnv();
	if (daemon === null) {
		console.log("[workerDaemon] disabled or unconfigured — exiting (fail-closed no-op).");
	} else {
		daemon.start();
		console.log("[workerDaemon] started; heartbeating control plane.");
		// Keep the process alive; stop on SIGINT/SIGTERM.
		const shutdown = (): void => {
			daemon.stop();
			console.log("[workerDaemon] stopped.");
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}
}
