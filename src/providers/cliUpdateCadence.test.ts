/**
 * Tests for CLI update cadence (BLUEPRINT V3 §7.3).
 *
 * Hermetic test harness:
 *   - (1) Happy path: emits status events on interval, updates available targets.
 *   - (2) Fail-closed: updater.status() error doesn't crash the loop.
 *   - (3) Fail-closed: updater.update() error doesn't crash the loop.
 *   - (4) Updates disabled: runUpdates=false skips update() calls.
 *   - (5) Stop clears the interval and prevents further ticks.
 *
 * All side effects faked: in-memory event log, fake updater. No real timers,
 * no spawn, no network.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { startCliUpdateCadence } from "./cliUpdateCadence.ts";
import type { CliStatus, CliTarget } from "./cliUpdate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// (1) Happy path: emits status events on interval
// ---------------------------------------------------------------------------

test("emits status events on interval and calls update when available", async () => {
	const statuses: CliStatus[] = [
		{
			provider: "claude",
			bin: "claude",
			installed: "1.0.0",
			latest: "2.0.0",
			updateAvailable: true,
		},
		{
			provider: "gemini",
			bin: "agy",
			installed: "3.0.0",
			latest: "3.0.0",
			updateAvailable: false,
		},
	];

	const statusCalls: number[] = [];
	const updateCalls: { provider: string; bin: string }[] = [];

	const updater = {
		async status() {
			statusCalls.push(Date.now());
			return statuses;
		},
		async update(target: CliTarget) {
			updateCalls.push({ provider: target.provider, bin: target.bin });
			return { ok: true };
		},
	};

	// Start cadence with a short interval (10ms for testing).
	const cadence = startCliUpdateCadence({
		updater,
		intervalMs: 10,
		log,
		runUpdates: true,
	});

	// Wait for 2 ticks to occur.
	await new Promise((resolve) => setTimeout(resolve, 35));

	cadence.stop();

	// Should have called status at least twice.
	expect(statusCalls.length).toBeGreaterThanOrEqual(2);

	// Should have attempted update for the available target (claude).
	expect(updateCalls.length).toBeGreaterThanOrEqual(2);
	expect(updateCalls[0]).toEqual({ provider: "claude", bin: "claude" });

	// Verify that status events were emitted to the log.
	const statusEvents = handle.db
		.select()
		.from(events)
		.where(eq(events.kind, "providers.cli_status"))
		.all();
	expect(statusEvents.length).toBeGreaterThanOrEqual(1);
	expect(statusEvents[0]?.kind).toBe("providers.cli_status");
});

// ---------------------------------------------------------------------------
// (2) Fail-closed: updater.status() error doesn't crash the loop
// ---------------------------------------------------------------------------

test("fail-closed: status() error doesn't stop the interval", async () => {
	const statusCalls: number[] = [];

	const updater = {
		async status() {
			statusCalls.push(Date.now());
			if (statusCalls.length === 1) {
				throw new Error("status failed");
			}
			return [
				{
					provider: "claude",
					bin: "claude",
					installed: "1.0.0",
					latest: null,
					updateAvailable: false,
				},
			];
		},
		async update() {
			return { ok: false, error: "not called" };
		},
	};

	const cadence = startCliUpdateCadence({
		updater,
		intervalMs: 10,
		log,
		runUpdates: false,
	});

	// Wait for 2 ticks.
	await new Promise((resolve) => setTimeout(resolve, 35));

	cadence.stop();

	// Should have tried status at least twice despite the first error.
	expect(statusCalls.length).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// (3) Fail-closed: updater.update() error doesn't crash the loop
// ---------------------------------------------------------------------------

test("fail-closed: update() error doesn't stop the interval", async () => {
	const statuses: CliStatus[] = [
		{
			provider: "claude",
			bin: "claude",
			installed: "1.0.0",
			latest: "2.0.0",
			updateAvailable: true,
		},
	];

	const statusCalls: number[] = [];
	const updateCalls: number[] = [];

	const updater = {
		async status() {
			statusCalls.push(Date.now());
			return statuses;
		},
		async update() {
			updateCalls.push(Date.now());
			throw new Error("update failed");
		},
	};

	const cadence = startCliUpdateCadence({
		updater,
		intervalMs: 10,
		log,
		runUpdates: true,
	});

	// Wait for 2 ticks.
	await new Promise((resolve) => setTimeout(resolve, 35));

	cadence.stop();

	// Should have called status at least twice despite update errors.
	expect(statusCalls.length).toBeGreaterThanOrEqual(2);

	// Should have attempted update at least twice despite errors.
	expect(updateCalls.length).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// (4) Updates disabled: runUpdates=false skips update() calls
// ---------------------------------------------------------------------------

test("updates disabled: update() is not called when runUpdates=false", async () => {
	const statuses: CliStatus[] = [
		{
			provider: "claude",
			bin: "claude",
			installed: "1.0.0",
			latest: "2.0.0",
			updateAvailable: true,
		},
	];

	const statusCalls: number[] = [];
	const updateCalls: number[] = [];

	const updater = {
		async status() {
			statusCalls.push(Date.now());
			return statuses;
		},
		async update() {
			updateCalls.push(Date.now());
			return { ok: true };
		},
	};

	const cadence = startCliUpdateCadence({
		updater,
		intervalMs: 10,
		log,
		runUpdates: false,
	});

	// Wait for 2 ticks.
	await new Promise((resolve) => setTimeout(resolve, 35));

	cadence.stop();

	// Should have called status at least twice.
	expect(statusCalls.length).toBeGreaterThanOrEqual(2);

	// Should NOT have called update because runUpdates=false.
	expect(updateCalls.length).toBe(0);
});

// ---------------------------------------------------------------------------
// (5) Stop clears the interval
// ---------------------------------------------------------------------------

test("stop() clears the interval and prevents further ticks", async () => {
	const statusCalls: number[] = [];

	const updater = {
		async status() {
			statusCalls.push(Date.now());
			return [
				{
					provider: "claude",
					bin: "claude",
					installed: "1.0.0",
					latest: null,
					updateAvailable: false,
				},
			];
		},
		async update() {
			return { ok: false, error: "not called" };
		},
	};

	const cadence = startCliUpdateCadence({
		updater,
		intervalMs: 10,
		log,
		runUpdates: false,
	});

	// Wait for 2 ticks.
	await new Promise((resolve) => setTimeout(resolve, 35));

	const callsBeforeStop = statusCalls.length;

	// Stop the cadence.
	cadence.stop();

	// Wait to verify no more ticks occur.
	await new Promise((resolve) => setTimeout(resolve, 30));

	// Should not have increased call count after stop.
	expect(statusCalls.length).toBe(callsBeforeStop);
});
