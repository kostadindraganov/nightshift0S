/**
 * hookBridge tests — in-memory DB, seeded runs, scripted hooks (no real CLI).
 *
 * Covers:
 *   (a) SessionStart drives starting→running, stores session_id on the row.
 *   (b) PreToolUse{tool_name:"AskUserQuestion"} → awaiting_input.
 *   (c) PostToolUse{tool_name:"AskUserQuestion"} → running.
 *   (d) Stop with background_tasks:[{status:"running"}] → background_waiting.
 *   (e) Plain Stop (no live background tasks) → finishing.
 *   (f) Every ingest writes a run.hook.* event row.
 *   (g) Hook arriving in an impossible state returns transitioned:false, no throw.
 *   (h) Duplicate SessionStart is a safe no-op (lost_race tolerated).
 *   (i) Non-blocking PreToolUse → no transition, just logged.
 *   (j) Notification / unknown kind → no transition, just logged.
 */

import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import type { RunState } from "../db/columns.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, runs } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { ingestHookEvent } from "./hookBridge.ts";

// ---------------------------------------------------------------------------
// Setup

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

// ---------------------------------------------------------------------------
// Helpers

function seedRun(state: RunState): number {
	return handle.db
		.insert(runs)
		.values({ kind: "coder", provider: "test", model: "m", authLane: "local", state })
		.returning()
		.get().id;
}

function hookEvents(runId: number) {
	return handle.db
		.select()
		.from(events)
		.where(eq(events.runId, runId))
		.all()
		.filter((e) => e.kind.startsWith("run.hook."));
}

function getRunRow(runId: number) {
	return handle.db.select().from(runs).where(eq(runs.id, runId)).get()!;
}

// ---------------------------------------------------------------------------
// (a) SessionStart drives starting→running and stores session_id

test("SessionStart: starting → running, session_id captured", async () => {
	const runId = seedRun("starting");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "SessionStart",
		payload: { session_id: "sess-abc123" },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("running");

	const row = getRunRow(runId);
	expect(row.state).toBe("running");
	expect(row.sessionId).toBe("sess-abc123");
});

// ---------------------------------------------------------------------------
// (b) PreToolUse with blocking tool → awaiting_input

test("PreToolUse(AskUserQuestion): running → awaiting_input", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "PreToolUse",
		payload: { tool_name: "AskUserQuestion" },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("awaiting_input");
	expect(getRunRow(runId).state).toBe("awaiting_input");
});

test("PreToolUse(ExitPlanMode): running → awaiting_input", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "PreToolUse",
		payload: { tool_name: "ExitPlanMode" },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("awaiting_input");
});

// ---------------------------------------------------------------------------
// (c) PostToolUse (blocking tool) → running

test("PostToolUse(AskUserQuestion): awaiting_input → running", async () => {
	const runId = seedRun("awaiting_input");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "PostToolUse",
		payload: { tool_name: "AskUserQuestion" },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("running");
	expect(getRunRow(runId).state).toBe("running");
});

// ---------------------------------------------------------------------------
// (d) Stop with background tasks running → background_waiting

test("Stop with background_tasks running: running → background_waiting", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "Stop",
		payload: { background_tasks: [{ id: "bg-1", status: "running" }] },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("background_waiting");
	expect(getRunRow(runId).state).toBe("background_waiting");
});

// ---------------------------------------------------------------------------
// (e) Plain Stop → finishing

test("Stop (no active background tasks): running → finishing", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "Stop",
		payload: { background_tasks: [] },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("finishing");
	expect(getRunRow(runId).state).toBe("finishing");
});

test("Stop (no background_tasks key): running → finishing", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "Stop",
		payload: {},
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("finishing");
});

test("Stop from background_waiting (all returned): background_waiting → finishing", async () => {
	const runId = seedRun("background_waiting");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "Stop",
		payload: { background_tasks: [{ id: "bg-1", status: "completed" }] },
	});

	expect(result.transitioned).toBe(true);
	expect(result.to).toBe("finishing");
	expect(getRunRow(runId).state).toBe("finishing");
});

// ---------------------------------------------------------------------------
// (f) Every ingest writes a run.hook.* event row

test("every ingest writes a run.hook.* event row", async () => {
	const runId = seedRun("starting");

	// SessionStart
	await ingestHookEvent(handle, log, runId, { kind: "SessionStart", payload: {} });
	// PreToolUse non-blocking
	await ingestHookEvent(handle, log, runId, {
		kind: "PreToolUse",
		payload: { tool_name: "Bash" },
	});
	// Notification
	await ingestHookEvent(handle, log, runId, { kind: "Notification", payload: { msg: "hi" } });

	const hookEvs = hookEvents(runId);
	expect(hookEvs).toHaveLength(3);
	expect(hookEvs.some((e) => e.kind === "run.hook.SessionStart")).toBe(true);
	expect(hookEvs.some((e) => e.kind === "run.hook.PreToolUse")).toBe(true);
	expect(hookEvs.some((e) => e.kind === "run.hook.Notification")).toBe(true);
});

