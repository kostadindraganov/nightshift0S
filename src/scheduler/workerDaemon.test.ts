/**
 * Focused unit tests for the V3 multi-VM worker daemon, the lease-based
 * scheduler consumption hook, and the stale-worker reaper. All IO injected
 * (fetch / clock / setInterval) so tests run with no real network or wall time.
 *
 * Run with: bun test src/scheduler/workerDaemon.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
	makeWorkerDaemon,
	joinUrl,
	daemonFromEnv,
	type FetchLike,
} from "./workerDaemon.ts";
import {
	WorkerRegistry,
	pickWorker,
	startWorkerReaper,
	type WorkerInfo,
} from "./workers.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Call {
	url: string;
	method?: string;
	hasAuth: boolean;
}

/** Records calls and returns a scripted sequence of {ok,status} responses. */
function fakeFetch(
	responses: Array<{ ok: boolean; status: number } | Error>,
): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	let i = 0;
	const fetch: FetchLike = async (url, init) => {
		calls.push({
			url,
			method: init?.method,
			hasAuth: Boolean(init?.headers?.["authorization"]),
		});
		const r = responses[Math.min(i, responses.length - 1)];
		i += 1;
		if (r instanceof Error) throw r;
		return r ?? { ok: true, status: 200 };
	};
	return { fetch, calls };
}

/** A controllable fake interval: tick() runs the registered callback once. */
function fakeInterval(): {
	set: (fn: () => void, ms: number) => unknown;
	clear: (h: unknown) => void;
	tick: () => void;
	cleared: boolean;
} {
	let cb: (() => void) | null = null;
	let cleared = false;
	return {
		set(fn: () => void) {
			cb = fn;
			return 1;
		},
		clear() {
			cleared = true;
			cb = null;
		},
		tick() {
			cb?.();
		},
		get cleared() {
			return cleared;
		},
	};
}

const IDENTITY = { id: "w-remote-1", host: "10.0.0.9", capacity: 4 };

// ---------------------------------------------------------------------------
// joinUrl
// ---------------------------------------------------------------------------

describe("joinUrl", () => {
	test("joins with one slash regardless of trailing/leading slashes", () => {
		expect(joinUrl("http://cp:8080", "/workers")).toBe("http://cp:8080/workers");
		expect(joinUrl("http://cp:8080/", "/workers")).toBe("http://cp:8080/workers");
		expect(joinUrl("http://cp:8080/", "workers")).toBe("http://cp:8080/workers");
	});
});

// ---------------------------------------------------------------------------
// Daemon: register + heartbeat
// ---------------------------------------------------------------------------

