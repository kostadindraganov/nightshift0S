/**
 * Watchdog tests (ADR-0019 timeouts + transcript classification).
 *
 * WHY: All dependencies are injected (fake clock, fake transcript reader,
 * :memory: DB) so tests are hermetic, deterministic, and run in milliseconds.
 * The real `claude` CLI is never spawned.
 *
 * Cases:
 *   (a) completion signal + elapsed > completionMs → force_succeed, run ends
 *       succeeded, a run.watchdog_warn event row exists.
 *   (b) idle > idleMs + transcript tail contains api-error text → watchdog_fail,
 *       run ends failed.
 *   (c) idle > idleMs + normal transcript tail → watchdog_succeed, run ends
 *       succeeded.
 *   (d) idle > idleMs + unknown/empty transcript → none (no transition).
 *   (e) within all timeouts → none (no transition).
 *   (f) classifySilentTranscript unit cases.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase } from "../db/client.ts";
import type { DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { runs, events } from "../db/schema.ts";
import type { RunRow } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { classifySilentTranscript, evaluateRun } from "./watchdog.ts";
import type { WatchdogDeps } from "./watchdog.ts";

// ---------------------------------------------------------------------------
// Test helpers

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

/** Seed a run directly into `running` state (bypasses service layer). */
function seedRunningRun(): RunRow {
	return handle.db
		.insert(runs)
		.values({
			kind: "coder",
			provider: "test",
			model: "test-model",
			authLane: "local",
			state: "running",
			startedAt: new Date().toISOString(),
		})
		.returning()
		.get();
}

/** Build a WatchdogDeps with all fakes wired. */
function makeDeps(
	overrides: Partial<WatchdogDeps> & { transcriptTail?: string },
): WatchdogDeps {
	const tail = overrides.transcriptTail ?? "";
	return {
		handle,
		log,
		now: overrides.now ?? (() => Date.now()),
		readTranscriptTail: overrides.readTranscriptTail ?? (() => Promise.resolve(tail)),
		idleMs: overrides.idleMs,
		completionMs: overrides.completionMs,
	};
}

/** Fetch the current state of a run from the DB. */
function runState(id: number): string {
	return handle.db.select().from(runs).where(eq(runs.id, id)).get()!.state;
}

/** Fetch all events of a given kind for a run. */
function eventsOfKind(runId: number, kind: string) {
	return handle.db
		.select()
		.from(events)
		.where(eq(events.runId, runId))
		.all()
		.filter((e) => e.kind === kind);
}

// ---------------------------------------------------------------------------
// (a) Completion signal + elapsed > completionMs → force_succeed

test("(a) completion timeout: force_succeed, run succeeded, warn event emitted", async () => {
	const run = seedRunningRun();

	const T0 = 1_000_000;
	const completionMs = 60_000;
	// Signal observed at T0, now is T0 + 61_000 (1 second past deadline).
	const now = T0 + completionMs + 1_000;

	const deps = makeDeps({
		now: () => now,
		completionMs,
		idleMs: 600_000,
		transcriptTail: "", // not consulted for this branch
	});

	const result = await evaluateRun(deps, run, T0 - 600_000, T0);

	expect(result.action).toBe("force_succeed");
	expect(runState(run.id)).toBe("succeeded");

	const warnEvents = eventsOfKind(run.id, "run.watchdog_warn");
	expect(warnEvents).toHaveLength(1);
	const payload = JSON.parse(warnEvents[0]!.payloadJson) as Record<string, unknown>;
	expect(payload.runId).toBe(run.id);
	expect(typeof payload.message).toBe("string");
});

// ---------------------------------------------------------------------------
// (b) Idle > idleMs + api-error transcript → watchdog_fail

