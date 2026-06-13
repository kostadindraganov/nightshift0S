/**
 * Transcript browser tests (UNIT 5.8a, BLUEPRINT §3.12.16).
 *
 * Hermetic tests for buildRunTranscript and buildTaskTranscript with
 * in-memory SQLite. All side effects faked: injected now() function for
 * timestamps (if needed), and real EventLog (in-memory).
 *
 * Matrix (happy path + fail-closed/edge cases):
 *   1. buildRunTranscript happy path: merge event rows + thread_event rows,
 *      order by (ts ASC, source ASC, seq ASC), assign 1-indexed seq.
 *   2. buildTaskTranscript with round filter: include only thread_events of
 *      the specified round; global events always included.
 *   3. Pagination: afterSeq cursor (filter merged seq > cursor), limit (take
 *      first N after cursor).
 *   4. Empty results: run/task with no events returns [].
 *   5. JSON parse safety: malformed payload_json in either table → null,
 *      no throw.
 *   6. Tie-breaking: two rows with identical ts resolve by (source, then seq).
 *   7. Thread-only metadata: actor, round, idempotencyKey, redacted fields
 *      are thread-exclusive and properly exported.
 *   8. Route 400 cases: bad integer query params on task transcript routes.
 *   9. Route happy path: GET /runs/:id/transcript, GET /tasks/:id/transcript
 *      return json(transcript).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
	events,
	projects,
	runs,
	tasks,
	threadEvents,
	type EventInsert,
	type ThreadEventInsert,
} from "../db/schema.ts";
import type { ThreadEventKind } from "../db/columns.ts";
import { buildRunTranscript, buildTaskTranscript, type TranscriptEvent } from "./transcript.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a test project (required for tasks). */
function insertProject(): number {
	const result = handle.db
		.insert(projects)
		.values({
			name: "test-project",
			repoUrl: "https://github.com/test/repo",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning({ id: projects.id })
		.get();
	return result!.id;
}

/** Insert a test task (required for thread_events). */
function insertTask(projectId: number): number {
	const now = new Date().toISOString();
	const result = handle.db
		.insert(tasks)
		.values({
			projectId,
			title: "Test task",
			state: "coding",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: tasks.id })
		.get();
	return result!.id;
}

/** Insert a test run. */
function insertRun(taskId: number | null = null): number {
	const result = handle.db
		.insert(runs)
		.values({
			taskId,
			kind: "coder",
			provider: "test",
			model: "test-model",
			authLane: "subscription",
			state: "running",
		})
		.returning({ id: runs.id })
		.get();
	return result!.id;
}

/** Insert a global event row. */
function insertEvent(data: {
	runId?: number;
	taskId?: number;
	kind: string;
	payload: unknown;
	ts: string;
	seq?: number;
}): void {
	const seq =
		data.seq ??
		((handle.db.select().from(events).all() as Array<{ seq: number }>).reduce(
			(max, e) => Math.max(max, e.seq),
			0,
		) +
			1);
	handle.db
		.insert(events)
		.values({
			runId: data.runId,
			taskId: data.taskId,
			kind: data.kind,
			payloadJson: JSON.stringify(data.payload),
			ts: data.ts,
			seq,
		})
		.run();
}

/** Insert a thread_events row. */
function insertThreadEvent(data: {
	taskId: number;
	runId?: number;
	kind: ThreadEventKind;
	actor: string;
	round?: number;
	idempotencyKey?: string;
	redacted?: boolean;
	payload: unknown;
	ts: string; // stored as createdAt in the table
	seq?: number;
}): void {
	const seq =
		data.seq ??
		((handle.db
			.select()
			.from(threadEvents)
			.where(eq(threadEvents.taskId, data.taskId))
			.all() as Array<{ seq: number }>).reduce((max, e) => Math.max(max, e.seq), 0) +
			1);
	handle.db
		.insert(threadEvents)
		.values({
			taskId: data.taskId,
			runId: data.runId,
			kind: data.kind,
			actor: data.actor,
			round: data.round ?? 0,
			idempotencyKey: data.idempotencyKey,
			redacted: data.redacted ?? false,
			payloadJson: JSON.stringify(data.payload),
			createdAt: data.ts,
			seq,
		})
		.run();
}

// ---------------------------------------------------------------------------
// 1. buildRunTranscript happy path
// ---------------------------------------------------------------------------

test("buildRunTranscript merges events and thread_events, orders by (ts, source, seq)", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);
	const runId = insertRun(taskId);

	// Insert events and thread_events with overlapping timestamps to test
	// tie-breaking. Timeline:
	//   2026-06-13T10:00:00Z: global event (source="event"), then thread event
	//   2026-06-13T10:00:01Z: thread event
	//   2026-06-13T10:00:02Z: global event

	insertEvent({
		runId,
		taskId,
		kind: "run.started",
		payload: { model: "test" },
		ts: "2026-06-13T10:00:00.000Z",
		seq: 1,
	});
	insertThreadEvent({
		taskId,
		runId,
		kind: "message",
		actor: "coder:claude",
		round: 1,
		payload: { message: "hello" },
		ts: "2026-06-13T10:00:00.000Z", // same ts as event above
		seq: 1,
	});
	insertThreadEvent({
		taskId,
		runId,
		kind: "message",
		actor: "reviewer:codex",
		round: 1,
		payload: { message: "looks good" },
		ts: "2026-06-13T10:00:01.000Z",
		seq: 2,
	});
	insertEvent({
		runId,
		taskId,
		kind: "run.completed",
		payload: { exitCode: 0 },
		ts: "2026-06-13T10:00:02.000Z",
		seq: 2,
	});

	const transcript = buildRunTranscript(handle, runId);

	// Should have 4 events in order.
	expect(transcript).toHaveLength(4);
	const [ev0, ev1, ev2, ev3] = transcript as [TranscriptEvent, TranscriptEvent, TranscriptEvent, TranscriptEvent];
	expect(ev0).toMatchObject({
		seq: 1,
		ts: "2026-06-13T10:00:00.000Z",
		source: "event",
		kind: "run.started",
	});
	expect(ev1).toMatchObject({
		seq: 2,
		ts: "2026-06-13T10:00:00.000Z",
		source: "thread",
		kind: "message",
		actor: "coder:claude",
	});
	expect(ev2).toMatchObject({
		seq: 3,
		ts: "2026-06-13T10:00:01.000Z",
		source: "thread",
	});
	expect(ev3).toMatchObject({
		seq: 4,
		ts: "2026-06-13T10:00:02.000Z",
		source: "event",
		kind: "run.completed",
	});

	// Verify payload was parsed.
	expect(ev0.payload).toEqual({ model: "test" });
	expect(ev1.payload).toEqual({ message: "hello" });
});