describe("workerDaemon register/heartbeat", () => {
	test("register POSTs to /workers with bearer auth and identity", async () => {
		const { fetch, calls } = fakeFetch([{ ok: true, status: 201 }]);
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "secret-token",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
		});
		const ok = await daemon.register();
		expect(ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("http://cp:8080/workers");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.hasAuth).toBe(true);
	});

	test("heartbeat POSTs to /workers/:id/heartbeat", async () => {
		const { fetch, calls } = fakeFetch([{ ok: true, status: 200 }]);
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "tok",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
		});
		const ok = await daemon.heartbeat();
		expect(ok).toBe(true);
		expect(calls[0]!.url).toBe("http://cp:8080/workers/w-remote-1/heartbeat");
		expect(calls[0]!.method).toBe("POST");
	});

	test("start() registers then heartbeats on each interval tick", async () => {
		const { fetch, calls } = fakeFetch([{ ok: true, status: 200 }]);
		const iv = fakeInterval();
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "tok",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
			setIntervalImpl: iv.set,
			clearIntervalImpl: iv.clear,
		});
		daemon.start();
		expect(daemon.running).toBe(true);
		// start() fired register eagerly.
		await Promise.resolve();
		expect(calls.some((c) => c.url.endsWith("/workers"))).toBe(true);

		iv.tick(); // one heartbeat
		await Promise.resolve();
		expect(calls.some((c) => c.url.endsWith("/heartbeat"))).toBe(true);

		daemon.stop();
		expect(daemon.running).toBe(false);
		expect(iv.cleared).toBe(true);
	});

	test("start() is idempotent — second call does not start a second timer", () => {
		const { fetch } = fakeFetch([{ ok: true, status: 200 }]);
		let sets = 0;
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "tok",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
			setIntervalImpl: (fn) => {
				sets += 1;
				void fn;
				return sets as unknown as ReturnType<typeof setInterval>;
			},
			clearIntervalImpl: () => {},
		});
		daemon.start();
		daemon.start();
		expect(sets).toBe(1);
	});

	// --- FAIL-CLOSED ---

	test("register never throws on a transient network error — returns false", async () => {
		const { fetch } = fakeFetch([new Error("ECONNREFUSED")]);
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "tok",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
		});
		const ok = await daemon.register();
		expect(ok).toBe(false);
	});

	test("heartbeat never throws on a transient error — returns false", async () => {
		const { fetch } = fakeFetch([new Error("timeout")]);
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "tok",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
		});
		const ok = await daemon.heartbeat();
		expect(ok).toBe(false);
	});

	test("heartbeat 404 triggers a re-register, then returns false for this tick", async () => {
		// First call (heartbeat) → 404, second call (re-register) → 201.
		const { fetch, calls } = fakeFetch([
			{ ok: false, status: 404 },
			{ ok: true, status: 201 },
		]);
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => "tok",
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
		});
		const ok = await daemon.heartbeat();
		expect(ok).toBe(false);
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toContain("/heartbeat");
		expect(calls[1]!.url).toBe("http://cp:8080/workers"); // re-register
	});

	test("omits Authorization header when token is absent (fail-closed)", async () => {
		const { fetch, calls } = fakeFetch([{ ok: false, status: 401 }]);
		const daemon = makeWorkerDaemon({
			baseUrl: "http://cp:8080",
			tokenRef: () => undefined,
			identity: IDENTITY,
			heartbeatMs: 1000,
			fetchImpl: fetch,
		});
		await daemon.register();
		expect(calls[0]!.hasAuth).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// daemonFromEnv — inert when disabled / unconfigured
// ---------------------------------------------------------------------------

describe("daemonFromEnv", () => {
	test("returns null when workers disabled (default config)", () => {
		// Default config has workers.enabled=false, so even a fully populated env
		// stays inert.
		const d = daemonFromEnv({
			NIGHTSHIFT_CONTROL_PLANE_URL: "http://cp:8080",
			NIGHTSHIFT_WORKER_ID: "w1",
			NIGHTSHIFT_WORKER_TOKEN: "tok",
		});
		expect(d).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// pickWorker — lease-based consumption hook
// ---------------------------------------------------------------------------

function w(id: string, capacity: number, alive: boolean): WorkerInfo {
	return { id, host: `h-${id}`, capacity, lastHeartbeat: 0, alive };
}

describe("pickWorker", () => {
	test("picks a live worker and skips stale ones", () => {
		const picked = pickWorker([
			w("stale", 8, false),
			w("live", 4, true),
		]);
		expect(picked?.id).toBe("live");
	});

	test("returns undefined when all workers are stale (fail-closed)", () => {
		const picked = pickWorker([w("a", 4, false), w("b", 2, false)]);
		expect(picked).toBeUndefined();
	});

	test("returns undefined when no workers exist", () => {
		expect(pickWorker([])).toBeUndefined();
	});

	test("prefers highest capacity among live workers; ties broken by id", () => {
		const picked = pickWorker([
			w("c", 4, true),
			w("a", 4, true),
			w("b", 2, true),
		]);
		expect(picked?.id).toBe("a"); // capacity 4 tie → lowest id
	});

	test("skips live workers with zero capacity", () => {
		const picked = pickWorker([w("full", 0, true), w("free", 1, true)]);
		expect(picked?.id).toBe("free");
	});

	test("inert when explicitly disabled — returns undefined even with live workers", () => {
		const picked = pickWorker([w("live", 4, true)], { enabled: false });
		expect(picked).toBeUndefined();
	});

	test("integrates with a real registry snapshot", () => {
		const reg = new WorkerRegistry();
		const T0 = 1_000_000;
		const LEASE = 30;
		reg.register({ id: "fresh", host: "h1", capacity: 2 }, T0);
		reg.register({ id: "old", host: "h2", capacity: 8 }, T0);
		// Advance past lease but heartbeat "fresh" so only "old" is stale.
		const future = T0 + LEASE * 1000 + 1;
		reg.heartbeat("fresh", future);
		const picked = pickWorker(reg.list(future, LEASE), { enabled: true });
		expect(picked?.id).toBe("fresh"); // "old" is stale despite higher capacity
	});
});

// ---------------------------------------------------------------------------
// startWorkerReaper — reclaims stale on a cadence
// ---------------------------------------------------------------------------

describe("startWorkerReaper", () => {
	test("reclaims stale workers on a tick and leaves live ones", () => {
		const reg = new WorkerRegistry();
		const LEASE = 30;
		const T0 = 1_000_000;
		reg.register({ id: "alive", host: "h1", capacity: 1 }, T0);
		reg.register({ id: "dead", host: "h2", capacity: 1 }, T0);

		const iv = fakeInterval();
		let now = T0;
		const reaper = startWorkerReaper({
			registry: reg,
			leaseSeconds: LEASE,
			intervalMs: 1000,
			now: () => now,
			setIntervalImpl: iv.set,
			clearIntervalImpl: iv.clear,
		});

		// Advance past lease, but keep "alive" fresh.
		now = T0 + LEASE * 1000 + 1;
		reg.heartbeat("alive", now);

		iv.tick();

		const list = reg.list(now, LEASE);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe("alive");

		reaper.stop();
		expect(iv.cleared).toBe(true);
	});

	test("a reclaim error is swallowed so the interval survives (fail-closed)", () => {
		const iv = fakeInterval();
		const throwingRegistry = {
			reclaimStale() {
				throw new Error("boom");
			},
		} as unknown as WorkerRegistry;
		const reaper = startWorkerReaper({
			registry: throwingRegistry,
			leaseSeconds: 30,
			intervalMs: 1000,
			now: () => 0,
			setIntervalImpl: iv.set,
			clearIntervalImpl: iv.clear,
		});
		// Must not throw.
		expect(() => iv.tick()).not.toThrow();
		reaper.stop();
	});
});