// ---------------------------------------------------------------------------
// (g) Hook arriving in an impossible state: transitioned:false, no throw

test("hook in impossible state returns transitioned:false without throwing", async () => {
	// Run is in 'queued' — SessionStart cannot apply here.
	const runId = seedRun("queued");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "SessionStart",
		payload: { session_id: "x" },
	});

	expect(result.transitioned).toBe(false);
	// State must not have changed.
	expect(getRunRow(runId).state).toBe("queued");
	// Hook event row still written.
	expect(hookEvents(runId)).toHaveLength(1);
});

test("Stop hook in terminal state returns transitioned:false without throwing", async () => {
	const runId = seedRun("succeeded");

	let threw = false;
	let result: { transitioned: boolean; to?: string } = { transitioned: false };
	try {
		result = await ingestHookEvent(handle, log, runId, {
			kind: "Stop",
			payload: {},
		});
	} catch {
		threw = true;
	}

	expect(threw).toBe(false);
	expect(result.transitioned).toBe(false);
	expect(getRunRow(runId).state).toBe("succeeded");
});

// ---------------------------------------------------------------------------
// (h) Duplicate SessionStart is a safe no-op (lost_race tolerated)

test("duplicate SessionStart is idempotent (second is a safe no-op)", async () => {
	const runId = seedRun("starting");

	const first = await ingestHookEvent(handle, log, runId, {
		kind: "SessionStart",
		payload: { session_id: "s1" },
	});
	expect(first.transitioned).toBe(true);

	// Second delivery of the same hook.
	const second = await ingestHookEvent(handle, log, runId, {
		kind: "SessionStart",
		payload: { session_id: "s1" },
	});
	expect(second.transitioned).toBe(false);

	// State unchanged; two hook event rows (idempotency at the event level, not deduped).
	expect(getRunRow(runId).state).toBe("running");
	expect(hookEvents(runId)).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// (i) Non-blocking PreToolUse: no transition, just logged

test("PreToolUse with non-blocking tool: no transition, event logged", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "PreToolUse",
		payload: { tool_name: "Bash" },
	});

	expect(result.transitioned).toBe(false);
	expect(getRunRow(runId).state).toBe("running");
	expect(hookEvents(runId)).toHaveLength(1);
	expect(hookEvents(runId)[0]!.kind).toBe("run.hook.PreToolUse");
});

// ---------------------------------------------------------------------------
// (j) Notification / unknown kind: no transition, just logged

test("Notification: no transition, event logged", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "Notification",
		payload: { message: "info" },
	});

	expect(result.transitioned).toBe(false);
	expect(getRunRow(runId).state).toBe("running");
	expect(hookEvents(runId)).toHaveLength(1);
});

test("unknown hook kind: no transition, event logged", async () => {
	const runId = seedRun("running");

	const result = await ingestHookEvent(handle, log, runId, {
		kind: "SomeNewHookKindWeDoNotKnow",
		payload: null,
	});

	expect(result.transitioned).toBe(false);
	expect(hookEvents(runId)).toHaveLength(1);
	expect(hookEvents(runId)[0]!.kind).toBe("run.hook.SomeNewHookKindWeDoNotKnow");
});

// ---------------------------------------------------------------------------
// Full sequence test — scripted lifecycle end to end

test("full lifecycle sequence: queued→starting(seeded)→running→awaiting_input→running→background_waiting→finishing", async () => {
	// Seed already in 'starting' to skip the spawn step.
	const runId = seedRun("starting");

	// SessionStart
	let r = await ingestHookEvent(handle, log, runId, {
		kind: "SessionStart",
		payload: { session_id: "full-test-session" },
	});
	expect(r).toMatchObject({ transitioned: true, to: "running" });

	// PreToolUse blocking
	r = await ingestHookEvent(handle, log, runId, {
		kind: "PreToolUse",
		payload: { tool_name: "AskUserQuestion" },
	});
	expect(r).toMatchObject({ transitioned: true, to: "awaiting_input" });

	// PostToolUse blocking
	r = await ingestHookEvent(handle, log, runId, {
		kind: "PostToolUse",
		payload: { tool_name: "AskUserQuestion" },
	});
	expect(r).toMatchObject({ transitioned: true, to: "running" });

	// Interim stop with background task alive
	r = await ingestHookEvent(handle, log, runId, {
		kind: "Stop",
		payload: { background_tasks: [{ id: "bg-1", status: "running" }] },
	});
	expect(r).toMatchObject({ transitioned: true, to: "background_waiting" });

	// Final stop — all background tasks done
	r = await ingestHookEvent(handle, log, runId, {
		kind: "Stop",
		payload: { background_tasks: [{ id: "bg-1", status: "completed" }] },
	});
	expect(r).toMatchObject({ transitioned: true, to: "finishing" });

	expect(getRunRow(runId).state).toBe("finishing");
	// 5 hook events total.
	expect(hookEvents(runId)).toHaveLength(5);
});
