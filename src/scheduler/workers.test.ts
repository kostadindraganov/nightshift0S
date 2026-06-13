/**
 * Unit tests for the V3 multi-VM worker registry.
 * Run with: bun test src/scheduler/workers.test.ts
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { WorkerRegistry, isAlive } from "./workers.ts";

// Fresh registry per test — never mutate the module singleton in tests.
let reg: WorkerRegistry;
beforeEach(() => {
	reg = new WorkerRegistry();
});

const LEASE = 30; // seconds
const T0 = 1_000_000; // arbitrary epoch ms

describe("workers", () => {
	test("register then list shows alive=true", () => {
		reg.register({ id: "w1", host: "10.0.0.1", capacity: 4 }, T0);
		const list = reg.list(T0, LEASE);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe("w1");
		expect(list[0]!.alive).toBe(true);
	});

	test("heartbeat unknown id returns false", () => {
		const ok = reg.heartbeat("ghost", T0);
		expect(ok).toBe(false);
	});

	test("worker past lease shows alive=false in list", () => {
		reg.register({ id: "w2", host: "10.0.0.2", capacity: 2 }, T0);
		// Advance clock past the lease window
		const future = T0 + LEASE * 1000 + 1;
		const list = reg.list(future, LEASE);
		expect(list[0]!.alive).toBe(false);
	});

	test("reclaimStale removes dead workers and returns their ids", () => {
		reg.register({ id: "alive", host: "10.0.0.3", capacity: 1 }, T0);
		reg.register({ id: "dead", host: "10.0.0.4", capacity: 1 }, T0);
		// Advance only past "dead"'s implicit heartbeat — both registered at T0,
		// but we heartbeat "alive" before reclaiming.
		const future = T0 + LEASE * 1000 + 1;
		reg.heartbeat("alive", future); // keep alive fresh
		const reclaimed = reg.reclaimStale(future, LEASE);
		expect(reclaimed).toEqual(["dead"]);
		expect(reg.list(future, LEASE)).toHaveLength(1);
		expect(reg.list(future, LEASE)[0]!.id).toBe("alive");
	});

	test("isAlive boundary: exactly at lease is alive", () => {
		const lastHeartbeat = T0;
		const atBoundary = T0 + LEASE * 1000; // exactly == leaseSeconds * 1000
		expect(isAlive(lastHeartbeat, atBoundary, LEASE)).toBe(true);
		expect(isAlive(lastHeartbeat, atBoundary + 1, LEASE)).toBe(false);
	});

	test("re-register updates capacity", () => {
		reg.register({ id: "w3", host: "10.0.0.5", capacity: 2 }, T0);
		reg.register({ id: "w3", host: "10.0.0.5", capacity: 8 }, T0 + 1000);
		const list = reg.list(T0 + 1000, LEASE);
		expect(list).toHaveLength(1);
		expect(list[0]!.capacity).toBe(8);
	});
});