// ---------------------------------------------------------------------------
// 2. buildTaskTranscript with round filter
// ---------------------------------------------------------------------------

test("buildTaskTranscript round filter includes only matching thread_events", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	// Insert thread_events across rounds.
	insertThreadEvent({
		taskId,
		kind: "message",
		actor: "coder",
		round: 0,
		payload: { msg: "round 0" },
		ts: "2026-06-13T10:00:00.000Z",
		seq: 1,
	});
	insertThreadEvent({
		taskId,
		kind: "message",
		actor: "coder",
		round: 1,
		payload: { msg: "round 1 first" },
		ts: "2026-06-13T10:00:01.000Z",
		seq: 2,
	});
	insertThreadEvent({
		taskId,
		kind: "message",
		actor: "reviewer",
		round: 1,
		payload: { msg: "round 1 second" },
		ts: "2026-06-13T10:00:02.000Z",
		seq: 3,
	});
	insertThreadEvent({
		taskId,
		kind: "message",
		actor: "coder",
		round: 2,
		payload: { msg: "round 2" },
		ts: "2026-06-13T10:00:03.000Z",
		seq: 4,
	});

	// Filter to round 1: should get seq 2 and 3 only.
	const transcript = buildTaskTranscript(handle, taskId, { round: 1 });
	expect(transcript).toHaveLength(2);
	const [t0, t1] = transcript as [TranscriptEvent, TranscriptEvent];
	expect(t0.round).toBe(1);
	expect((t0.payload as Record<string, string>).msg).toBe("round 1 first");
	expect(t1.round).toBe(1);
	expect((t1.payload as Record<string, string>).msg).toBe("round 1 second");

	// No filter: all rounds.
	const all = buildTaskTranscript(handle, taskId);
	expect(all).toHaveLength(4);
});