test("(b) idle timeout + api_error transcript → watchdog_fail, run failed", async () => {
	const run = seedRunningRun();

	const idleMs = 600_000;
	const T0 = 1_000_000;
	// Last activity was 11 min ago.
	const lastActivityMs = T0 - idleMs - 60_000;
	const now = T0;

	const deps = makeDeps({
		now: () => now,
		idleMs,
		completionMs: 60_000,
		transcriptTail:
			"Claude encountered an API Error: overloaded_error — too many requests, please retry later.",
	});

	const result = await evaluateRun(deps, run, lastActivityMs, null);

	expect(result.action).toBe("watchdog_fail");
	expect(runState(run.id)).toBe("failed");

	// No warn event for a fail.
	expect(eventsOfKind(run.id, "run.watchdog_warn")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// (c) Idle > idleMs + normal transcript → watchdog_succeed

test("(c) idle timeout + normal transcript → watchdog_succeed, run succeeded", async () => {
	const run = seedRunningRun();

	const idleMs = 600_000;
	const T0 = 2_000_000;
	const lastActivityMs = T0 - idleMs - 1;
	const now = T0;

	const normalTail = `
I've finished implementing the feature. The changes include:
- Updated the authentication middleware to validate JWT tokens correctly.
- Added unit tests for the new validation logic.
- Refactored the error-handling path to surface typed errors.

All tests pass. The PR is ready for review.
`.trim();

	const deps = makeDeps({
		now: () => now,
		idleMs,
		completionMs: 60_000,
		transcriptTail: normalTail,
	});

	const result = await evaluateRun(deps, run, lastActivityMs, null);

	expect(result.action).toBe("watchdog_succeed");
	expect(runState(run.id)).toBe("succeeded");
});

// ---------------------------------------------------------------------------
// (d) Idle > idleMs + unknown/empty transcript → none (no transition)

test("(d) idle timeout + empty transcript → none, no state change", async () => {
	const run = seedRunningRun();

	const idleMs = 600_000;
	const T0 = 3_000_000;
	const lastActivityMs = T0 - idleMs - 1;
	const now = T0;

	const deps = makeDeps({
		now: () => now,
		idleMs,
		completionMs: 60_000,
		transcriptTail: "",
	});

	const result = await evaluateRun(deps, run, lastActivityMs, null);

	expect(result.action).toBe("none");
	expect(runState(run.id)).toBe("running"); // untouched
});

test("(d) idle timeout + ambiguous short tail → none, no state change", async () => {
	const run = seedRunningRun();

	const idleMs = 10_000;
	const T0 = 4_000_000;
	const lastActivityMs = T0 - idleMs - 1;
	const now = T0;

	const deps = makeDeps({
		now: () => now,
		idleMs,
		completionMs: 60_000,
		// Less than 20 non-whitespace characters — classified as unknown.
		transcriptTail: "ok",
	});

	const result = await evaluateRun(deps, run, lastActivityMs, null);

	expect(result.action).toBe("none");
	expect(runState(run.id)).toBe("running");
});

// ---------------------------------------------------------------------------
// (e) Within all timeouts → none

test("(e) within idle timeout and no completion signal → none", async () => {
	const run = seedRunningRun();

	const idleMs = 600_000;
	const T0 = 5_000_000;
	// Last activity only 1 minute ago — well within the 10-min idle window.
	const lastActivityMs = T0 - 60_000;
	const now = T0;

	const deps = makeDeps({
		now: () => now,
		idleMs,
		completionMs: 60_000,
		transcriptTail: "some normal looking output that is long enough to be normal text",
	});

	const result = await evaluateRun(deps, run, lastActivityMs, null);

	expect(result.action).toBe("none");
	expect(runState(run.id)).toBe("running");
});

test("(e) completion signal within completionMs → none", async () => {
	const run = seedRunningRun();

	const completionMs = 60_000;
	const T0 = 6_000_000;
	// Signal observed 30 s ago — still within the 60 s completion window.
	const completionSignalAtMs = T0 - 30_000;
	const now = T0;

	const deps = makeDeps({
		now: () => now,
		idleMs: 600_000,
		completionMs,
		transcriptTail: "",
	});

	const result = await evaluateRun(deps, run, completionSignalAtMs - 60_000, completionSignalAtMs);

	expect(result.action).toBe("none");
	expect(runState(run.id)).toBe("running");
});

// ---------------------------------------------------------------------------
// (f) classifySilentTranscript unit tests

describe("classifySilentTranscript", () => {
	test("empty string → unknown", () => {
		expect(classifySilentTranscript("")).toBe("unknown");
	});

	test("whitespace-only → unknown", () => {
		expect(classifySilentTranscript("   \n\t  ")).toBe("unknown");
	});

	test("overloaded_error pattern → api_error", () => {
		expect(classifySilentTranscript("Error: overloaded_error from the provider")).toBe("api_error");
	});

	test("rate_limit pattern → api_error", () => {
		expect(classifySilentTranscript("Received 429 rate_limit response")).toBe("api_error");
	});

	test("api error pattern (case-insensitive) → api_error", () => {
		expect(classifySilentTranscript("API Error: something went wrong")).toBe("api_error");
	});

	test("500 internal server → api_error", () => {
		expect(classifySilentTranscript("500 Internal Server Error received")).toBe("api_error");
	});

	test("connection reset → api_error", () => {
		expect(classifySilentTranscript("Connection reset by peer during upload")).toBe("api_error");
	});

	test("short non-error text → unknown (< 20 non-ws chars)", () => {
		expect(classifySilentTranscript("done")).toBe("unknown");
	});

	test("long non-error text → normal", () => {
		const tail = "I have completed the task as requested by the user.";
		expect(classifySilentTranscript(tail)).toBe("normal");
	});

	test("api_error pattern present alongside normal text → api_error (error takes priority)", () => {
		// Error patterns are checked before the normal heuristic.
		const tail = `
The code looks good and all tests pass. However I encountered
an authentication_error when trying to push to remote.
		`.trim();
		expect(classifySilentTranscript(tail)).toBe("api_error");
	});
});