// ---------------------------------------------------------------------------
// 3. Pagination: afterSeq and limit
// ---------------------------------------------------------------------------

test("buildTaskTranscript pagination: afterSeq cursor + limit", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	// Insert 5 events.
	for (let i = 0; i < 5; i++) {
		insertThreadEvent({
			taskId,
			kind: "message",
			actor: "coder",
			payload: { n: i },
			ts: new Date(`2026-06-13T10:00:0${i}.000Z`).toISOString(),
		});
	}

	// afterSeq=2: skip first 2 merged events, take from event 3 onward.
	const after2 = buildTaskTranscript(handle, taskId, { afterSeq: 2 });
	expect(after2).toHaveLength(3);
	expect(after2[0]!.seq).toBe(3);

	// afterSeq=2, limit=2: take 2 events after seq 2.
	const after2Limit2 = buildTaskTranscript(handle, taskId, { afterSeq: 2, limit: 2 });
	expect(after2Limit2).toHaveLength(2);
	expect(after2Limit2[0]!.seq).toBe(3);
	expect(after2Limit2[1]!.seq).toBe(4);

	// afterSeq=10 (beyond all): empty.
	const after10 = buildTaskTranscript(handle, taskId, { afterSeq: 10 });
	expect(after10).toHaveLength(0);

	// limit only: take first N from the whole transcript.
	const limit2 = buildTaskTranscript(handle, taskId, { limit: 2 });
	expect(limit2).toHaveLength(2);
	expect(limit2[0]!.seq).toBe(1);
	expect(limit2[1]!.seq).toBe(2);
});

// ---------------------------------------------------------------------------
// 4. Empty results: no events
// ---------------------------------------------------------------------------

test("buildRunTranscript returns empty array for run with no events", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);
	const runId = insertRun(taskId);

	// No events inserted.
	const transcript = buildRunTranscript(handle, runId);
	expect(transcript).toEqual([]);
});

test("buildTaskTranscript returns empty array for task with no events", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	const transcript = buildTaskTranscript(handle, taskId);
	expect(transcript).toEqual([]);
});

// ---------------------------------------------------------------------------
// 5. JSON parse safety: malformed payload_json
// ---------------------------------------------------------------------------

test("malformed JSON in payload_json is safely parsed to null", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);
	const runId = insertRun(taskId);

	// Directly insert malformed JSON (bypass insertEvent helper).
	handle.db
		.insert(events)
		.values({
			runId,
			taskId,
			kind: "bad.json",
			payloadJson: "{invalid json",
			ts: "2026-06-13T10:00:00.000Z",
			seq: 1,
		})
		.run();

	// Should not throw; payload should be null.
	const transcript = buildRunTranscript(handle, runId);
	expect(transcript).toHaveLength(1);
	expect(transcript[0]!.payload).toBeNull();
	expect(transcript[0]!.kind).toBe("bad.json");
});

test("malformed JSON in thread_events payload_json is safely parsed to null", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	// Directly insert malformed JSON in threadEvents.
	handle.db
		.insert(threadEvents)
		.values({
			taskId,
			kind: "message",
			actor: "test",
			round: 0,
			payloadJson: "{broken",
			createdAt: "2026-06-13T10:00:00.000Z",
			seq: 1,
		})
		.run();

	const transcript = buildTaskTranscript(handle, taskId);
	expect(transcript).toHaveLength(1);
	expect(transcript[0]!.payload).toBeNull();
	expect(transcript[0]!.source).toBe("thread");
});

// ---------------------------------------------------------------------------
// 6. Tie-breaking: identical timestamps
// ---------------------------------------------------------------------------

test("identical timestamps are broken by (source, seq)", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	const sameTs = "2026-06-13T10:00:00.000Z";

	// Two global events at the same ts: ordered by seq.
	insertEvent({
		taskId,
		kind: "event.a",
		payload: {},
		ts: sameTs,
		seq: 1,
	});
	insertEvent({
		taskId,
		kind: "event.b",
		payload: {},
		ts: sameTs,
		seq: 2,
	});

	// One thread event at the same ts: source="event" < "thread", so events
	// come first, then thread.
	insertThreadEvent({
		taskId,
		kind: "message",
		actor: "test",
		payload: {},
		ts: sameTs,
		seq: 1,
	});

	const transcript = buildTaskTranscript(handle, taskId);
	expect(transcript).toHaveLength(3);
	// Events come first (source="event" < "thread").
	const [tb0, tb1, tb2] = transcript as [TranscriptEvent, TranscriptEvent, TranscriptEvent];
	expect(tb0.seq).toBe(1);
	expect(tb0.source).toBe("event");
	expect(tb0.kind).toBe("event.a");

	expect(tb1.seq).toBe(2);
	expect(tb1.source).toBe("event");
	expect(tb1.kind).toBe("event.b");

	expect(tb2.seq).toBe(3);
	expect(tb2.source).toBe("thread");
	expect(tb2.kind).toBe("message");
});

// ---------------------------------------------------------------------------
// 7. Thread-exclusive metadata: actor, round, idempotencyKey, redacted
// ---------------------------------------------------------------------------

test("thread_event fields (actor, round, idempotencyKey, redacted) are exported", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	const idempotencyKey = "dedup-key-123";
	insertThreadEvent({
		taskId,
		kind: "message",
		actor: "coder:claude-opus",
		round: 3,
		idempotencyKey,
		redacted: true,
		payload: { sensitive: "data" },
		ts: "2026-06-13T10:00:00.000Z",
	});

	const transcript = buildTaskTranscript(handle, taskId);
	expect(transcript).toHaveLength(1);

	const ev = transcript[0]!;
	expect(ev.actor).toBe("coder:claude-opus");
	expect(ev.round).toBe(3);
	expect(ev.idempotencyKey).toBe(idempotencyKey);
	expect(ev.redacted).toBe(true);
	expect(ev.source).toBe("thread");
});

test("global event rows do NOT have actor, round, idempotencyKey, redacted fields", () => {
	const projectId = insertProject();
	const taskId = insertTask(projectId);

	insertEvent({
		taskId,
		kind: "run.started",
		payload: {},
		ts: "2026-06-13T10:00:00.000Z",
	});

	const transcript = buildTaskTranscript(handle, taskId);
	expect(transcript).toHaveLength(1);

	const ev = transcript[0]!;
	expect(ev.source).toBe("event");
	expect(ev.actor).toBeUndefined();
	expect(ev.round).toBeUndefined();
	expect(ev.idempotencyKey).toBeUndefined();
	// redacted is absent for non-thread events (never set).
	expect(ev.redacted).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 8. Route 400 cases: bad integer query params
// ---------------------------------------------------------------------------

test("task transcript route returns 400 on non-integer round param", async () => {
	const { transcriptRoutes } = await import("./transcriptRoutes.ts");
	const taskRoute = transcriptRoutes.find((r) => r.path === "/tasks/:id/transcript");
	expect(taskRoute).toBeDefined();

	const projectId = insertProject();
	const taskId = insertTask(projectId);

	// Mock RouteContext.
	const url = new URL(`http://localhost/tasks/${taskId}/transcript?round=abc`);
	const ctx = {
		req: new Request(url),
		url,
		params: { id: taskId.toString() },
		handle,
		events: null,
	};

	const response = await taskRoute!.handler(ctx as any);
	expect(response.status).toBe(400);

	const body = await response.json();
	expect(body.error.code).toBe("bad_request");
	expect((body.error.message as string).toLowerCase()).toContain("integer");
});

test("task transcript route returns 400 on non-integer after_seq param", async () => {
	const { transcriptRoutes } = await import("./transcriptRoutes.ts");
	const taskRoute = transcriptRoutes.find((r) => r.path === "/tasks/:id/transcript");
	expect(taskRoute).toBeDefined();

	const projectId = insertProject();
	const taskId = insertTask(projectId);

	const url = new URL(`http://localhost/tasks/${taskId}/transcript?after_seq=xyz`);
	const ctx = {
		req: new Request(url),
		url,
		params: { id: taskId.toString() },
		handle,
		events: null,
	};

	const response = await taskRoute!.handler(ctx as any);
	expect(response.status).toBe(400);

	const body = await response.json();
	expect(body.error.code).toBe("bad_request");
});

test("task transcript route returns 400 on non-integer limit param", async () => {
	const { transcriptRoutes } = await import("./transcriptRoutes.ts");
	const taskRoute = transcriptRoutes.find((r) => r.path === "/tasks/:id/transcript");
	expect(taskRoute).toBeDefined();

	const projectId = insertProject();
	const taskId = insertTask(projectId);

	const url = new URL(`http://localhost/tasks/${taskId}/transcript?limit=1.5`);
	const ctx = {
		req: new Request(url),
		url,
		params: { id: taskId.toString() },
		handle,
		events: null,
	};

	const response = await taskRoute!.handler(ctx as any);
	expect(response.status).toBe(400);

	const body = await response.json();
	expect(body.error.code).toBe("bad_request");
});

// ---------------------------------------------------------------------------
// 9. Route happy path
// ---------------------------------------------------------------------------

test("GET /runs/:id/transcript returns merged transcript as JSON", async () => {
	const { transcriptRoutes } = await import("./transcriptRoutes.ts");
	const runRoute = transcriptRoutes.find((r) => r.path === "/runs/:id/transcript");
	expect(runRoute).toBeDefined();

	const projectId = insertProject();
	const taskId = insertTask(projectId);
	const runId = insertRun(taskId);

	insertEvent({
		runId,
		taskId,
		kind: "run.started",
		payload: { provider: "test" },
		ts: "2026-06-13T10:00:00.000Z",
	});
	insertThreadEvent({
		taskId,
		runId,
		kind: "message",
		actor: "coder",
		payload: { message: "hi" },
		ts: "2026-06-13T10:00:01.000Z",
	});

	const url = new URL(`http://localhost/runs/${runId}/transcript`);
	const ctx = {
		req: new Request(url),
		url,
		params: { id: runId.toString() },
		handle,
		events: null,
	};

	const response = await runRoute!.handler(ctx as any);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("application/json");

	const body = (await response.json()) as TranscriptEvent[];
	expect(Array.isArray(body)).toBe(true);
	expect(body).toHaveLength(2);
	expect(body[0]!.seq).toBe(1);
	expect(body[0]!.kind).toBe("run.started");
	expect(body[1]!.seq).toBe(2);
	expect(body[1]!.kind).toBe("message");
});

test("GET /tasks/:id/transcript with query params returns filtered transcript", async () => {
	const { transcriptRoutes } = await import("./transcriptRoutes.ts");
	const taskRoute = transcriptRoutes.find((r) => r.path === "/tasks/:id/transcript");
	expect(taskRoute).toBeDefined();

	const projectId = insertProject();
	const taskId = insertTask(projectId);

	// Insert 5 thread events.
	for (let i = 0; i < 5; i++) {
		insertThreadEvent({
			taskId,
			kind: "message",
			actor: "coder",
			round: i < 2 ? 0 : 1,
			payload: { n: i },
			ts: new Date(`2026-06-13T10:00:0${i}.000Z`).toISOString(),
		});
	}

	// Query with round=1, after_seq=2, limit=2.
	const url = new URL(
		`http://localhost/tasks/${taskId}/transcript?round=1&after_seq=2&limit=2`,
	);
	const ctx = {
		req: new Request(url),
		url,
		params: { id: taskId.toString() },
		handle,
		events: null,
	};

	const response = await taskRoute!.handler(ctx as any);
	expect(response.status).toBe(200);

	const body = (await response.json()) as TranscriptEvent[];
	// After round filter + afterSeq + limit, should get 2 events.
	expect(body.length).toBeGreaterThan(0);
	expect(body.length).toBeLessThanOrEqual(2);
	body.forEach((ev) => {
		// All events should be from round 1 (if filtered).
		if (ev.round !== undefined) {
			expect(ev.round).toBe(1);
		}
	});
});

test("GET /tasks/:id/transcript with no matching events returns empty array", async () => {
	const { transcriptRoutes } = await import("./transcriptRoutes.ts");
	const taskRoute = transcriptRoutes.find((r) => r.path === "/tasks/:id/transcript");
	expect(taskRoute).toBeDefined();

	const projectId = insertProject();
	const taskId = insertTask(projectId);

	// Query with round=99 (no events in that round).
	const url = new URL(`http://localhost/tasks/${taskId}/transcript?round=99`);
	const ctx = {
		req: new Request(url),
		url,
		params: { id: taskId.toString() },
		handle,
		events: null,
	};

	const response = await taskRoute!.handler(ctx as any);
	expect(response.status).toBe(200);

	const body = (await response.json()) as TranscriptEvent[];
	expect(body).toEqual([]);
});
